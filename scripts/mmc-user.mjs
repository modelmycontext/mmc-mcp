#!/usr/bin/env node
// mmc-user.mjs — manage the json-users auth table (data/auth-users.json).
//
// Usage:
//   node scripts/mmc-user.mjs add <username> [role ...]   # mint a user + token
//   node scripts/mmc-user.mjs list                        # list users + roles
//   node scripts/mmc-user.mjs remove <username>           # delete a user
//
// `add` prints the raw bearer token ONCE (only its sha256 hash is stored). The
// user sends it as `Authorization: Bearer <token>` when MMC_AUTH_MODE=json-users.
// Override the file with MMC_USERS_FILE.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const FILE =
  process.env.MMC_USERS_FILE ||
  path.join(process.env.MCP_PROJECT_ROOT ?? process.cwd(), 'data', 'auth-users.json');

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

function write(users) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ users }, null, 2) + '\n');
}

const [cmd, username, ...roles] = process.argv.slice(2);

if (cmd === 'add') {
  if (!username) { console.error('usage: mmc-user add <username> [role ...]'); process.exit(1); }
  const users = read().filter((u) => u.username !== username);
  const token = `mmc_at_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  users.push({ username, tokenHash, roles });
  write(users);
  console.log(`Added "${username}" with roles [${roles.join(', ') || '(none)'}] to ${FILE}`);
  console.log(`\nBearer token (shown once — store it now):\n  ${token}\n`);
} else if (cmd === 'list') {
  const users = read();
  if (!users.length) { console.log(`(no users in ${FILE})`); }
  for (const u of users) console.log(`${u.username}\t[${(u.roles || []).join(', ')}]`);
} else if (cmd === 'remove') {
  if (!username) { console.error('usage: mmc-user remove <username>'); process.exit(1); }
  const before = read();
  const after = before.filter((u) => u.username !== username);
  write(after);
  console.log(after.length < before.length ? `Removed "${username}".` : `No user "${username}".`);
} else {
  console.error('usage: mmc-user <add|list|remove> ...');
  process.exit(1);
}
