import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { logger, timed } from '@src/utils/logger.js';
import { ToolOutputSchemaCache } from '@src/services/toolOutputSchemaCache.js';

export interface ExternalMcpConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  exposeToClient?: boolean;
}

/** True when running under the Bun runtime (production). Dev and tests run under
 *  Node (tsx), where `typeof Bun` is 'undefined'. Mirrors the bun-sqlite shim's
 *  runtime split (src/shims/bun-sqlite.ts). */
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/**
 * Resolve an external-server spawn command for the CURRENT runtime. Bun is a
 * production-only dependency: the deployed Fly image runs under Bun, where
 * `bun x <pkg>` is the package runner. Dev and tests run under Node, where Bun
 * must never be spawned — it leaks Windows ghost processes (see the de-bun
 * migration, mmc-mcp #86). There the equivalent is `npx <pkg>`; cross-spawn
 * (used by the MCP stdio transport) resolves `npx` → `npx.cmd` on Windows.
 *
 * Only the `bun x …` package-runner form is rewritten; explicit commands
 * (e.g. `node …`) pass through unchanged. `isBun` is injectable for testing.
 */
export function resolveRuntimeCommand(
  command: string,
  args: string[],
  isBun: boolean = IS_BUN,
): { command: string; args: string[] } {
  if (command === 'bun' && !isBun && args[0] === 'x') {
    return { command: 'npx', args: args.slice(1) };
  }
  return { command, args };
}

export interface ExternalToolDefinition {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
}

export class ExternalMcpManager {
  private clients: Map<string, Client> = new Map();
  private configs: ExternalMcpConfig[];
  private exposedToolDefs: ExternalToolDefinition[] = [];
  private schemaCache?: ToolOutputSchemaCache;

  constructor(configs: ExternalMcpConfig[] = []) {
    this.configs = configs;
  }

  setSchemaCache(cache: ToolOutputSchemaCache): void {
    this.schemaCache = cache;
  }

