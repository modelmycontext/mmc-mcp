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

  async connectAll(): Promise<void> {
    if (process.env.MMC_SKIP_EXTERNAL) {
      logger.info('[ExternalMcpManager] Skipping external MCP connections via MMC_SKIP_EXTERNAL env.');
      return;
    }
    for (const config of this.configs) {
      try {
        const env = { ...process.env, ...config.env };
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
            const varName = value.slice(2, -2);
            env[key] = process.env[varName] || process.env[`VITE_${varName}`] || value;
          }
        }

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: env as Record<string, string>
        });

        const client = new Client({
          name: `client-for-${config.name}`,
          version: "1.0.0"
        }, {
          capabilities: {}
        });

        await client.connect(transport);
        this.clients.set(config.name, client);
      } catch (error: any) {
        logger.error({ name: config.name, error: error.message }, `[ExternalMcpManager] Failed to connect to ${config.name}: ${error.message}`);
      }
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
                  if (this.schemaCache) {
                    const changed = this.schemaCache.recordObservedKeys(prefixedName, parsed, 'observed');
                    if (changed) {
                      logger.info(
                        { tool: prefixedName, keys: Object.keys(parsed as Record<string, unknown>) },
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
