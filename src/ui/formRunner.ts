// formRunner.ts — the standalone form-runner host page served at /run/:toolName.
//
// The page HTML lives in the sibling form-runner.html (a real, editable file)
// and is read on each request via import.meta.url, same as interfaceForm.ts:
// resolves under Bun, Node/tsx, and vitest alike, and edits are picked up live
// in dev without restarting the server. Falls back to a stub if the asset is
// missing (e.g. a bundled dist that didn't copy it).
//
// The route mount lives here (not in httpRoutes.ts) so it can be tested
// without importing the composition.js singletons.
import fs from 'fs';
import type { Hono } from 'hono';
import { logger } from '@src/utils/logger.js';

/** MCP tool names are kebab identifiers (64-char cap, see displayNames.ts).
 *  Anything else on /run/:toolName is a malformed link, not a tool. */
export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function getFormRunnerHtml(): string {
  try {
    return fs.readFileSync(new URL('./form-runner.html', import.meta.url), 'utf8');
  } catch (err: any) {
    logger.warn({ error: err?.message }, '[ui] form-runner.html not found — serving stub');
    return '<!doctype html><meta charset="utf-8"><body>Form runner unavailable.</body>';
  }
}

/**
 * GET /run/:toolName — standalone, link-addressable form page for an
 * interface/view slice. The page is a self-contained MCP client against the
 * same-origin /mcp endpoint: it fetches the slice's FormSpec, hosts the
 * ui://mmc/interface-form renderer in a sandboxed iframe, and submits via
 * complete-slice. The tool name is parsed client-side from the path; the
 * server only validates its shape so malformed links get a 404 instead of a
 * page that can never load.
 */
export function mountFormRunnerRoute(app: Hono): void {
  app.get('/run/:toolName', (c) => {
    const toolName = c.req.param('toolName');
    if (!TOOL_NAME_RE.test(toolName)) {
      return c.text('Not found', 404);
    }
    return c.html(getFormRunnerHtml());
  });
}
