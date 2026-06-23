/**
 * Ad-hoc live-send test for Resend integration.
 *
 * Calls Resend directly with the same payload shape the send-email connector
 * would produce in live mode. Confirms the API key, sender, and recipient are
 * all working end-to-end.
 *
 * Usage:
 *   node scripts/test-send-email-live.mjs
 *
 * Requires RESEND_API_KEY in .env.
 */

import 'dotenv/config';
import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('[FAILED] RESEND_API_KEY is not set in mmc-mcp/.env');
  process.exit(1);
}

const placeholderToken = 'test-token-' + Math.random().toString(36).slice(2, 10);
const placeholderUrl = `https://forms.example.nz/enrol/${placeholderToken}`;

const payload = {
  from: 'onboarding@resend.dev',
  to: 'arjan@ebdconnect.com',
  subject: 'Test: complete your driving academy enrolment',
  text:
    `Kia ora,\n\n` +
    `Thanks for starting your enrolment with the academy. ` +
    `Please complete your details and sign the enrolment agreement at:\n\n` +
    `${placeholderUrl}\n\n` +
    `(Test message from the mmc-mcp send-email connector live-send check. ` +
    `mmc-forms is not yet built — the link above is a placeholder.)\n\n` +
    `— mmc-mcp connector test`,
};

console.log('[live-send] to:', payload.to);
console.log('[live-send] from:', payload.from);
console.log('[live-send] subject:', payload.subject);
console.log('[live-send] placeholder url:', placeholderUrl);

const resend = new Resend(apiKey);
const result = await resend.emails.send(payload);

if (result.error) {
  console.error('\n[FAILED] Resend returned an error:');
  console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}

console.log('\n[OK] sent');
console.log('messageId:', result.data?.id);
console.log('sentAt:', new Date().toISOString());
process.exit(0);
