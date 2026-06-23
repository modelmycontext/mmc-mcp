import { describe, it, expect } from 'vitest';
import { parseJobInputs, parseKeyValueBlock, extractField } from '@sdk/parsing.js';

describe('parseJobInputs', () => {
  describe('Job Static Inputs section', () => {
    it('parses collection from static inputs', () => {
      const section = 'Job Static Inputs:\n- collection: users\n';
      const result = parseJobInputs(section);
      expect(result.collection).toBe('users');
    });

    it('parses simple returns value', () => {
      const section = 'Job Static Inputs:\n- returns: user\n';
      const result = parseJobInputs(section);
      expect(result.returns).toBe('user');
    });

    it('parses returns with colon syntax into returns + mappings', () => {
      const section = 'Job Static Inputs:\n- returns: CustomerTier: {{user.tier}}\n';
      const result = parseJobInputs(section);
      expect(result.returns).toBe('CustomerTier');
      expect(result.mappings).toBeDefined();
      expect(result.mappings['CustomerTier']).toBe('{{user.tier}}');
    });

    it('parses arbitrary static key-value pairs', () => {
      const section = 'Job Static Inputs:\n- myKey: myValue\n';
      const result = parseJobInputs(section);
      expect(result.myKey).toBe('myValue');
    });
  });

  describe('Job Input Mappings section', () => {
    it('parses find ← Source into params.find as {{Source}}', () => {
      const section = 'Job Input Mappings:\n- find ← CustomerId\n';
      const result = parseJobInputs(section);
      expect(result.find).toBe('{{CustomerId}}');
    });

    it('does not double-wrap an already-template source', () => {
      const section = 'Job Input Mappings:\n- find ← {{CustomerId}}\n';
      const result = parseJobInputs(section);
      expect(result.find).toBe('{{CustomerId}}');
    });

    it('parses non-find mapping into params.mappings', () => {
      const section = 'Job Input Mappings:\n- tier ← customer.tier\n';
      const result = parseJobInputs(section);
      expect(result.mappings).toBeDefined();
      expect(result.mappings.tier).toBe('{{customer.tier}}');
    });
  });

  it('parses both sections when both are present', () => {
    const section = 'Job Static Inputs:\n- collection: users\n- returns: user\n\nJob Input Mappings:\n- find ← CustomerId\n';
    const result = parseJobInputs(section);
    expect(result.collection).toBe('users');
    expect(result.returns).toBe('user');
    expect(result.find).toBe('{{CustomerId}}');
  });

  it('returns empty object when section has no recognizable content', () => {
    const result = parseJobInputs('Some random text without the expected headers');
    expect(result).toEqual({});
  });
});

describe('parseKeyValueBlock', () => {
  it('parses a simple block with two key-value pairs', () => {
    const section = 'Returns:\n- name: Alice\n- age: 30\n';
    const result = parseKeyValueBlock(section, 'Returns');
    expect(result).toEqual({ name: 'Alice', age: '30' });
  });

  it('strips quotes from values', () => {
    const section = 'Config:\n- key: "value"\n';
    const result = parseKeyValueBlock(section, 'Config');
    expect(result.key).toBe('value');
  });

  it('returns empty object when header not found', () => {
    const result = parseKeyValueBlock('Some text', 'NotPresent');
    expect(result).toEqual({});
  });

  it('stops at #### heading delimiter', () => {
    const section = 'Returns:\n- a: 1\n#### Next Section\n- b: 2\n';
    const result = parseKeyValueBlock(section, 'Returns');
    expect(result.a).toBe('1');
    expect(result.b).toBeUndefined();
  });
});

describe('extractField', () => {
  it('extracts field using default colon pattern', () => {
    expect(extractField('collection: users', 'collection')).toBe('users');
  });

  it('is case-insensitive on field name', () => {
    expect(extractField('Collection: orders', 'collection')).toBe('orders');
  });

  it('extracts field with bold marker **FieldName**', () => {
    expect(extractField('**Collection**: products', 'Collection')).toBe('products');
  });

  it('strips parenthesised text from value', () => {
    expect(extractField('returns: user (the matched user)', 'returns')).toBe('user');
  });

  it('returns undefined when field is absent', () => {
    expect(extractField('other: value', 'collection')).toBeUndefined();
  });
});
