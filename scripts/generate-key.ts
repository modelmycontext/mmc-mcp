import { randomBytes, createHash } from 'node:crypto';
import { writeEnvVar } from '../src/admin/envManager.ts';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '..', '.env');

const rawKey = 'mmc_sk_' + randomBytes(32).toString('hex');
const hash = createHash('sha256').update(rawKey).digest('hex');

writeEnvVar(envPath, 'ADMIN_API_KEY_HASH', hash);
process.env.ADMIN_API_KEY_HASH = hash;

process.stderr.write('\n✓ Admin API key generated. Hash stored in .env\n');
process.stderr.write('\nRaw key (copy this — it will not be shown again):\n');
process.stderr.write(`\n  ${rawKey}\n\n`);
