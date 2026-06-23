import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmailConnector } from '../../connectors/core/send-email.js';

const ctx: any = {
  eventBus: { publish: vi.fn() },
  dataSources: {},
  tools: {},
};

describe('send-email connector', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset to a known empty state each test so individual env flips don't leak.
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
    delete process.env.MMC_EMAIL_DRY_RUN;
    delete process.env.MMC_EMAIL_FROM;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns success: false with an error reason when required inputs are missing', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendEmailConnector.execute(ctx, { toEmail: 'r@e.com' }, {});
    expect(res.success).toBe(false);
    expect(res.messageId).toBeNull();
    expect(typeof res.sentAt).toBe('string');
    // Failure reason is exposed (not just logged) so a slice can branch on it.
    expect(res.error).toMatch(/missing required input/);
  });

  it('returns a synthetic messageId in dry-run mode (explicit flag)', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendEmailConnector.execute(ctx, {
      toEmail: 'r@e.com',
      subject: 'S',
      bodyText: 'B',
      fromEmail: 'a@b.com',
    }, {});
    expect(res.success).toBe(true);
    expect(String(res.messageId)).toMatch(/^dry-run-/);
    expect(typeof res.sentAt).toBe('string');
    // error is an always-present key, null on success (so a mapped error fact
    // is never seen as a "field not returned" fatal on a successful send).
    expect(res.error).toBeNull();
  });

  it('falls into dry-run when RESEND_API_KEY is missing (safety default)', async () => {
    // No RESEND_API_KEY, no explicit dry-run flag — should still NOT contact Resend.
    const res = await sendEmailConnector.execute(ctx, {
      toEmail: 'r@e.com',
      subject: 'S',
      bodyText: 'B',
      fromEmail: 'a@b.com',
    }, {});
    expect(res.success).toBe(true);
    expect(String(res.messageId)).toMatch(/^dry-run-/);
  });

  it('falls back fromEmail to MMC_EMAIL_FROM env when omitted', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    process.env.MMC_EMAIL_FROM = 'env@from.com';
    const res = await sendEmailConnector.execute(ctx, {
      toEmail: 'r@e.com',
      subject: 'S',
      bodyText: 'B',
    }, {});
    expect(res.success).toBe(true);
  });

  it('accepts kebab-case input keys (toEmail / to-email parity)', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendEmailConnector.execute(ctx, {
      'to-email': 'r@e.com',
      subject: 'S',
      'body-text': 'B',
      'from-email': 'a@b.com',
    }, {});
    expect(res.success).toBe(true);
  });

  it('reads inputs from the input arg as fallback when not in params', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendEmailConnector.execute(ctx, {}, {
      toEmail: 'r@e.com',
      subject: 'S',
      bodyText: 'B',
      fromEmail: 'a@b.com',
    });
    expect(res.success).toBe(true);
  });

  it('declares getAssignedVariables for the output facts (incl. error)', () => {
    const out = sendEmailConnector.getAssignedVariables({});
    expect(out.assignedVariables).toEqual(['success', 'messageId', 'sentAt', 'error']);
  });
});
