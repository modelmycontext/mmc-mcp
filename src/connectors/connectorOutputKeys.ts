import { logger } from '@src/utils/logger.js';
import { findInObject } from '@src/utils/logicUtils.js';
import { toKebabCase } from '@src/utils/stringUtils.js';

/**
 * Known primary output keys for connectors that return envelopes — used as a
 * last-resort lookup when extracting a fact value from a connector result.
 *
 * Add an entry here whenever a connector returns an envelope shape that the
 * workbench/builder doesn't directly mirror in `returnedFact.name`.
 */
export const PRIMARY_OUTPUT_KEYS: Record<string, string> = {
  'file-store': 'documentRef',
  'file-list':  'documents',
  'json-read':  'record',
  'json-write': 'record',
};

/**
 * Extract the value to store in a fact from a connector's result object.
 *
 * Lookup order (first non-undefined wins):
 *   1. `result[returnedFactName]` — exact match.
 *   2. `result[kebab(returnedFactName)]` — kebab-case match.
 *   3. Recursive deep search for `returnedFactName` (or kebab) in nested objects.
 *   4. `result[PRIMARY_OUTPUT_KEYS[toolId]]` — connector's well-known envelope key.
 *   5. Last resort: return the entire `result` object and log a warning. This
 *      is almost always a workbench-authoring bug — downstream rules that
 *      compare `returnedFactName == "X"` will silently fail because they're
 *      comparing a string to an object.
 *
 * The warning at step 5 is loud on purpose: silent fall-throughs were the
 * #1 cause of test-panel "workflow stalled with no events" debug sessions
 * before this was added.
 */
/** Information passed to a schema-mismatch callback when no key matched. */
export interface SchemaMismatchInfo {
  toolId: string;
  returnedFactName: string;
  resultKeys: string[];
}

export function extractReturnedValue(
  jobResult: any,
  returnedFactName: string,
  toolId: string,
  onSchemaMismatch?: (info: SchemaMismatchInfo) => void,
): any {
  if (jobResult === undefined || jobResult === null) return undefined;
  if (typeof jobResult !== 'object') return jobResult;

  const direct = jobResult[returnedFactName];
  if (direct !== undefined) return direct;

  const kebab = toKebabCase(returnedFactName);
  if (jobResult[kebab] !== undefined) return jobResult[kebab];

  const found = findInObject(jobResult, returnedFactName);
  if (found !== undefined) return found;

  const primaryKey = PRIMARY_OUTPUT_KEYS[toolId];
  if (primaryKey && jobResult[primaryKey] !== undefined) return jobResult[primaryKey];

  const resultKeys = Object.keys(jobResult);
  logger.warn(
    { toolId, returnedFactName, resultKeys },
    `[connectorOutputKeys] returnedFact "${returnedFactName}" not found in ${toolId} result (keys: ${resultKeys.join(', ')}). Storing whole result under "${returnedFactName}" — downstream rules against "${returnedFactName}" will compare against an object and silently fail. Fix: set the step's returnedFact.name to a key that actually appears in the tool's output.`,
  );
  onSchemaMismatch?.({ toolId, returnedFactName, resultKeys });
  return jobResult;
}
