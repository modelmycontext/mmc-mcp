import { describe, it, expect } from 'vitest';
import { resolveTemplate, checkCondition, resolvePath, findInObject } from '../../src/utils/logicUtils.js';

describe('resolveTemplate', () => {
  it('returns the template unchanged when no placeholders present', () => {
    expect(resolveTemplate('Hello World', {})).toBe('Hello World');
  });

  it('substitutes a single {{variable}} placeholder', () => {
    expect(resolveTemplate('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
  });

  it('substitutes multiple different placeholders in one string', () => {
    expect(resolveTemplate('{{a}} + {{b}}', { a: '1', b: '2' })).toBe('1 + 2');
  });

  it('substitutes nested dot-path placeholder', () => {
    expect(resolveTemplate('{{user.name}}', { user: { name: 'Bob' } })).toBe('Bob');
  });

  it('replaces missing placeholder with empty string', () => {
    expect(resolveTemplate('{{missing}}', {})).toBe('');
  });

  it('coerces number values to string', () => {
    expect(resolveTemplate('{{count}}', { count: 42 })).toBe('42');
  });

  it('handles null value by replacing with empty string', () => {
    expect(resolveTemplate('{{x}}', { x: null })).toBe('');
  });
});

describe('checkCondition', () => {
  describe('equality operator (=)', () => {
    it('returns true when string values match case-insensitively', () => {
      expect(checkCondition('status = active', { status: 'Active' })).toBe(true);
    });

    it('returns false when values do not match', () => {
      expect(checkCondition('status = active', { status: 'inactive' })).toBe(false);
    });

    it('returns true when comparing to null and value is undefined', () => {
      expect(checkCondition('field = null', {})).toBe(true);
    });

    it('returns false when comparing to null but value exists', () => {
      expect(checkCondition('field = null', { field: 'x' })).toBe(false);
    });
  });

  describe('inequality operator (!=)', () => {
    it('returns true when values differ', () => {
      expect(checkCondition('status != inactive', { status: 'active' })).toBe(true);
    });

    it('returns false when values are equal', () => {
      expect(checkCondition('status != active', { status: 'active' })).toBe(false);
    });

    it('returns false when value is undefined', () => {
      expect(checkCondition('field != something', {})).toBe(false);
    });
  });

  describe('numeric comparison operators', () => {
    it('evaluates >= correctly for number above threshold', () => {
      expect(checkCondition('score >= 90', { score: 95 })).toBe(true);
    });

    it('evaluates >= correctly for number equal to threshold', () => {
      expect(checkCondition('score >= 90', { score: 90 })).toBe(true);
    });

    it('evaluates >= correctly for number below threshold', () => {
      expect(checkCondition('score >= 90', { score: 85 })).toBe(false);
    });

    it('evaluates <= correctly', () => {
      expect(checkCondition('score <= 50', { score: 50 })).toBe(true);
      expect(checkCondition('score <= 50', { score: 51 })).toBe(false);
    });

    it('evaluates > correctly', () => {
      expect(checkCondition('score > 90', { score: 91 })).toBe(true);
      expect(checkCondition('score > 90', { score: 90 })).toBe(false);
    });

    it('evaluates < correctly', () => {
      expect(checkCondition('score < 10', { score: 9 })).toBe(true);
      expect(checkCondition('score < 10', { score: 10 })).toBe(false);
    });

    it('returns false when operands are non-numeric', () => {
      expect(checkCondition('price > foo', { price: 'abc' })).toBe(false);
    });
  });

  describe('&& (AND) combining', () => {
    it('requires both conditions to be true', () => {
      expect(checkCondition('a = x && b = y', { a: 'x', b: 'y' })).toBe(true);
      expect(checkCondition('a = x && b = y', { a: 'x', b: 'z' })).toBe(false);
    });
  });

  describe('|| (OR) combining', () => {
    it('passes when either condition is true', () => {
      expect(checkCondition('a = x || b = y', { a: 'x', b: 'z' })).toBe(true);
      expect(checkCondition('a = x || b = y', { a: 'z', b: 'z' })).toBe(false);
    });
  });

  describe('mappings parameter', () => {
    it('resolves left side using provided mapping path', () => {
      expect(checkCondition('tier = gold', { user: { tier: 'gold' } }, { tier: 'user.tier' })).toBe(true);
    });
  });

  describe('dot-path left-side resolution', () => {
    it('resolves dotted path on left side of condition', () => {
      expect(checkCondition('user.tier = gold', { user: { tier: 'gold' } })).toBe(true);
    });
  });
});

describe('resolvePath', () => {
  it('returns the entire object for an empty path', () => {
    const obj = { a: 1 };
    expect(resolvePath(obj, '')).toEqual(obj);
  });

  it('returns top-level property by exact name', () => {
    expect(resolvePath({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('returns top-level property case-insensitively', () => {
    expect(resolvePath({ Name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('traverses a two-level dot path', () => {
    expect(resolvePath({ user: { tier: 'gold' } }, 'user.tier')).toBe('gold');
  });

  it('returns undefined for a path that does not exist', () => {
    expect(resolvePath({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined when intermediate node is null', () => {
    expect(resolvePath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('findInObject', () => {
  it('finds a top-level key by exact name', () => {
    expect(findInObject({ tier: 'gold' }, 'tier')).toBe('gold');
  });

  it('finds a top-level key case-insensitively', () => {
    expect(findInObject({ Tier: 'gold' }, 'tier')).toBe('gold');
  });

  it('finds a key in a nested object recursively', () => {
    expect(findInObject({ user: { tier: 'gold' } }, 'tier')).toBe('gold');
  });

  it('returns undefined when key is absent everywhere', () => {
    expect(findInObject({ a: 'x', b: { c: 'y' } }, 'missing')).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(findInObject(null, 'key')).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(findInObject('string', 'key')).toBeUndefined();
  });
});
