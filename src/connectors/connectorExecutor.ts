import { resolveTemplate, checkCondition } from '@src/utils/logicUtils.js';
import { connectors } from '@connectors/index.js';
import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';

// Re-export so existing call sites (and external consumers) keep their
// `import { ConnectorContext } from '...connectorExecutor.js'` paths working.
export type { ConnectorContext } from '@sdk/connectorTypes.js';

/**
 * Short random ID used for `TOOL_CALLED` event IDs. Not collision-resistant
 * across the universe — collisions inside a single session would require ~6
 * tools fired in the same millisecond — but cheap and good enough for the
 * EventBus's internal sequence numbering, which is what really uniquely
 * orders events.
 */
function generateToolCalledEventId(): string {
  return Math.random().toString(36).substring(7);
}

export interface SkillStep {
  id: string;
  name: string;
  action: string;
  params?: Record<string, unknown>;
  inputs?: string[];
  inputDetails?: Array<{ name: string; type: string; description?: string }>;
  execute: (context: ConnectorContext, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface Skill {
  id: string;
  name: string;
  description?: string;
  isSystem?: boolean;
  inputs?: string[];
  inputDetails?: Array<{ name: string; type: string; description?: string }>;
  steps: SkillStep[];
}

export class ConnectorExecutor {
  private connectors: Connector[];

  constructor(connectorList: Connector[] = connectors) {
    this.connectors = connectorList;
  }

  resolveTemplate(template: string, input: any): string {
    return resolveTemplate(template, input);
  }

  createExecutor(action: string, params: any, isSystemStep: boolean = false) {
    return async (ctx: ConnectorContext, input: any) => {
      // Handle tool naming migration from : to __ for MCP compliance
      const normalizedAction = action.replace(/:/g, '__');
      let tool = ctx.tools[normalizedAction] || ctx.tools[action];

      // Check for an executable connector matching this action.
      const connector = this.connectors.find(c => c.name === action || c.name.replace(/:/g, '__') === normalizedAction);

      // Prepare inputs based on mappings if present
      let effectiveInput = { ...input };
      if (params.mappings) {
        for (const [targetKey, sourceTemplate] of Object.entries(params.mappings)) {
          const resolvedValue = this.resolveTemplate(sourceTemplate as string, input);
          effectiveInput[targetKey] = resolvedValue;
          // Try to convert to number if it looks like one and not an empty string
          if (typeof resolvedValue === 'string' && resolvedValue.trim() !== '' && /^-?\d+(\.\d+)?$/.test(resolvedValue)) {
            effectiveInput[targetKey] = parseFloat(resolvedValue);
          }
        }
      }

      if (!tool) {
        if (connector) {
          tool = async (p, i) => {
            return connector.execute(ctx, p, i);
          };
        } else if (action === 'json:read') {
          tool = async (p, i) => {
            const result = await ctx.tools['json__read'](p, i);
            return result;
          };
        } else if (action === 'transform:template') {
          tool = async (p, i) => ({ ...i, message: p.template });
        } else if (action === 'transform:logic') {
          tool = async (p, i) => {
            if (isSystemStep) {
               return i;
            }
            // `p` is `Record<string, unknown>` so destructured fields need
            // explicit narrowing before they reach the typed helpers.
            const { scenarios, template, mappings } = p as {
              scenarios?: Array<{ condition: string; result?: Record<string, unknown> }>;
              template?: string;
              mappings?: Record<string, string>;
            };
            if (!scenarios || !Array.isArray(scenarios)) return i;

            for (const scenario of scenarios) {
              if (checkCondition(scenario.condition, i, mappings)) {
                const resolvedResult: any = {};
                if (scenario.result) {
                  for (const [resKey, resValue] of Object.entries(scenario.result)) {
                    if (typeof resValue === 'string') {
                      resolvedResult[resKey] = this.resolveTemplate(resValue, i);
                    } else {
                      resolvedResult[resKey] = resValue;
                    }
                  }
                }

                const result = { ...i, ...resolvedResult };
                if (typeof template === 'string' && template) {
                  result.message = this.resolveTemplate(template, result);
                }
                return result;
              }
            }
            return i;
          };
        }
      }

      if (!tool) {
        throw new Error(`Tool not found: ${action}`);
      }

      // Resolve templates in params
      const resolvedParams: any = {};
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') {
          resolvedParams[key] = this.resolveTemplate(value, input);
        } else {
          resolvedParams[key] = value;
        }
      }

      // Pre-apply mappings to input if present
      let currentInput = { ...input };
      if (params.mappings) {
        for (const [resKey, mappingPath] of Object.entries(params.mappings)) {
          const mPath = mappingPath as string;
          const val = this.resolveTemplate(`{{${mPath}}}`, input);
          if (val !== `{{${mPath}}}`) {
            currentInput[resKey] = val;
          }
        }
      }

      const result = await tool(resolvedParams, currentInput);

      let finalResult = { ...input, ...result };

      // If resultKey/returns is set, ensure the result object is also at that key for resolveTemplate
      if (params.returns) {
        finalResult[params.returns] = result;
      }
      if (params.resultKey) {
        finalResult[params.resultKey] = result;
      }

      // Post-apply mappings from result if present
      if (params.mappings) {
        for (const [resKey, mappingPath] of Object.entries(params.mappings)) {
          const mPath = mappingPath as string;
          // Support {{user.tier}} in mPath
          const val = this.resolveTemplate(mPath.includes('{{') ? mPath : `{{${mPath}}}`, finalResult);

          if (val !== (mPath.includes('{{') ? mPath : `{{${mPath}}}`)) {
            // Support deep assignment for resKey (e.g. "user.tier")
            if (resKey.includes('.')) {
              const parts = resKey.split('.');
              let curr = finalResult;
              for (let j = 0; j < parts.length - 1; j++) {
                curr[parts[j]] = curr[parts[j]] || {};
                curr = curr[parts[j]];
              }
              curr[parts[parts.length - 1]] = val;
            } else {
              finalResult[resKey] = val;
            }
          }
        }
      }
      if (params.template) {
        const message = this.resolveTemplate(params.template, finalResult);
        finalResult = { ...finalResult, message };
      }

      if (!isSystemStep) {
        await ctx.eventBus.publish({
          id: generateToolCalledEventId(),
          type: 'TOOL_CALLED',
          source: `tool:${action}`,
          payload: { tool: action, params: resolvedParams, input, result: finalResult },
          timestamp: new Date(),
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        });
      }

      return finalResult;
    };
  }
}
