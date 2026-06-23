import { describe, it, expect } from 'vitest';
import { flattenPayload, resolveFormulaValue } from '../../src/utils/factValueResolver.js';
import { currentLocalDate } from '../../src/utils/currentDate.js';

describe('flattenPayload', () => {
  it('returns empty object for null input', () => {
    expect(flattenPayload(null)).toEqual({});
  });

  it('returns empty object for non-object input (string)', () => {
    expect(flattenPayload('string')).toEqual({});
  });

  it('returns empty object for number input', () => {
    expect(flattenPayload(42)).toEqual({});
  });

  it('includes top-level string value', () => {
    expect(flattenPayload({ name: 'Alice' })).toEqual({ name: 'Alice' });
  });

  it('includes top-level number coerced to string', () => {
    expect(flattenPayload({ score: 95 })).toEqual({ score: '95' });
  });

  it('includes top-level boolean coerced to string', () => {
    expect(flattenPayload({ active: true })).toEqual({ active: 'true' });
  });

  it('preserves nested object values so factField lookups can drill in', () => {
    expect(flattenPayload({ name: 'Alice', address: { city: 'London' } }))
      .toEqual({ name: 'Alice', address: { city: 'London' } });
  });

  it('includes key with null value as empty string', () => {
    expect(flattenPayload({ field: null })).toEqual({ field: '' });
  });

  it('includes key with undefined value as empty string', () => {
    expect(flattenPayload({ field: undefined })).toEqual({ field: '' });
  });

  it('handles multiple keys correctly', () => {
    const result = flattenPayload({ a: '1', b: 2, c: false });
    expect(result).toEqual({ a: '1', b: '2', c: 'false' });
  });
});

describe('resolveFormulaValue', () => {
  it('returns empty string for null/empty formula', () => {
    expect(resolveFormulaValue('', {})).toBe('');
    expect(resolveFormulaValue('   ', {})).toBe('');
  });

  it('returns fixed string as-is when no operators present', () => {
    expect(resolveFormulaValue('gold', {})).toBe('gold');
  });

  it('returns numeric string as-is when no operators present', () => {
    expect(resolveFormulaValue('100', {})).toBe('100');
  });

  describe('arithmetic expressions', () => {
    it('evaluates simple multiplication formula with fact substitution', () => {
      expect(resolveFormulaValue('orderValue * 0.2', { orderValue: '500' })).toBe('100');
    });

    it('evaluates addition', () => {
      expect(resolveFormulaValue('a + b', { a: '10', b: '5' })).toBe('15');
    });

    it('evaluates subtraction', () => {
      expect(resolveFormulaValue('a - b', { a: '10', b: '3' })).toBe('7');
    });

    it('evaluates division', () => {
      expect(resolveFormulaValue('a / b', { a: '10', b: '2' })).toBe('5');
    });

    it('evaluates parenthesised expressions', () => {
      expect(resolveFormulaValue('(a + b) * c', { a: '2', b: '3', c: '4' })).toBe('20');
    });

    it('strips currency symbols before evaluating', () => {
      expect(resolveFormulaValue('$100 * 2', {})).toBe('200');
    });

    it('returns original formula when expression contains unsafe characters after substitution', () => {
      const result = resolveFormulaValue('x; y', {});
      // No arithmetic operators, so returned as-is
      expect(result).toBe('x; y');
    });

    it('returns original formula when fact value is non-numeric', () => {
      const result = resolveFormulaValue('tier * 2', { tier: 'gold' });
      // After substitution 'tier' stays if 'gold' is NaN, expression has non-safe chars
      expect(result).toBe('tier * 2');
    });

    it('handles case-insensitive fact name matching in formula', () => {
      const result = resolveFormulaValue('OrderValue * 0.1', { orderValue: '200' });
      expect(result).toBe('20');
    });

    it('resolves a camelCase formula token against a kebab-case fact key', () => {
      // The materialiser stores facts in kebab-case ("order-amount") but the
      // planner emits formulas in camelCase ("orderAmount * 20 / 100"). The
      // resolver bridges the casing without the caller having to normalise.
      const result = resolveFormulaValue('orderAmount * 20 / 100', { 'order-amount': '100' });
      expect(result).toBe('20');
    });

    it('resolves a kebab-case formula token against a camelCase fact key', () => {
      const result = resolveFormulaValue('order-amount * 20 / 100', { orderAmount: '100' });
      expect(result).toBe('20');
    });

    it('evaluates the tiered-discount canonical formula end-to-end', () => {
      // Mirrors the discount-calc passthrough's published outcome: the slice
      // stores orderAmount under the kebab key (from the trigger event's
      // scope-stripped fact name) and the outcome's calculatedValue uses the
      // camelCase form. Both branches must compute correctly.
      expect(
        resolveFormulaValue('orderAmount - (orderAmount * 20 / 100)', { 'order-amount': '100' }),
      ).toBe('80');
    });
  });

  describe('current-date functions', () => {
    it('resolves TODAY() to the local calendar date (YYYY-MM-DD)', () => {
      const v = resolveFormulaValue('TODAY()', {});
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v).toBe(
        new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      );
    });

    it('is case-insensitive and tolerates whitespace', () => {
      expect(resolveFormulaValue('today()', {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(resolveFormulaValue('  TODAY( )  ', {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('resolves NOW() to an ISO timestamp', () => {
      const v = resolveFormulaValue('NOW()', {});
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isNaN(Date.parse(v))).toBe(false);
    });

    it('leaves a plain string that merely contains "today" untouched', () => {
      expect(resolveFormulaValue('today is sunny', {})).toBe('today is sunny');
    });
  });
});

describe('currentLocalDate', () => {
  it('formats as YYYY-MM-DD in the given timezone, not UTC', () => {
    // 2026-06-18 13:00 UTC is already 2026-06-19 01:00 in NZ.
    const instant = new Date('2026-06-18T13:00:00Z');
    expect(currentLocalDate(instant, 'UTC')).toBe('2026-06-18');
    expect(currentLocalDate(instant, 'Pacific/Auckland')).toBe('2026-06-19');
  });
});
