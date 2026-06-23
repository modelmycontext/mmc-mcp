import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { mcpAuthMiddleware } from '../../src/admin/mcpAuthMiddleware.js';

const TOKEN = 'mmc_at_test-token-value';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function buildApp() {
  const app = new Hono();
  app.use('/mcp', mcpAuthMiddleware);
  app.all('/mcp', (c) => c.json({ ok: true }));
  return app;
}

describe('mcpAuthMiddleware', () => {
  const originalHash = process.env.MCP_ACCESS_TOKEN_HASH;

  beforeEach(() => {
    delete process.env.MCP_ACCESS_TOKEN_HASH;
  });

  afterEach(() => {
    if (originalHash === undefined) delete process.env.MCP_ACCESS_TOKEN_HASH;
    else process.env.MCP_ACCESS_TOKEN_HASH = originalHash;
  });

  it('passes through when MCP_ACCESS_TOKEN_HASH is unset (dev mode)', async () => {
    const res = await buildApp().request('/mcp', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('rejects requests without an Authorization header when hash is set', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const res = await buildApp().request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const res = await buildApp().request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-Bearer auth schemes', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const res = await buildApp().request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const res = await buildApp().request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('honours a hash rotated after startup (env read per-request)', async () => {
    process.env.MCP_ACCESS_TOKEN_HASH = TOKEN_HASH;
    const app = buildApp();
    const newToken = 'mmc_at_rotated-token';
    process.env.MCP_ACCESS_TOKEN_HASH = createHash('sha256').update(newToken).digest('hex');

    const oldRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(oldRes.status).toBe(401);

    const newRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(newRes.status).toBe(200);
  });
});
