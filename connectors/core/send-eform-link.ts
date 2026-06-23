import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';
import { signJti } from '@src/forms/jtiVerify.js';
import { deliverEmail } from './lib/deliver-email.js';

/**
 * Sends a recipient a link to a (pre-filled) eForm, over a channel.
 *
 * One business step: mint a signed form-runner token (embedding any prefill
 * values), compose a short message containing the link, and deliver it (email
 * today; sms/other future). Folds together what used to be mint-form-token +
 * send-email for the form-send case.
 *
 * KEY: prefill is an EXPLICIT input (`prefilled`), meant to be mapped from
 * facts — so the form's pre-population is visible in the model rather than
 * hidden inside a token. Facts the model does NOT own (e.g. an externally
 * supplied registration-date) simply aren't listed here; they arrive on the
 * form submission.
 *
 * Side-effecting / non-idempotent on a live send — invoke as a Command Job.
 */
export const sendEformLinkConnector: Connector = {
  name: 'send-eform-link',
  description:
    "Sends a link to a pre-filled eForm over a channel (channel='email' today; sms/other future). Mints a signed " +
    "form-runner token embedding the prefill, composes a short message with the link, and delivers it. Prefill is an " +
    "explicit input — map it from facts so pre-population is visible in the model (no hidden token magic). For a " +
    "richly formatted message, compose it in a separate slice and use send-notification. Returns { success, " +
    "messageId, tokenUrl, expiresAt, jti, error }. `error` carries the failure reason (null on success) — map it to a " +
    "fact to branch to an error scenario. Dry-run safe (synthetic messageId when MMC_EMAIL_DRY_RUN / no key).",
  inputParams: [
    { name: 'channel', type: 'string', required: false, description: "Delivery channel: 'email' (default). 'sms'/others not yet implemented (token is still minted, success:false)." },
    { name: 'to', type: 'string', required: true, description: 'Recipient for the channel (email address when channel=email).' },
    { name: 'templateId', type: 'string', required: true, description: 'FormTemplate id the link opens.' },
    { name: 'eventType', type: 'string', required: true, description: "Event type the form submit publishes (e.g. 'application-form-submitted')." },
    { name: 'correlationId', type: 'string', required: false, description: "Workflow-instance id the submit binds to. Defaults to this slice's instance; legacy 'sessionId' still accepted." },
    { name: 'prefilled', type: 'object', required: false, description: 'Visible prefill: map of prefill key → value. Keys are `factId` or `factId.subField`. Map from facts so pre-population is explicit in the model.' },
    { name: 'subject', type: 'string', required: false, description: 'Message subject (email). Defaults to a generic invitation.' },
    { name: 'bodyText', type: 'string', required: false, description: 'Message body. Put `{{link}}` where the URL goes; if absent the link is appended. For complex bodies use a formatting slice + send-notification.' },
    { name: 'fromEmail', type: 'string', required: false, description: 'Sender address (email). Falls back to MMC_EMAIL_FROM env.' },
    { name: 'baseUrl', type: 'string', required: false, description: 'Form-runner base URL. Defaults to MMC_FORMS_BASE_URL env or http://localhost:3001.' },
    { name: 'ttlMs', type: 'number', required: false, description: 'Token lifetime in ms. Defaults to 30 days.' },
  ],
  outputParams: [
    { name: 'success', type: 'boolean', description: 'False if misconfigured (missing key/inputs), unsupported channel, or delivery failed.' },
    { name: 'messageId', type: 'string', description: "Provider message id. Synthetic 'dry-run-<ts>' in dry-run mode." },
    { name: 'tokenUrl', type: 'string', description: 'The minted form link that was sent (present even if delivery failed).' },
    { name: 'expiresAt', type: 'number', description: 'Token expiry (epoch ms).' },
    { name: 'jti', type: 'string', description: 'The signed token string.' },
    { name: 'error', type: 'string', description: 'Failure reason when success is false (missing config/inputs, unsupported channel, or delivery error); null on success. Map to a fact to branch to an error scenario.' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['success', 'messageId', 'tokenUrl', 'expiresAt', 'jti', 'error'] }),

  execute: async (ctx: ConnectorContext, params: Record<string, any>, input: Record<string, any> = {}) => {
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') return params[k];
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
      }
      return undefined;
    };
    const channel = String(pick('channel') || 'email').toLowerCase();
    const to = pick('to', 'toEmail', 'to-email');
    const templateId = pick('templateId', 'template-id');
    const eventType = pick('eventType', 'event-type');
    const correlationId = pick('correlationId', 'correlation-id', 'sessionId', 'session-id') ?? (ctx as any)?.correlationId;
    const prefilled = pick('prefilled');
    const subject = pick('subject') || 'Complete your form';
    const bodyTextRaw = pick('bodyText', 'body-text', 'text');
    const fromEmail = pick('fromEmail', 'from-email', 'from');
    const ttlMs = Number(pick('ttlMs', 'ttl-ms')) || 30 * 24 * 60 * 60 * 1000;
    const baseUrlRaw = pick('baseUrl', 'base-url') || process.env.MMC_FORMS_BASE_URL || 'http://localhost:3001';
    const baseUrl = String(baseUrlRaw).replace(/\/+$/, '');

    const fail = (error: string) => ({ success: false, messageId: null, tokenUrl: null, expiresAt: null, jti: null, error });

    const key = process.env.FORMS_HMAC_KEY;
    if (!key) return fail('FORMS_HMAC_KEY not configured');
    if (!to || !templateId || !eventType || !correlationId) {
      const missing = [
        !to && 'to', !templateId && 'templateId', !eventType && 'eventType', !correlationId && 'correlationId',
      ].filter(Boolean).join(', ');
      return fail(`missing required input: ${missing}`);
    }

    const exp = Date.now() + ttlMs;
    const extras = (prefilled && typeof prefilled === 'object') ? { prefilled } : undefined;
    const jti = signJti({ correlationId, eventType, templateId, exp, extras }, key);
    const tokenUrl = `${baseUrl}/f/${jti}`;

    const bodyText = (typeof bodyTextRaw === 'string' && bodyTextRaw)
      ? (bodyTextRaw.includes('{{link}}') ? bodyTextRaw.replace(/\{\{link\}\}/g, tokenUrl) : `${bodyTextRaw}\n\n${tokenUrl}`)
      : `Please complete your form:\n\n${tokenUrl}`;

    if (channel !== 'email') {
      // Token is minted (returned for diagnostics) but no channel delivered it.
      return { success: false, messageId: null, tokenUrl, expiresAt: exp, jti, error: `unsupported channel: ${channel}` };
    }

    const res = await deliverEmail({ to, subject, bodyText, from: fromEmail });
    return { success: res.success, messageId: res.messageId, tokenUrl, expiresAt: exp, jti, error: res.error };
  },
};
