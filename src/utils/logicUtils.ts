/**
 * Utility for resolving property paths in objects, including case-insensitive matching.
 */
export function resolvePath(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path.split('.');
  let val = obj;
  for (const part of parts) {
    if (val === undefined || val === null) return undefined;
    // Try exact match first
    let nextVal = val[part];
    if (nextVal === undefined) {
      // Try lowercase match
      nextVal = val[part.toLowerCase()];
    }
    if (nextVal === undefined) {
      // Search keys case-insensitive
      const key = Object.keys(val).find(k => k.toLowerCase() === part.toLowerCase());
      if (key) nextVal = val[key];
    }
    val = nextVal;
  }
  return val;
}

/**
 * Searches for a field in an object or any of its sub-objects (case-insensitive).
 */
export function findInObject(obj: any, target: string): any {
  if (!obj || typeof obj !== 'object' || obj === null) return undefined;

  const targetLower = target.toLowerCase();
  const targetNormalized = targetLower.replace(/\s+/g, '');

  if (obj[target] !== undefined) return obj[target];
  if (obj[targetLower] !== undefined) return obj[targetLower];
  if (obj[targetNormalized] !== undefined) return obj[targetNormalized];

  // Try matching keys that are contained by the target (e.g. "CustomerTier" vs "tier")
  // OR target is contained by the key (less likely but possible)
  const key = Object.keys(obj).find(k => {
    const kl = k.toLowerCase();
    return (kl.length > 2 && (targetLower.includes(kl) || kl.includes(targetLower))) || kl === targetLower || kl === targetNormalized;
  });
  if (key && typeof obj[key] !== 'object') {
    return obj[key];
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const res = findInObject(obj[key], target);
      if (res !== undefined) return res;
    }
  }
  return undefined;
}

/**
 * Resolves simple template placeholders in a string.
 */
export function resolveTemplate(template: string, input: any): string {
  return template.replace(/{{(.*?)}}/g, (match, path) => {
    const val = resolvePath(input, path.trim());
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Checks a condition string against an input object using common operators.
 */
export function checkCondition(cond: string, input: any, mappings?: Record<string, string>): boolean {
  const groups = cond.split(/\|\|/).map(g => g.trim());
  return groups.some(group => {
    const parts = group.split(/&&|and/i).map(s => s.trim());
    return parts.every(part => {
      // Try to match standard operators: >=, <=, !=, =, >, <
      const m = part.match(/(.*?)\s*(>=|<=|!=|=|>|<)\s*(.*)/);
      if (m) {
        const leftExpr = m[1].trim();
        const op = m[2];
        const rightExpr = m[3].trim().toLowerCase();

        // Resolve left side
        let leftVal: any;
        const mappingKey = leftExpr.toLowerCase();
        if (mappings && mappings[mappingKey]) {
          leftVal = resolvePath(input, mappings[mappingKey]);
        } else if (leftExpr.includes('.')) {
          leftVal = resolvePath(input, leftExpr);
        } else {
          // Fallback to direct input property, try case-insensitive
          // Also handle space-separated keys by trying to find a matching property
          const normalizedLeftExpr = leftExpr.toLowerCase().replace(/\s+/g, '');
          leftVal = input[leftExpr] || input[leftExpr.toLowerCase()] || input[normalizedLeftExpr];

          if (leftVal === undefined) {
             leftVal = findInObject(input, leftExpr);
          }
        }

        const right = rightExpr.replace(/['"]/g, '');

        if (right === 'null' && (op === '=' || op === '!=')) {
          const isNull = leftVal === null || leftVal === undefined;
          return op === '=' ? isNull : !isNull;
        }

        if (leftVal === undefined || leftVal === null) return false;

        const left = leftVal.toString().toLowerCase();

        if (op === '=') return left === right;
        if (op === '!=') return left !== right;

        const lNum = parseFloat(leftVal.toString());
        const rNum = parseFloat(right);
        if (isNaN(lNum) || isNaN(rNum)) return false;
        if (op === '>=') return lNum >= rNum;
        if (op === '<=') return lNum <= rNum;
        if (op === '>') return lNum > rNum;
        if (op === '<') return lNum < rNum;
      }

      // Handle "Field = Null" (old way, keeping for compatibility)
      if (part.toLowerCase().includes('= null')) {
        const field = part.split(/=/i)[0].trim();
        let val: any;
        const mappingKey = field.toLowerCase();
        if (mappings && mappings[mappingKey]) {
          val = resolvePath(input, mappings[mappingKey]);
        } else {
          val = input[field] || input[field.toLowerCase()];
          if (val === undefined) {
            const key = Object.keys(input).find(k => k.toLowerCase() === field.toLowerCase());
            if (key) val = input[key];
          }
        }
        return val === null || val === undefined;
      }

      return false;
    });
  });
}
