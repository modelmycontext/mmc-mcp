import { resolvePath } from './logicUtils.js';
import { toKebabCase } from './stringUtils.js';

/**
 * Resolves an `@factName[.fieldName]` reference against the flat fact-values map.
 * Returns `undefined` if the ref cannot be resolved; callers fall back to the
 * raw string so the unresolved ref surfaces in the event payload for debugging.
 */
export function resolveFactRef(ref: string, factValues: Record<string, any>): any {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const direct = resolvePath(factValues, trimmed);
  if (direct !== undefined && direct !== null && direct !== '') return direct;
  const parts = trimmed.split('.');
  const kebabFirst = toKebabCase(parts[0]);
  if (kebabFirst !== parts[0]) {
    const kebabPath = [kebabFirst, ...parts.slice(1)].join('.');
    const kebabVal = resolvePath(factValues, kebabPath);
    if (kebabVal !== undefined && kebabVal !== null && kebabVal !== '') return kebabVal;
  }
  return undefined;
}

/**
 * Flattens an event payload object into a flat Record of fact values.
 * Top-level scalars are coerced to strings. Top-level objects/arrays are
 * preserved as-is so downstream evaluators can drill into them via factField.
 */
export function flattenPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    if (val === null || val === undefined) {
      result[key] = '';
    } else if (typeof val === 'object') {
      result[key] = val;
    } else {
      result[key] = String(val);
    }
  }
  return result;
}

/**
 * Resolves a formula or fixed value against known fact values.
 *
 * - Plain string / number (no arithmetic operators): returned as-is
 * - Simple arithmetic expression (e.g. "orderValue * 0.2"):
 *     fact name tokens are substituted with their numeric values,
 *     then the expression is evaluated.
 * - Falls back to the raw formula string on any evaluation error.
 */
export function resolveFormulaValue(formula: string, factValues: Record<string, any>): any {
  if (!formula || formula.trim() === '') return '';

  const trimmed = formula.trim();

  // @-prefixed ref: "@factName" or "@factName.fieldName"
  if (trimmed.startsWith('@')) {
    const resolved = resolveFactRef(trimmed.slice(1), factValues);
    return resolved !== undefined ? resolved : trimmed;
  }

  // Check if the formula contains any arithmetic operators
  if (!/[+\-*/]/.test(trimmed)) {
    // Plain fixed value — return as-is
    return trimmed;
  }

  try {
    // Replace word tokens that match fact names with their numeric values
    let expr = trimmed;
    for (const [key, val] of Object.entries(factValues)) {
      const numVal = parseFloat(val);
      if (!isNaN(numVal)) {
        // Replace whole-word occurrences of the key (case-insensitive)
        const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, 'gi');
        expr = expr.replace(regex, String(numVal));
      }
    }

    // Strip currency symbols and other non-numeric characters that might remain
    expr = expr.replace(/[$€£¥]/g, '');

    // Only allow safe arithmetic characters before evaluating
    if (!/^[\d\s+\-*/().]+$/.test(expr)) {
      return trimmed; // Unsafe expression — return original
    }

    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr})`)();
    if (typeof result === 'number' && !isNaN(result)) {
      return String(result);
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
