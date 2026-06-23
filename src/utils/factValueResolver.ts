import { resolvePath } from './logicUtils.js';
import { toKebabCase } from './stringUtils.js';
import { currentLocalDate } from './currentDate.js';

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
 *
 * Substitution is case-style-agnostic: a formula that references `orderAmount`
 * will match a fact stored as `order-amount`, `orderAmount`, or `OrderAmount`
 * (and vice versa). The planner and the runtime store facts in whichever
 * convention they prefer; the resolver bridges the two.
 */
export function resolveFormulaValue(formula: string, factValues: Record<string, any>): any {
  if (!formula || formula.trim() === '') return '';

  const trimmed = formula.trim();

  // @-prefixed ref: "@factName" or "@factName.fieldName"
  if (trimmed.startsWith('@')) {
    const resolved = resolveFactRef(trimmed.slice(1), factValues);
    return resolved !== undefined ? resolved : trimmed;
  }

  // Current-date functions (case-insensitive, exact match). TODAY() yields the
  // local calendar date (YYYY-MM-DD) in the configured timezone (MMC_TZ) — NOT
  // UTC, so a date isn't stamped a day early east of UTC. NOW() yields a full
  // ISO timestamp (an instant, unambiguous in UTC). Evaluated locally — no data
  // leaves the boundary.
  const fn = trimmed.toUpperCase().replace(/\s+/g, '');
  if (fn === 'TODAY()') return currentLocalDate();
  if (fn === 'NOW()') return new Date().toISOString();

  // Check if the formula contains any arithmetic operators
  if (!/[+\-*/]/.test(trimmed)) {
    // Plain fixed value — return as-is
    return trimmed;
  }

  try {
    // Replace word tokens that match fact names with their numeric values.
    // Try each fact key in three forms — literal, camelCase, kebab-case — so a
    // formula written in either convention resolves regardless of how the
    // runtime stored the value.
    let expr = trimmed;
    for (const [key, val] of Object.entries(factValues)) {
      const numVal = parseFloat(val);
      if (isNaN(numVal)) continue;
      const variants = new Set<string>([key, toKebabCase(key), toCamelCase(key)]);
      for (const variant of variants) {
        if (!variant) continue;
        // \b-anchors don't work cleanly around kebab tokens (hyphens are
        // word-boundary characters), so fence with start/end-or-non-identifier
        // lookarounds. Case-insensitive to absorb any remaining casing noise.
        const regex = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(variant)}(?=$|[^A-Za-z0-9_$])`, 'gi');
        expr = expr.replace(regex, (_m, pre) => `${pre}${numVal}`);
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

function toCamelCase(s: string): string {
  return s
    .replace(/[-_\s]+([a-zA-Z0-9])/g, (_m, c) => c.toUpperCase())
    .replace(/^[A-Z]/, c => c.toLowerCase());
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
