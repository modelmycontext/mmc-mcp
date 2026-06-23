import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountPublicFormRoutes, getPublicFormHtml } from '../../src/ui/publicForm.js';
import { signJti } from '../../src/forms/jtiVerify.js';

const KEY = 'test-forms-hmac-key';

// Temp skills tree with one forms/<id>.json template + one activity model whose
// facts the template references. No reads from the gitignored skills/ dir.
let tmp: string;
let skillsDir: string;

const MODEL = {
  slices: [{
    interface: { facts: [
      { id: 'fact-name', name: 'full-name', valueType: 'text' },
      { id: 'fact-email', name: 'email', valueType: 'text' },
    ] },
  }],
};

const TEMPLATE = {
  displayName: 'Enrolment application',
  externalOutcomeName: 'application-form-submitted',
  branding: { organisationName: 'Driving Academy' },
  sections: [{ id: 'main', fields: [{ factId: 'fact-name', required: true }, { factId: 'fact-email' }] }],
};

function buildApp() {
  const app = new Hono();
  mountPublicFormRoutes(app, { skillsDir });
  return app;
}

function token(overrides: Partial<{ correlationId: string; eventType: string; templateId: string; exp: number; extras: any }> = {}) {
  return signJti({
    correlationId: 'sess-1',
    eventType: 'application-form-submitted',
    templateId: 'tmpl-enrol',
    exp: Date.now() + 60_000,
    ...overrides,
  } as any, KEY);
}

describe('public form routes', () => {
  const origKey = process.env.FORMS_HMAC_KEY;
  const origDir = process.env.MMC_FORMS_DIR;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-forms-'));
    skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'forms'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'da-nzta-enrollment'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'forms', 'tmpl-enrol.json'), JSON.stringify(TEMPLATE));
    fs.writeFileSync(path.join(skillsDir, 'da-nzta-enrollment', 'da-nzta-enrollment.json'), JSON.stringify(MODEL));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (origDir === undefined) delete process.env.MMC_FORMS_DIR; else process.env.MMC_FORMS_DIR = origDir;
  });

  beforeEach(() => {
    process.env.FORMS_HMAC_KEY = KEY;
    process.env.MMC_FORMS_DIR = path.join(skillsDir, 'forms');
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.FORMS_HMAC_KEY; else process.env.FORMS_HMAC_KEY = origKey;
  });

  it('GET /f/:token serves the vanilla applicant page by default (engine-only)', async () => {
    const res = await buildApp().request(`/f/${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/forms/resolve/');
    expect(html).toContain('signature'); // signature pad present
  });

  it('does NOT mount the vanilla /f page when serveHtmlPage is false (SPA co-hosted)', async () => {
    const app = new Hono();
    mountPublicFormRoutes(app, { skillsDir, serveHtmlPage: false });
    // /f falls through (no route) so it can reach the SPA fallback registered later.
    const page = await app.request(`/f/${token()}`);
    expect(page.status).toBe(404);
    // …but the data route is still served — both UIs consume it.
    const resolve = await app.request(`/forms/resolve/${token()}`);
    expect(resolve.status).toBe(200);
    expect((await resolve.json()).ok).toBe(true);
  });

  it('GET /forms/resolve resolves a valid token into a PublicFormSpec', async () => {
    const res = await buildApp().request(`/forms/resolve/${token({ extras: { prefilled: { 'fact-email': 'a@b.com' } } })}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.spec.title).toBe('Enrolment application');
    expect(body.spec.eventType).toBe('application-form-submitted');
    expect(body.spec.branding.organisationName).toBe('Driving Academy');
    const names = body.spec.sections[0].fields.map((f: any) => f.name);
    expect(names).toEqual(['full-name', 'email']);
    expect(body.spec.sections[0].fields.find((f: any) => f.name === 'email').value).toBe('a@b.com');
  });

  it('rejects a tampered/invalid signature with 401', async () => {
    const bad = token() + 'x';
    const res = await buildApp().request(`/forms/resolve/${bad}`);
    expect(res.status).toBe(401);
    expect((await res.json() as any).reason).toBe('invalid');
  });

  it('returns 410 for an expired token', async () => {
    const res = await buildApp().request(`/forms/resolve/${token({ exp: Date.now() - 1000 })}`);
    expect(res.status).toBe(410);
    expect((await res.json() as any).reason).toBe('expired');
  });

  it('returns 404 for an unknown template', async () => {
    const res = await buildApp().request(`/forms/resolve/${token({ templateId: 'tmpl-missing' })}`);
    expect(res.status).toBe(404);
    expect((await res.json() as any).reason).toBe('not-found');
  });

  it('500s when FORMS_HMAC_KEY is unset', async () => {
    delete process.env.FORMS_HMAC_KEY;
    const res = await buildApp().request(`/forms/resolve/${token()}`);
    expect(res.status).toBe(500);
    expect((await res.json() as any).reason).toBe('misconfigured');
  });
});

describe('public-form.html asset', () => {
  it('serves the real page with the submit + signature wiring', () => {
    const html = getPublicFormHtml();
    expect(html).toContain('/external-events/');
    expect(html).toContain('setupSignaturePad');
    expect(html).toContain('signature-image');
  });
});
