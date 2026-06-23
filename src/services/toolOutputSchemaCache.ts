import fs from 'fs/promises';
import path from 'path';

import { logger } from '@src/utils/logger.js';

/**
 * Persistent cache of output shapes for tools whose upstream MCP server does
 * not advertise `outputSchema` (most community servers as of MCP spec 2025-03).
 *
 * Two complementary write paths populate the cache:
 *   - **Observe-and-remember:** every successful external tool call passes its
 *     parsed response through {@link recordObservedKeys}; the top-level keys
 *     of the response become the tool's declared output properties.
 *   - **User/LLM-triggered probe:** the inline `probe-tool-output` tool invokes
 *     an external tool with caller-supplied sample args, then writes the
 *     captured shape into the cache before the user has ever built a real
 *     workflow against it (useful for write-tools that no run has exercised).
 *
 * `/connectors` reads from this cache and merges its entries into the
 * `outputParams` returned to the workbench, so the plan synthesizer sees real
 * field names instead of the generic `result` placeholder. That removes the
 * primary failure mode where the LLM fabricates plausible-but-wrong keys (e.g.
 * `messageResult` against `slack_post_message`) because nothing constrained it.
 *
 * Storage format on disk:
 * {
 *   "<prefixedToolName>": {
 *     "toolName": "...",
 *     "properties": { "<key>": { "type": "string" | "number" | ... } },
 *     "capturedAt": "<ISO>",
 *     "source": "observed" | "probed"
 *   }
 * }
 */

export interface ToolOutputSchemaEntry {
  toolName: string;
  /** Keys observed on success responses (or, until proven otherwise, on
   *  ANY response — the first call doesn't know whether it succeeded). */
  properties: Record<string, { type: string }>;
  /** Keys observed on responses that LOOKED like error envelopes (Slack-style
   *  `{ok:false, error:"…"}`, or any response carrying a non-empty `error`
   *  field). Recorded separately so the workbench validator can enforce that
   *  a write-tool's returnedFact root is present on BOTH paths — extracting a
   *  success-only field then crashes the slice when the call fails at runtime
   *  (the BurnoutProtocol Slack failure mode). Optional for back-compat with
   *  entries written before this field existed. */
  errorProperties?: Record<string, { type: string }>;
  capturedAt: string;
  source: 'observed' | 'probed';
}

const inferType = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

const sameKeySet = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const setB = new Set(kb);
  return ka.every(k => setB.has(k));
};

export class ToolOutputSchemaCache {
  private filePath: string;
  private cacheDir: string;
  private entries = new Map<string, ToolOutputSchemaEntry>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.filePath = path.join(cacheDir, 'tool-output-schemas.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, ToolOutputSchemaEntry>;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && v.properties) this.entries.set(k, v);
      }
      logger.info({ count: this.entries.size, file: this.filePath }, '[ToolOutputSchemaCache] Loaded');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn({ error: err.message }, '[ToolOutputSchemaCache] Load failed — starting empty');
      }
    }
    this.loaded = true;
  }

  get(toolName: string): ToolOutputSchemaEntry | undefined {
    return this.entries.get(toolName);
  }

  /**
   * Records the top-level keys of a tool response. Returns true when the cache
   * changed (new entry or different key set), false when the entry already
   * matched. Callers can use the return value to decide whether to log.
   *
   * `kind` decides which slot of the entry to write:
   *   - 'success' (default) → top-level `properties`
   *   - 'error'             → top-level `errorProperties`
   * The caller (externalMcpManager) classifies each response based on whether
   * it carries an obvious failure indicator (`ok:false`, non-empty `error`).
   * Recording both paths lets the workbench validator demand a returnedFact
   * root that's present in EITHER shape — the BurnoutProtocol crash mode
   * (planner picked a success-only composite field, runtime got the error
   * envelope) becomes catchable at synthesis time once one error has been
   * observed in production.
   */
  recordObservedKeys(
    toolName: string,
    response: unknown,
    source: 'observed' | 'probed' = 'observed',
    kind: 'success' | 'error' = 'success',
  ): boolean {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
    const obj = response as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;

    const next: Record<string, { type: string }> = {};
    for (const k of keys) next[k] = { type: inferType(obj[k]) };

    const existing = this.entries.get(toolName);
    const slot = kind === 'error' ? 'errorProperties' : 'properties';
    const existingForSlot = existing?.[slot] ?? null;
    if (existingForSlot && sameKeySet(existingForSlot as any, next as any)) return false;

    // Preserve the other slot's data when updating one side — observe-and-
    // remember accumulates both shapes over time as the same tool returns
    // success on one call and error on the next.
    const merged: ToolOutputSchemaEntry = {
      toolName,
      properties: existing?.properties ?? {},
      errorProperties: existing?.errorProperties,
      capturedAt: new Date().toISOString(),
      source,
    };
    merged[slot] = next;
    if (!merged.errorProperties || Object.keys(merged.errorProperties).length === 0) {
      delete merged.errorProperties;
    }
    this.entries.set(toolName, merged);
    this.scheduleWrite();
    return true;
  }

  private scheduleWrite(): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Fresh checkouts won't have the cache dir yet — the folder is
        // gitignored and only exists after the first observed call. Create
        // it on first write so the first run doesn't ENOENT.
        await fs.mkdir(this.cacheDir, { recursive: true });
        const obj: Record<string, ToolOutputSchemaEntry> = {};
        for (const [k, v] of this.entries) obj[k] = v;
        await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
      } catch (err: any) {
        logger.error({ error: err.message }, '[ToolOutputSchemaCache] Write failed');
      }
    });
  }

  isLoaded(): boolean { return this.loaded; }
}
