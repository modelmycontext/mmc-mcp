// staticUi.ts — optionally serve the built mmc-workflow SPA from this runtime,
// so a managed deployment ships engine + dashboard as one container.
//
// Enabled only when MMC_UI_DIST points at a built SPA directory (the Docker
// image copies mmc-workflow's `dist/` there). Unset/missing ⇒ no-op: the server
// runs engine-only, exactly as before. Portable across Node and Bun — it reads
// files with fs rather than a runtime-specific serveStatic middleware (the SPA
// is small and loads once).
import fs from 'fs';
import path from 'path';
import type { Hono } from 'hono';
import { logger } from '@src/utils/logger.js';

// Paths owned by the runtime/API — never shadowed by the SPA fallback. A request
// under one of these that didn't match an earlier route is a real 404, not an
// SPA deep-link.
//
// NOTE: `/f` is intentionally NOT reserved. The applicant form runner moved into
// the co-hosted SPA as the React route `/f/:token`; when the SPA is served it
// must receive `/f/*` deep-links via the fallback. The runtime keeps a vanilla
// `/f` HTML page mounted ONLY when the SPA is absent (see httpRoutes +
// isSpaCoHosted), so engine-only deployments still have a form. The form's DATA
// routes (`/forms/resolve`, `/external-events`) stay reserved — they're API.
const RESERVED_PREFIXES = [
  '/mcp', '/api', '/admin', '/files', '/workflows', '/run', '/forms',
  '/external-events', '/livez', '/health', '/resync', '/roles', '/connectors',
];

/** True iff a built SPA is actually being co-hosted (MMC_UI_DIST set AND its
 *  index.html exists). The runtime uses this to decide whether to serve its own
 *  vanilla form pages (engine-only) or defer `/f/*` to the SPA fallback. */
export function isSpaCoHosted(): boolean {
  const dist = process.env.MMC_UI_DIST;
  return !!dist && fs.existsSync(path.join(dist, 'index.html'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a request path to a real file under `dist`, guarding against
 *  traversal. Returns null if the path escapes dist or isn't a file. Exported
 *  for testing. */
export function resolveStaticFile(dist: string, urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const abs = path.resolve(dist, rel);
  const root = path.resolve(dist);
  // Must stay within dist (block ../ traversal).
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch { /* not a file */ }
  return null;
}

function isReserved(p: string): boolean {
  return RESERVED_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));
}

/**
 * Mounts the SPA static handler as a catch-all. MUST be registered LAST so every
 * specific runtime route wins first. No-op when MMC_UI_DIST is unset or missing.
 */
export function mountStaticUiRoutes(app: Hono): void {
  const dist = process.env.MMC_UI_DIST;
  if (!dist) {
    logger.info('[ui] MMC_UI_DIST not set — dashboard SPA not co-hosted (engine-only)');
    return;
  }
  const indexHtml = path.join(dist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    logger.warn({ dist }, '[ui] MMC_UI_DIST set but index.html missing — not serving SPA');
    return;
  }
  logger.info({ dist }, '[ui] co-hosting the dashboard SPA from MMC_UI_DIST');

  app.get('*', (c) => {
    const p = c.req.path;
    // Reserved API/runtime paths that fell through earlier routes → real 404.
    if (isReserved(p)) return c.text('Not found', 404);

    const file = resolveStaticFile(dist, p);
    if (file) {
      const body = fs.readFileSync(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      // Hashed asset filenames are immutable; index.html must stay fresh.
      const cache = path.basename(file) === 'index.html'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable';
      return c.body(body as any, 200, { 'Content-Type': type, 'Cache-Control': cache });
    }

    // SPA fallback (root and deep links) — serve index.html so the client
    // router resolves the path. Never cache it (hashed assets are immutable;
    // the HTML entry point must stay fresh to pick up new asset hashes).
    return c.body(fs.readFileSync(indexHtml), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });
}
