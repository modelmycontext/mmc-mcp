import { describe, it, expect } from 'vitest';
import { flattenPayload, resolveFormulaValue } from '../../src/utils/factValueResolver.js';

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
  });
});
