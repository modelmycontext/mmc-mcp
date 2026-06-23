/**
 * Kebab-cases a string. CamelCase, PascalCase, spaces, and underscores all
 * collapse into hyphen-separated lowercase tokens.
 *
 * Examples:
 *   toKebabCase('CustomerTier')   === 'customer-tier'
 *   toKebabCase('order amount')   === 'order-amount'
 *   toKebabCase('user_id')        === 'user-id'
 *   toKebabCase('discount-percent') === 'discount-percent'
 */
export function toKebabCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}
