import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendNotificationConnector } from '../../connectors/core/send-notification.js';

const ctx: any = { eventBus: {}, dataSources: {}, tools: {} };

describe('send-notification connector', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
    delete process.env.MMC_EMAIL_FROM;
  });
  afterEach(() => { process.env = originalEnv; });

  it('returns success:false when required inputs are missing', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendNotificationConnector.execute(ctx, { to: 'r@e.com' }, {});
    expect(res.success).toBe(false);
    expect(res.messageId).toBeNull();
    expect(typeof res.sentAt).toBe('string');
  });

  it('sends (dry-run) over the default email channel', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendNotificationConnector.execute(
      ctx, { to: 'r@e.com', subject: 'S', bodyText: 'B', fromEmail: 'a@b.com' }, {},
    );
    expect(res.success).toBe(true);
    expect(String(res.messageId)).toMatch(/^dry-run-/);
  });

  it('returns success:false for an unimplemented channel', async () => {
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    const res = await sendNotificationConnector.execute(
      ctx, { channel: 'sms', to: '+6400', subject: 'S', bodyText: 'B', fromEmail: 'a@b.com' }, {},
    );
    expect(res.success).toBe(false);
  });
});
