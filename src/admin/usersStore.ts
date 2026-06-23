// usersStore.ts — a tiny JSON-backed users + roles table for the `json-users`
// auth mode. Deliberately self-contained in mmc-mcp: no PropelAuth, no workbench
// coupling, no database. Each user has a sha256-hashed bearer token and a list
// of workflow/capability roles.
//
// Store shape (default data/auth-users.json — under the Fly volume, runtime
// state, never baked into the image; deliberately NOT data/users.json, which is
// an existing skill data source of demo user records):
//   { "users": [ { "username": "alice", "tokenHash": "<sha256 hex>",
//                  "roles": ["underwriter"] }, ... ] }
//
// The file is read on demand and cached by mtime, so adding/rotating a user
// takes effect without a restart (mirrors the per-request env reads elsewhere).
// Use scripts/mmc-user.mjs to mint a user + token.
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { logger } from '@src/utils/logger.js';

export interface UserRecord {
  username: string;
  /** sha256(hex) of the user's bearer token. */
  tokenHash: string;
  roles: string[];
}

/** Default store path: <project root>/data/auth-users.json. Override with
 *  MMC_USERS_FILE. (Not data/users.json — that's a skill data source.) */
export function usersFilePath(): string {
  return (
    process.env.MMC_USERS_FILE ||
    path.join(process.env.MCP_PROJECT_ROOT ?? process.cwd(), 'data', 'auth-users.json')
  );
}

let cache: { mtimeMs: number; users: UserRecord[] } | null = null;

/** Load and validate the users table, cached by file mtime. Returns [] when the
 *  file is absent or malformed (json-users mode then fails every request closed). */
export function loadUsers(file = usersFilePath()): UserRecord[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return [];
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.users;

  let users: UserRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed?.users) ? parsed.users : [];
    users = rows
      .filter((u: any) => u && typeof u.username === 'string' && typeof u.tokenHash === 'string')
      .map((u: any) => ({
        username: u.username,
        tokenHash: String(u.tokenHash).toLowerCase(),
        roles: Array.isArray(u.roles) ? u.roles.filter((r: any): r is string => typeof r === 'string') : [],
      }));
  } catch (err: any) {
    logger.warn({ file, error: err?.message }, '[auth] users.json is malformed — treating as empty');
    users = [];
  }
  cache = { mtimeMs: stat.mtimeMs, users };
  return users;
}

/** Resolve a raw bearer token to its user record, or null. Constant work per
 *  candidate; the token count is tiny so a linear scan is fine. */
export function findUserByToken(rawToken: string, file = usersFilePath()): UserRecord | null {
  if (!rawToken) return null;
  const hash = createHash('sha256').update(rawToken).digest('hex');
  for (const u of loadUsers(file)) {
    if (u.tokenHash === hash) return u;
  }
  return null;
}

/** Test-only: drop the mtime cache so a freshly-written fixture is re-read. */
export function _resetUsersCache(): void {
  cache = null;
}