  private async connectOne(config: ExternalMcpConfig): Promise<void> {
    const env = { ...process.env, ...config.env };
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const varName = value.slice(2, -2);
        env[key] = process.env[varName] || process.env[`VITE_${varName}`] || value;
      }
    }
    // Bun is production-only: under Node (dev/tests) `bun x …` becomes `npx …`.
    const { command, args } = resolveRuntimeCommand(config.command, config.args || []);
    if (command !== config.command) {
      logger.info({ name: config.name, from: config.command, to: command }, '[ExternalMcpManager] Running under Node — using npx instead of bun for external server');
    }
    const transport = new StdioClientTransport({
      command,
      args,
      env: env as Record<string, string>
    });
    const client = new Client({
      name: `client-for-${config.name}`,
      version: "1.0.0"
    }, { capabilities: {} });
    await client.connect(transport);
    this.clients.set(config.name, client);
  }

  async connectAll(): Promise<void> {
    if (process.env.MMC_SKIP_EXTERNAL) {
      logger.info('[ExternalMcpManager] Skipping external MCP connections via MMC_SKIP_EXTERNAL env.');
      return;
    }
    for (const config of this.configs) {
      try {
        await this.connectOne(config);
      } catch (error: any) {
        logger.error({ name: config.name, error: error.message }, `[ExternalMcpManager] Failed to connect to ${config.name}: ${error.message}`);
      }
    }
  }

  async disconnectOne(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
      this.clients.delete(serverName);
    }
  }

  updateConfigs(newConfigs: ExternalMcpConfig[]): void {
    this.configs = newConfigs;
  }

  async reinitialize(serverName?: string): Promise<void> {
    if (serverName) {
      await this.disconnectOne(serverName);
      const config = this.configs.find(c => c.name === serverName);
      if (config) {
        try {
          await this.connectOne(config);
          logger.info({ server: serverName }, `[ExternalMcpManager] Reinitialized ${serverName}`);
        } catch (error: any) {
          logger.error({ name: serverName, error: error.message }, `[ExternalMcpManager] Failed to reinitialize ${serverName}: ${error.message}`);
        }
      }
    } else {
      await this.disconnectAll();
      await this.connectAll();
    }
  }

  async getExternalTools(): Promise<Record<string, (params: any, input: any) => Promise<any>>> {
    const tools: Record<string, (params: any, input: any) => Promise<any>> = {};
    this.exposedToolDefs = [];

    for (const [name, client] of this.clients.entries()) {
      try {
        const response = await client.request({ method: "tools/list" }, ListToolsResultSchema);
        const cfg = this.configs.find(c => c.name === name);
        const exposed = !!cfg?.exposeToClient;

        for (const tool of response.tools) {
          const prefixedName = `${name}_${tool.name}`;
          if (exposed) {
            this.exposedToolDefs.push({
              name: prefixedName,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
              outputSchema: (tool as any).outputSchema,
            });
          }
          tools[prefixedName] = async (params: any, input: any) => {
            const result = await timed(
              'externalMcp.callTool',
              () => client.callTool({ name: tool.name, arguments: params }),
              { server: name, tool: tool.name },
            );

            // Assume the result has content with text/json and merge it into input
            const content = result.content as any[];
            if (content && content.length > 0) {
              const textContent = content.find(c => c.type === 'text');
              if (textContent && 'text' in textContent) {
                try {
                  const parsed = JSON.parse(textContent.text);
                  // Observe-and-remember: feed the parsed response shape into the
                  // tool-output-schema cache so subsequent plan synthesis sees the
                  // real top-level keys (vs. the generic `result` placeholder).
                  //
                  // Error-envelope detection: write tools (Slack/GitHub/REST
                  // wrappers) return a DIFFERENT shape on error than on success
                  // — typically `{ok:false, error:"…"}` vs the success
                  // composite. We classify each call and record into separate
                  // slots so the workbench validator can later require a
                  // returnedFact root that exists in BOTH paths. Heuristic is
                  // intentionally narrow (covers MCP convention): explicit
                  // `ok===false` OR a non-empty string `error` field with no
                  // matching success envelope. False negatives just delay the
                  // catch by one more call.
                  if (this.schemaCache) {
                    const obj = parsed as Record<string, unknown>;
                    const looksLikeError =
                      obj.ok === false ||
                      (typeof obj.error === 'string' && obj.error.length > 0);
                    const kind = looksLikeError ? 'error' : 'success';
                    const changed = this.schemaCache.recordObservedKeys(prefixedName, parsed, 'observed', kind);
                    if (changed) {
                      logger.info(
                        { tool: prefixedName, kind, keys: Object.keys(obj) },
                        '[ToolOutputSchemaCache] Captured output schema from observed call',
                      );
                    }
                  }
                  return { ...input, ...parsed };
                } catch (e) {
                  // If not JSON, just put it in a field named after the tool
                  const toolResultKey = tool.name.replace(/[:]/g, '_') + 'Result';
                  return { ...input, [toolResultKey]: textContent.text };
                }
              }
            }
            return input;
          };
        }
      } catch (error: any) {
        logger.error({ name, error: error.message }, `[ExternalMcpManager] Failed to list tools for ${name}: ${error.message}`);
      }
    }

    return tools;
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch (error: any) {
        logger.error({ error: error.message }, `[ExternalMcpManager] Error closing client: ${error.message}`);
      }
    }
  }

  getClient(name: string): Client | undefined {
    return this.clients.get(name);
  }

  getExposedToolDefinitions(): ExternalToolDefinition[] {
    return this.exposedToolDefs;
  }

  getConnectionStatus(): { configured: number; connected: number; servers: { name: string; connected: boolean }[] } {
    const servers = this.configs.map(cfg => ({
      name: cfg.name,
      connected: this.clients.has(cfg.name),
    }));
    return {
      configured: this.configs.length,
      connected: servers.filter(s => s.connected).length,
      servers,
    };
  }
}
