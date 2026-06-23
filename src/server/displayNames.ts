// Display-name translation for event payloads (#77 Increment B).
//
// Event payloads are keyed by factId on the wire and in events.db (the canonical
// rename-safe form). Clients (the workbench test panel, mmc-workflow) render
// those keys, so without translation a user sees `fact-cd-decision` (humanised
// to "FACT CD DECISION") instead of "decision". This module translates a
// payload's factId keys back to fact NAMES at the client-facing read/delivery
// boundaries ONLY (get-next-event, get-session-events, events-dump) — on a copy.
// The stored/bus payload stays factId-keyed so the deterministic engines are
// unaffected.
import type { Event } from '@src/events/eventBus.js';
import type { WorkflowDefinition } from '@src/skill-engine/interaction-slice-trigger-events.js';
import { getRun } from './workflowRun.js';

/**
 * Build a factId → factName map for display, scoped to an event's context.
 *
 * Sources, unioned (factIds are globally unique strings, so a union is safe):
 *  - session-scoped: the per-session event-schema index (test-panel skills).
 *  - disk: the workflow whose name prefixes `source` (`workflow/slice`), or all
 *    loaded workflows when the source carries no prefix.
 */
export function buildDisplayNameMap(
  correlationId: string | undefined,
  source: string | undefined,
  workflowDefs: Map<string, WorkflowDefinition> | null,
): Map<string, string> {
  const map = new Map<string, string>();
  if (correlationId) {
    const idx = getRun(correlationId)?.eventSchemaIndex;
    if (idx) for (const entries of idx.values()) for (const e of entries) map.set(e.id, e.name);
  }
  if (workflowDefs) {
    const wfName = source && source.includes('/') ? source.split('/')[0] : undefined;
    const wfs = wfName && workflowDefs.has(wfName) ? [workflowDefs.get(wfName)!] : [...workflowDefs.values()];
    for (const wf of wfs) for (const s of wf.slices) for (const [id, name] of s.factIdToName) map.set(id, name);
  }
  return map;
}

/**
 * Return a shallow copy of `event` with its payload's factId keys renamed to
 * fact names per `map`. Unknown keys (and `_`-prefixed / non-fact keys like
 * router `originalEvent`) pass through unchanged. Returns the original event
 * object when nothing changed, to avoid needless allocation.
 */
export function withDisplayNames(event: Event, map: Map<string, string>): Event {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return event;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const name = map.get(k);
    if (name && name !== k) { out[name] = v; changed = true; } else { out[k] = v; }
  }
  return changed ? { ...event, payload: out } : event;
}

/** Convenience: build the map for this event and translate it in one call. */
export function eventForDisplay(
  event: Event,
  workflowDefs: Map<string, WorkflowDefinition> | null,
): Event {
  return withDisplayNames(event, buildDisplayNameMap(event.correlationId, event.source, workflowDefs));
}
