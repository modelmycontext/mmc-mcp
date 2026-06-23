import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  resolveAuthProvider,
  noneAuthProvider,
  staticTokenAuthProvider,
  authMiddleware,
} from '../../src/admin/authProvider.js';

const TOKEN = 'mmc_at_test';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function buildApp() {
  const app = new Hono();
  app.use('/x', authMiddleware);
  // Echo the resolved principal so we can assert it was attached.
  app.all('/x', (c) => c.json({ ok: true, principal: c.get('principal') }));
  return app;
}

describe('resolveAuthProvider mode selection', () => {
  const origMode = process.env.MMC_AUTH_MODE;
  const origHash = process.env.MCP_ACCESS_TOKEN_HASH;
  beforeEach(() => { delete process.env.MMC_AUTH_MODE; delete process.env.MCP_ACCESS_TOKEN_HASH; });
  afterEach(() => {
    if (origMode === undefined) delete process.env.MMC_AUTH_MODE; else process.env.MMC_AUTH_MODE = origMode;
    if (origHash === undefined) delete process.env.MCP_ACCESS_TOKEN_HASH; else process.env.MCP_ACCESS_TOKEN_HASH = origHash;
  });

  it('derives none when neither mode nor hash is set (back-compat dev)', () => {
    expect(resolveAuthProvider()).toBe(noneAuthProvider);
  });
  it('derives static-token when a hash is set but no explicit mode', () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    expect(resolveAuthProvider()).toBe(staticTokenAuthProvider);
  });
  it('honours an explicit MMC_AUTH_MODE over the derivation', () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    process.env.MMC_AUTH_MODE = 'none';
    expect(resolveAuthProvider()).toBe(noneAuthProvider);
  });
  it('fails closed to static-token for an unknown mode', () => {
    process.env.MMC_AUTH_MODE = 'propelauth'; // adapter not built yet
    expect(resolveAuthProvider()).toBe(staticTokenAuthProvider);
  });
});

describe('authMiddleware behaviour', () => {
  const origMode = process.env.MMC_AUTH_MODE;
  const origHash = process.env.MCP_ACCESS_TOKEN_HASH;
  beforeEach(() => { delete process.env.MMC_AUTH_MODE; delete process.env.MCP_ACCESS_TOKEN_HASH; });
  afterEach(() => {
    if (origMode === undefined) delete process.env.MMC_AUTH_MODE; else process.env.MMC_AUTH_MODE = origMode;
    if (origHash === undefined) delete process.env.MCP_ACCESS_TOKEN_HASH; else process.env.MCP_ACCESS_TOKEN_HASH = origHash;
  });

  it('none mode: passes through with a dev principal', async () => {
    process.env.MMC_AUTH_MODE = 'none';
    const res = await buildApp().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.principal).toMatchObject({ sub: 'dev', dev: true, roles: ['admin'] });
  });

  it('static-token mode: rejects missing/wrong tokens, accepts the right one', async () => {
    process.env.MMC_AUTH_MODE = 'static-token';
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const app = buildApp();
    expect((await app.request('/x', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    const ok = await app.request('/x', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).principal).toMatchObject({ sub: 'static-token', roles: ['admin'] });
  });

  it('static-token mode with no hash stays open (legacy dev behaviour)', async () => {
    process.env.MMC_AUTH_MODE = 'static-token';
    const res = await buildApp().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('honours a hash rotated after startup (env read per-request)', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH; // derives static-token
    const app = buildApp();
    const rotated = 'mmc_at_rotated';
    process.env.MCP_ACCESS_TOKEN_HASH = createHash('sha256').update(rotated).digest('hex');
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    expect((await app.request('/x', { method: 'POST', headers: { Authorization: `Bearer ${rotated}` } })).status).toBe(200);
  });
});
