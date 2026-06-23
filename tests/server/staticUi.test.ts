import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountStaticUiRoutes, resolveStaticFile, isSpaCoHosted } from '../../src/server/staticUi.js';

let dist: string;

function buildApp() {
  const app = new Hono();
  // A representative reserved route registered before the catch-all.
  app.get('/api/chat', (c) => c.json({ ok: true }));
  mountStaticUiRoutes(app);
  return app;
}

// Shared fixture for the whole file — created once so a per-describe afterAll
// can't tear it down before a later describe runs.
beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-ui-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>App</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
});
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

describe('resolveStaticFile', () => {
  it('resolves a real nested asset', () => {
    expect(resolveStaticFile(dist, '/assets/app-abc123.js')).toBe(path.join(dist, 'assets', 'app-abc123.js'));
  });
  it('returns null for a missing file', () => {
    expect(resolveStaticFile(dist, '/nope.js')).toBeNull();
  });
  it('blocks path traversal out of dist', () => {
    expect(resolveStaticFile(dist, '/../../etc/passwd')).toBeNull();
    expect(resolveStaticFile(dist, '/assets/../../secret')).toBeNull();
  });
});

describe('mountStaticUiRoutes (MMC_UI_DIST set)', () => {
  const orig = process.env.MMC_UI_DIST;
  beforeEach(() => { process.env.MMC_UI_DIST = dist; });
  afterEach(() => { if (orig === undefined) delete process.env.MMC_UI_DIST; else process.env.MMC_UI_DIST = orig; });

  it('serves a hashed asset with a long immutable cache', async () => {
    const res = await buildApp().request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('serves index.html with no-cache at root', async () => {
    const res = await buildApp().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for an SPA deep link', async () => {
    const res = await buildApp().request('/history');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>App</title>');
  });

  it('does NOT shadow reserved API routes registered earlier', async () => {
    const res = await buildApp().request('/api/chat');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('404s an unmatched reserved path instead of serving the SPA', async () => {
    const res = await buildApp().request('/api/unknown');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>App</title>');
  });

  it('serves the SPA for /f/:token deep links (form runner is now a SPA route)', async () => {
    const res = await buildApp().request('/f/some.jwt.token');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>App</title>');
  });

  it('isSpaCoHosted() is true when MMC_UI_DIST points at a built SPA', () => {
    expect(isSpaCoHosted()).toBe(true);
  });
});

describe('mountStaticUiRoutes (MMC_UI_DIST unset)', () => {
  const orig = process.env.MMC_UI_DIST;
  beforeEach(() => { delete process.env.MMC_UI_DIST; });
  afterEach(() => { if (orig === undefined) delete process.env.MMC_UI_DIST; else process.env.MMC_UI_DIST = orig; });

  it('is a no-op (engine-only) — no catch-all swallows unknown paths', async () => {
    const res = await buildApp().request('/history');
    expect(res.status).toBe(404);
  });

  it('isSpaCoHosted() is false when MMC_UI_DIST is unset', () => {
    expect(isSpaCoHosted()).toBe(false);
  });
});
