import { describe, it, expect, vi } from 'vitest';
import { extractReturnedValue } from '../../src/connectors/connectorOutputKeys.js';

vi.mock('@src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('extractReturnedValue', () => {
  it('returns the direct key when present', () => {
    expect(extractReturnedValue({ result: 42 }, 'result', 'tool-x')).toBe(42);
  });

  it('falls back to kebab-case lookup', () => {
    expect(extractReturnedValue({ 'plan-tier': 'gold' }, 'planTier', 'tool-x')).toBe('gold');
  });

  it('falls back to nested findInObject lookup', () => {
    expect(extractReturnedValue({ outer: { result: 7 } }, 'result', 'tool-x')).toBe(7);
  });

  it('does not invoke the schema-mismatch callback when a key resolves', () => {
    const onSchemaMismatch = vi.fn();
    extractReturnedValue({ result: 42 }, 'result', 'tool-x', onSchemaMismatch);
    expect(onSchemaMismatch).not.toHaveBeenCalled();
  });

  it('invokes the schema-mismatch callback with toolId, returnedFactName, and resultKeys when no key matches', () => {
    const onSchemaMismatch = vi.fn();
    const result = { documentRef: 'd', storagePath: 'p', rowCount: 0, sizeBytes: 0 };
    const value = extractReturnedValue(result, 'azure-import-result', 'azure-blob-download', onSchemaMismatch);
    expect(value).toBe(result); // whole result returned as fallback
    expect(onSchemaMismatch).toHaveBeenCalledOnce();
    expect(onSchemaMismatch).toHaveBeenCalledWith({
      toolId: 'azure-blob-download',
      returnedFactName: 'azure-import-result',
      resultKeys: ['documentRef', 'storagePath', 'rowCount', 'sizeBytes'],
    });
  });

  it('returns undefined for null/undefined inputs without invoking the callback', () => {
    const onSchemaMismatch = vi.fn();
    expect(extractReturnedValue(undefined, 'x', 't', onSchemaMismatch)).toBeUndefined();
    expect(extractReturnedValue(null, 'x', 't', onSchemaMismatch)).toBeUndefined();
    expect(onSchemaMismatch).not.toHaveBeenCalled();
  });
});
