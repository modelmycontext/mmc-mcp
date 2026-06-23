// publicForm.ts — routes + page asset for the authored public form runner
// (the FormTemplate path). Serves GET /f/:token (the page) and
// GET /forms/resolve/:token (server-side jti verify + template/model resolution
// → PublicFormSpec). Submit goes to the existing POST /external-events/:eventType.
//
// The page HTML lives in the sibling public-form.html, read per request via
// import.meta.url (same lazy pattern as interfaceForm.ts/formRunner.ts).
import fs from 'fs';
import type { Hono } from 'hono';
import { logger } from '@src/utils/logger.js';
import { verifyJti } from '@src/forms/jtiVerify.js';
import {
  loadFormTemplate,
  findModelForTemplate,
  resolvePublicFormSpec,
} from '@src/forms/formTemplate.js';

export function getPublicFormHtml(): string {
  try {
    return fs.readFileSync(new URL('./public-form.html', import.meta.url), 'utf8');
  } catch (err: any) {
    logger.warn({ error: err?.message }, '[ui] public-form.html not found — serving stub');
    return '<!doctype html><meta charset="utf-8"><body>Form runner unavailable.</body>';
  }
}

export interface PublicFormRoutesDeps {
  /** Root of the synced skills/models tree — templates resolve relative to it. */
  skillsDir: string;
  /**
   * Whether to serve the runtime's own vanilla `/f/:token` HTML page. True for
   * engine-only deployments (no co-hosted SPA). When the mmc-workflow SPA IS
   * co-hosted it owns the `/f/:token` React route, so this is false and `/f/*`
   * deep-links fall through to the SPA fallback. The data route
   * (`/forms/resolve/:token`) is mounted either way — both UIs consume it.
   */
  serveHtmlPage?: boolean;
}

/**
 * Mounts the public form runner:
 *   GET  /f/:token              — serves the applicant page (always 200; the page
 *                                 fetches /forms/resolve and shows its own errors)
 *   GET  /forms/resolve/:token  — verifies the jti server-side (an upgrade over
 *                                 the workbench's client-side decode-without-verify),
 *                                 loads the FormTemplate + owning activity model,
 *                                 returns a render-ready PublicFormSpec.
 */
export function mountPublicFormRoutes(app: Hono, deps: PublicFormRoutesDeps): void {
  const { skillsDir, serveHtmlPage = true } = deps;

  // Engine-only deployments serve the runtime's own vanilla form page. When the
  // SPA is co-hosted, `/f/:token` is left unmounted so it falls through to the
  // SPA's React route (mounted via the catch-all in mountStaticUiRoutes).
  if (serveHtmlPage) {
    app.get('/f/:token', (c) => c.html(getPublicFormHtml()));
  }

  app.get('/forms/resolve/:token', async (c) => {
    const token = c.req.param('token');

    const key = process.env.FORMS_HMAC_KEY;
    if (!key) {
      logger.error('[forms] FORMS_HMAC_KEY not set — cannot resolve form tokens');
      return c.json({ ok: false, reason: 'misconfigured', message: 'Form runner is not configured.' }, 500);
    }

    const verified = verifyJti(token, key);
    if (!verified.ok) {
      const status = verified.reason === 'expired' ? 410 : 401;
      const reason = verified.reason === 'expired' ? 'expired' : 'invalid';
      return c.json({ ok: false, reason, message: verified.message }, status);
    }

    const { templateId, eventType, extras } = verified.payload;
    if (!templateId) {
      return c.json({ ok: false, reason: 'invalid', message: 'Token has no template.' }, 400);
    }

    const template = await loadFormTemplate(skillsDir, templateId);
    if (!template) {
      return c.json({ ok: false, reason: 'not-found', message: 'This form is no longer available.' }, 404);
    }

    const model = await findModelForTemplate(skillsDir, template);
    if (!model) {
      logger.warn({ templateId }, '[forms] no synced model defines this template\'s facts');
      return c.json({ ok: false, reason: 'not-found', message: 'This form could not be prepared.' }, 404);
    }

    const prefilled = (extras && typeof extras === 'object' && (extras as any).prefilled)
      ? (extras as any).prefilled as Record<string, unknown>
      : undefined;

    const spec = resolvePublicFormSpec(template, model, { eventType, prefilled });
    return c.json({ ok: true, spec });
  });
}
