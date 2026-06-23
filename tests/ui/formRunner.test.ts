import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { getFormRunnerHtml, mountFormRunnerRoute, TOOL_NAME_RE } from '../../src/ui/formRunner.js';

function buildApp() {
  const app = new Hono();
  mountFormRunnerRoute(app);
  return app;
}

describe('form-runner page asset', () => {
  it('serves the real host page, not the stub', () => {
    const html = getFormRunnerHtml();
    expect(html).toContain('form-runner.html');
    expect(html).toContain('ui://mmc/interface-form');
    expect(html).toContain('complete-slice');
  });

  it('keeps the hard-won MCP client rules in the page', () => {
    const html = getFormRunnerHtml();
    // unique monotonic JSON-RPC id (@hono/mcp routes responses by id)
    expect(html).toContain('nextRpcId++');
    // SSE detected by Content-Type header, never by body sniffing
    expect(html).toContain("indexOf('text/event-stream')");
    // a load timeout so the user never sits on an infinite spinner
    expect(html).toContain('LOAD_TIMEOUT_MS');
    // complete-slice { success: false } responses surface as errors
    expect(html).toContain('parsed.success === false');
  });
});

describe('GET /run/:toolName', () => {
  it('serves the host page for a well-formed tool name', async () => {
    const res = await buildApp().request('/run/activity-credit-decisioning-submit-credit-application');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('ModelMyContext');
  });

  it('404s tool names that cannot be MCP tools', async () => {
    const app = buildApp();
    for (const bad of ['Not-Kebab', 'has_underscore', '-leading-dash', 'a'.repeat(65), '..']) {
      const res = await app.request(`/run/${encodeURIComponent(bad)}`);
      expect(res.status, `expected 404 for ${JSON.stringify(bad)}`).toBe(404);
    }
  });

  it('does not shadow other paths', async () => {
    const res = await buildApp().request('/run');
    expect(res.status).toBe(404);
  });
});

describe('TOOL_NAME_RE', () => {
  it('accepts canonical activity-prefixed slice tool names', () => {
    expect(TOOL_NAME_RE.test('activity-lfd9egi97-admissions-officer-captures-enquiry')).toBe(true);
    expect(TOOL_NAME_RE.test('submit-discount-request')).toBe(true);
  });

  it('caps at the 64-char MCP tool-name limit', () => {
    expect(TOOL_NAME_RE.test('a'.repeat(64))).toBe(true);
    expect(TOOL_NAME_RE.test('a'.repeat(65))).toBe(false);
  });
});
