// authProvider.ts — the pluggable authentication seam for the HTTP surface.
//
// One AuthProvider authenticates each request into a Principal (or rejects).
// The active provider is chosen by MMC_AUTH_MODE, read per-request so rotation
// / mode changes take effect without a restart. This is the foundation an SSO
// or PropelAuth adapter slots into later (security/mmc-mcp-security.md Issue 2):
// nothing outside this module inspects tokens.
//
// Back-compat is exact: with MMC_AUTH_MODE unset the mode is DERIVED from
// MCP_ACCESS_TOKEN_HASH — set ⇒ 'static-token' (enforce), unset ⇒ 'none' (open,
// loopback dev + the workbench Test panel). So existing deployments and the test
// suite see no behaviour change.
import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { logger } from '@src/utils/logger.js';
import { findUserByToken } from './usersStore.js';

/** The authenticated caller. `roles` are coarse capability roles (today only
 *  'admin'); workflow roles arrive with the PropelAuth adapter. */
export interface Principal {
  sub: string;
  email?: string;
  roles: string[];
  /** True for the synthetic principal minted when auth is effectively off. */
  dev?: boolean;
}

// Make c.get('principal') / c.set('principal', …) type-safe app-wide.
declare module 'hono' {
  interface ContextVariableMap {
    principal?: Principal;
  }
}

export type AuthMode = 'none' | 'static-token' | 'json-users';

export interface AuthProvider {
  readonly mode: AuthMode;
  /** Resolve the caller, or return null to reject (middleware → 401). */
  authenticate(c: Context): Promise<Principal | null> | Principal | null;
}

const DEV_PRINCIPAL: Principal = { sub: 'dev', roles: ['admin'], dev: true };

/** `none` — no authentication. Every request is the dev principal. Intended for
 *  loopback dev only; a managed deployment must not run this mode. */
export const noneAuthProvider: AuthProvider = {
  mode: 'none',
  authenticate: () => DEV_PRINCIPAL,
};

/** `static-token` — sha256(Bearer token) must equal MCP_ACCESS_TOKEN_HASH.
 *  When the hash is unset the provider stays open (preserves the historical
 *  "no hash ⇒ unauthenticated" behaviour) so dev/test never break. */
export const staticTokenAuthProvider: AuthProvider = {
  mode: 'static-token',
  authenticate: (c) => {
    const storedHash = process.env.MCP_ACCESS_TOKEN_HASH;
    if (!storedHash) return DEV_PRINCIPAL; // open — same as the legacy middleware
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
    const rawToken = authHeader.slice(7).trim();
    const hash = createHash('sha256').update(rawToken).digest('hex');
    return hash === storedHash ? { sub: 'static-token', roles: ['admin'] } : null;
  },
};

/** `json-users` — per-user bearer tokens from a JSON users+roles table
 *  (src/admin/usersStore.ts). Self-contained: no PropelAuth, no workbench. The
 *  matched user's roles become the principal's roles, so downstream role gating
 *  (e.g. register-agent) sees a real identity rather than a single shared token. */
export const jsonUsersAuthProvider: AuthProvider = {
  mode: 'json-users',
  authenticate: (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
    const user = findUserByToken(authHeader.slice(7).trim());
    if (!user) return null;
    return { sub: user.username, roles: user.roles };
  },
};

/** Resolve the active provider. MMC_AUTH_MODE wins; otherwise derive from
 *  MCP_ACCESS_TOKEN_HASH for back-compat. Read per request. */
export function resolveAuthProvider(): AuthProvider {
  const explicit = process.env.MMC_AUTH_MODE as AuthMode | undefined;
  const mode: AuthMode = explicit ?? (process.env.MCP_ACCESS_TOKEN_HASH ? 'static-token' : 'none');
  switch (mode) {
    case 'none':
      return noneAuthProvider;
    case 'static-token':
      return staticTokenAuthProvider;
    case 'json-users':
      return jsonUsersAuthProvider;
    default:
      // Unknown mode (e.g. a future 'propelauth' before its adapter ships) —
      // fail closed to token enforcement rather than silently opening up.
      logger.warn({ mode }, '[auth] unknown MMC_AUTH_MODE — falling back to static-token enforcement');
      return staticTokenAuthProvider;
  }
}

/** Middleware that applies the active provider: reject → 401, else attach the
 *  Principal to the context and continue. */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const provider = resolveAuthProvider();
  const principal = await provider.authenticate(c);
  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  c.set('principal', principal);
  await next();
};
