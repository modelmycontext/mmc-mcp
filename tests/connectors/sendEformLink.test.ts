import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendEformLinkConnector } from '../../connectors/core/send-eform-link.js';
import { verifyJti } from '../../src/forms/jtiVerify.js';

const ctx: any = { eventBus: {}, dataSources: {}, tools: {} };
const KEY = 'test-forms-hmac-key';
const base = {
  to: 'a@b.com',
  templateId: 'tmpl-x',
  eventType: 'application-form-submitted',
  correlationId: 's1',
  fromEmail: 'from@b.com',
};

describe('send-eform-link connector', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.FORMS_HMAC_KEY = KEY;
    process.env.MMC_EMAIL_DRY_RUN = 'true';
    delete process.env.MMC_FORMS_BASE_URL;
  });
  afterEach(() => { process.env = originalEnv; });

  it('mints a token with visible prefill and sends the link (dry-run)', async () => {
    const res = await sendEformLinkConnector.execute(ctx, { ...base, prefilled: { 'fact-uig726p2k': 'APP-1' } }, {});
    expect(res.success).toBe(true);
    expect(String(res.messageId)).toMatch(/^dry-run-/);
    expect(res.tokenUrl).toContain('/f/');
    // error is an always-present key, null on a successful send.
    expect(res.error).toBeNull();
    const v = verifyJti(res.jti, KEY);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.templateId).toBe('tmpl-x');
      expect(v.payload.eventType).toBe('application-form-submitted');
      expect((v.payload.extras?.prefilled as any)['fact-uig726p2k']).toBe('APP-1');
    }
  });

  it('falls back to correlationId from the connector context', async () => {
    const res = await sendEformLinkConnector.execute(
      { ...ctx, correlationId: 'ctx-sess' } as any,
      { to: 'a@b.com', templateId: 't', eventType: 'e', fromEmail: 'f@b.com' },
      {},
    );
    expect(res.success).toBe(true);
    const v = verifyJti(res.jti, KEY);
    expect(v.ok && v.payload.correlationId).toBe('ctx-sess');
  });

  it('substitutes {{link}} in a provided body', async () => {
    const res = await sendEformLinkConnector.execute(ctx, { ...base, bodyText: 'Click {{link}} now' }, {});
    expect(res.success).toBe(true);
  });

  it('mints the token but reports success:false + error for an unimplemented channel', async () => {
    const res = await sendEformLinkConnector.execute(ctx, { ...base, channel: 'sms' }, {});
    expect(res.success).toBe(false);
    expect(res.tokenUrl).toContain('/f/');
    expect(res.jti).toBeTruthy();
    expect(res.error).toMatch(/unsupported channel: sms/);
  });

  it('returns success:false + error when FORMS_HMAC_KEY is missing', async () => {
    delete process.env.FORMS_HMAC_KEY;
    const res = await sendEformLinkConnector.execute(ctx, base, {});
    expect(res.success).toBe(false);
    expect(res.jti).toBeNull();
    expect(res.error).toMatch(/FORMS_HMAC_KEY/);
  });

  it('returns success:false + error naming the missing inputs', async () => {
    const res = await sendEformLinkConnector.execute(ctx, { templateId: 't', eventType: 'e' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missing required input/);
  });

  it('declares error in getAssignedVariables', () => {
    const out = sendEformLinkConnector.getAssignedVariables({});
    expect(out.assignedVariables).toContain('error');
  });
});
