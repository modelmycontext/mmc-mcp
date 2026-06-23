import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readConfig,
  writeConfig,
  resolveConfigPath,
  runtimeConfigPath,
  seedConfigPath,
} from '../../src/admin/configStore.js';

describe('configStore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-configstore-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSeed(config: unknown) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(seedConfigPath(root), JSON.stringify(config), 'utf-8');
  }

  it('returns null when neither seed nor runtime config exists', () => {
    expect(readConfig(root)).toBeNull();
  });

  it('reads the seed config when no runtime copy exists', () => {
    writeSeed({ skillsDir: './skills' });
    expect(resolveConfigPath(root)).toBe(seedConfigPath(root));
    expect(readConfig(root)).toEqual({ skillsDir: './skills' });
  });

  it('writes to data/config.json and prefers it on subsequent reads', () => {
    writeSeed({ skillsDir: './skills', externalServers: [] });
    writeConfig(root, { skillsDir: './skills', externalServers: [{ name: 'slack' }] });

    expect(fs.existsSync(runtimeConfigPath(root))).toBe(true);
    // Seed untouched
    expect(JSON.parse(fs.readFileSync(seedConfigPath(root), 'utf-8')).externalServers).toEqual([]);
    // Reads now resolve to the runtime copy
    expect(resolveConfigPath(root)).toBe(runtimeConfigPath(root));
    expect(readConfig(root)?.externalServers).toEqual([{ name: 'slack' }]);
  });

  it('creates the data directory if missing', () => {
    writeConfig(root, { skillsDir: './skills' });
    expect(readConfig(root)).toEqual({ skillsDir: './skills' });
  });

  it('propagates parse errors to the caller', () => {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(runtimeConfigPath(root), '{not json', 'utf-8');
    expect(() => readConfig(root)).toThrow();
  });
});
