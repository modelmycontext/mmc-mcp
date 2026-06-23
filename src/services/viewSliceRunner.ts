import { logger } from '@src/utils/logger.js';
import { LlmService } from '@src/services/llm.js';
import {
  extractSliceQueries,
  getSlicePattern,
} from '@src/skill-engine/interaction-slice-trigger-events.js';
import { resolveJobParams } from '@src/services/sliceEvaluator.js';
import type { Slice } from '@src/types/outcomeModel.js';
import { applyJobResultToFacts } from '@src/services/automatedSliceRunner.js';

/**
 * View pattern executor — invoked synchronously when the agent calls a
 * View slice as an MCP tool. Unlike the Automation runner this is NOT
 * event-driven: there are no scenarios, no Command, no Outcome emission.
 *
 * Execution:
 *   1. Seed the fact pool from the caller's `args`.
 *   2. Run every Query (job-backed or text/LLM) so each contributes facts.
 *   3. Project the resulting facts down to the slice's contract and return.
 *
 * Failures from individual Queries are recorded but do NOT abort the View
 * — Views are read-only and a partial projection is more useful than no
 * projection. The errors are returned alongside the projection so callers
 * can surface them.
 */
export interface ViewExecutorDeps {
  executeConnector: (
    toolId: string,
    params: Record<string, any>,
    sessionId?: string,
  ) => Promise<Record<string, any>>;
  llmService?: LlmService;
}

export interface ViewExecutionResult {
  projection: Record<string, any>;
  errors: Array<{ tool: string; name: string; error: string }>;
}

export async function executeViewSlice(
  slice: Slice,
  factIdToName: Map<string, string>,
  args: Record<string, any>,
  deps: ViewExecutorDeps,
  sessionId?: string,
): Promise<ViewExecutionResult> {
  const pattern = getSlicePattern(slice);
  if (pattern !== 'view') {
    throw new Error(`executeViewSlice called on non-View slice (pattern=${pattern}, name=${slice.name})`);
  }

  const sliceName: string = slice.name ?? '(unnamed-view)';
  const allFactValues: Record<string, any> = { ...args };
  // Caller-supplied keys are inputs, not output facts. Projecting them back
  // would echo the agent's own arguments instead of the queried data.
  const inputKeys = new Set(Object.keys(args));
  const errors: ViewExecutionResult['errors'] = [];
  const recordError = (e: { tool: string; name: string; error: string }) => errors.push(e);
  const recordToolError = (e: { tool: string; phase: string; name: string; error: string }) => {
    recordError({ tool: e.tool, name: e.name, error: e.error });
  };

  const inScopeFactNames = [...new Set(factIdToName.values())];

  const queries = extractSliceQueries(slice, factIdToName);
  for (const query of queries) {
    if (query.job) {
      try {
        const params = resolveJobParams(query.job, factIdToName, allFactValues);
        const jobResult = await deps.executeConnector(query.job.toolId, params, sessionId);
        applyJobResultToFacts(jobResult, query.job, allFactValues, recordToolError, 'query', sliceName);
      } catch (err: any) {
        recordError({ tool: query.job.toolId, name: query.job.name, error: err.message });
        logger.warn(
          { sliceName, query: query.name, error: err.message },
          '[ViewSlice] Query job failed — continuing with partial projection',
        );
      }
    } else if (query.text && deps.llmService) {
      try {
        const returnedFactName = query.factNames[0] ?? query.name;
        const result = await deps.llmService.evaluateInstruction(
          query.text,
          allFactValues,
          returnedFactName,
          inScopeFactNames,
        );
        for (const [k, v] of Object.entries(result)) {
          if (k.startsWith('_')) continue;
          if (v !== undefined && v !== null) allFactValues[k] = v;
        }
      } catch (err: any) {
        recordError({ tool: 'ai.eval', name: query.name, error: err.message });
        logger.warn(
          { sliceName, query: query.name, error: err.message },
          '[ViewSlice] Text-instruction query failed — continuing with partial projection',
        );
      }
    }
  }

  // Project to the slice's contract — facts the slice owns and that were
  // produced by Queries. Caller-supplied input keys are excluded so the
  // agent receives the queried data, not an echo of its own arguments.
  const projection: Record<string, any> = {};
  for (const factName of inScopeFactNames) {
    if (inputKeys.has(factName)) continue;
    if (allFactValues[factName] !== undefined) {
      projection[factName] = allFactValues[factName];
    }
  }

  logger.info(
    { sliceName, projectionKeys: Object.keys(projection), errorCount: errors.length },
    '[ViewSlice] View executed',
  );

  return { projection, errors };
}
