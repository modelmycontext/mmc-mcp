import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { loadUsers, findUserByToken, _resetUsersCache } from '../../src/admin/usersStore.js';
import { authMiddleware, resolveAuthProvider, jsonUsersAuthProvider } from '../../src/admin/authProvider.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const ALICE = 'mmc_at_alice-token';
const ADMIN = 'mmc_at_admin-token';

let tmp: string;
let usersFile: string;

function writeUsers(users: unknown[]) {
  fs.writeFileSync(usersFile, JSON.stringify({ users }));
  _resetUsersCache();
}

function buildApp() {
  const app = new Hono();
  app.use('/x', authMiddleware);
  app.all('/x', (c) => c.json({ ok: true, principal: c.get('principal') }));
  return app;
}

describe('json-users auth', () => {
  const origMode = process.env.MMC_AUTH_MODE;
  const origFile = process.env.MMC_USERS_FILE;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-users-'));
    usersFile = path.join(tmp, 'users.json');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    process.env.MMC_AUTH_MODE = 'json-users';
    process.env.MMC_USERS_FILE = usersFile;
    writeUsers([
      { username: 'alice', tokenHash: hash(ALICE), roles: ['underwriter'] },
      { username: 'admin', tokenHash: hash(ADMIN), roles: ['admin'] },
    ]);
  });
  afterEach(() => {
    _resetUsersCache();
    if (origMode === undefined) delete process.env.MMC_AUTH_MODE; else process.env.MMC_AUTH_MODE = origMode;
    if (origFile === undefined) delete process.env.MMC_USERS_FILE; else process.env.MMC_USERS_FILE = origFile;
  });

  it('resolveAuthProvider selects the json-users adapter', () => {
    expect(resolveAuthProvider()).toBe(jsonUsersAuthProvider);
  });

  it('loadUsers parses + normalizes the table', () => {
    const users = loadUsers(usersFile);
    expect(users.map((u) => u.username)).toEqual(['alice', 'admin']);
    expect(users[0].roles).toEqual(['underwriter']);
  });

  it('findUserByToken matches the raw token to its user', () => {
    expect(findUserByToken(ALICE, usersFile)?.username).toBe('alice');
    expect(findUserByToken('wrong', usersFile)).toBeNull();
  });

  it('authenticates a valid token and attaches the user principal with roles', async () => {
    const res = await buildApp().request('/x', { method: 'POST', headers: { Authorization: `Bearer ${ALICE}` } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).principal).toEqual({ sub: 'alice', roles: ['underwriter'] });
  });

  it('rejects missing, non-Bearer, and unknown tokens', async () => {
    const app = buildApp();
    expect((await app.request('/x', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: `Basic ${ALICE}` } })).status).toBe(401);
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('picks up an added user without a restart (mtime cache refresh)', async () => {
    const BOB = 'mmc_at_bob-token';
    writeUsers([
      { username: 'alice', tokenHash: hash(ALICE), roles: ['underwriter'] },
      { username: 'bob', tokenHash: hash(BOB), roles: ['admissions-officer'] },
    ]);
    const res = await buildApp().request('/x', { method: 'POST', headers: { Authorization: `Bearer ${BOB}` } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).principal.roles).toEqual(['admissions-officer']);
  });

  it('fails closed (401) when the users file is absent', async () => {
    process.env.MMC_USERS_FILE = path.join(tmp, 'does-not-exist.json');
    _resetUsersCache();
    const res = await buildApp().request('/x', { method: 'POST', headers: { Authorization: `Bearer ${ALICE}` } });
    expect(res.status).toBe(401);
  });
});
