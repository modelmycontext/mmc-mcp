import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteDataSource } from '../../src/data-sources/sqliteDataSource.js';

vi.mock('@src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;
let ds: SqliteDataSource;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'sqlite-ds-test-'));
  ds = new SqliteDataSource(tmpDir);
});

afterEach(async () => {
  (ds as any).db.close();
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('SqliteDataSource', () => {
  describe('read', () => {
    it('returns empty array for a collection that has no data yet', async () => {
      expect(await ds.read('items')).toEqual([]);
    });

    it('creates the collection table if it does not exist (no crash on first read)', async () => {
      await expect(ds.read('brand-new-collection')).resolves.toEqual([]);
    });
  });

  describe('write', () => {
    it('inserts records and reads them back', async () => {
      await ds.write('items', [{ id: 'a', name: 'foo' }]);
      const result = await ds.read('items');
      expect(result).toEqual([{ id: 'a', name: 'foo' }]);
    });

    it('replaces all records on second write (DELETE + INSERT in transaction)', async () => {
      await ds.write('items', [{ id: 'a', name: 'old' }]);
      await ds.write('items', [{ id: 'b', name: 'new' }]);
      const result = await ds.read('items');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('b');
    });

    it('uses item.id as primary key', async () => {
      await ds.write('items', [{ id: 'my-id', value: 'test' }]);
      const result = await ds.read('items');
      expect(result[0].id).toBe('my-id');
    });

    it('uses item.MemberID as fallback primary key when id absent', async () => {
      await ds.write('members', [{ MemberID: 'M001', name: 'Alice' }]);
      const result = await ds.read('members');
      expect(result[0].MemberID).toBe('M001');
    });

    it('handles empty data array (deletes all records)', async () => {
      await ds.write('items', [{ id: 'a' }]);
      await ds.write('items', []);
      expect(await ds.read('items')).toEqual([]);
    });

    it('inserts multiple records and reads all back', async () => {
      const data = [{ id: '1', x: 'a' }, { id: '2', x: 'b' }, { id: '3', x: 'c' }];
      await ds.write('items', data);
      const result = await ds.read('items');
      expect(result).toHaveLength(3);
    });
  });
});
