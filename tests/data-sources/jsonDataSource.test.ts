import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { JsonDataSource } from '../../src/data-sources/jsonDataSource.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

describe('JsonDataSource', () => {
  let ds: JsonDataSource;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    ds = new JsonDataSource('/data');
  });

  describe('read', () => {
    it('reads and parses a JSON collection file', async () => {
      mockReadFile.mockResolvedValue('[{"id":"1","name":"Alice"}]');
      const result = await ds.read('users');
      expect(result).toEqual([{ id: '1', name: 'Alice' }]);
    });

    it('constructs file path as dataDir/collection.json', async () => {
      mockReadFile.mockResolvedValue('[]');
      await ds.read('users');
      expect(mockReadFile).toHaveBeenCalledWith(
        path.join('/data', 'users.json'),
        'utf-8'
      );
    });

    it('throws a descriptive error when the collection file is missing', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await expect(ds.read('missing')).rejects.toThrow(/Collection "missing" not found/);
    });

    it('returns empty array when file contains invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not valid json');
      const result = await ds.read('bad');
      expect(result).toEqual([]);
    });
  });

  describe('write', () => {
    it('serialises data and writes to collection.json with indentation', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      await ds.write('users', [{ id: '1' }]);
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join('/data', 'users.json'),
        JSON.stringify([{ id: '1' }], null, 2)
      );
    });

    it('constructs the correct file path for write', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      await ds.write('orders', []);
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join('/data', 'orders.json'),
        expect.any(String)
      );
    });
  });
});
