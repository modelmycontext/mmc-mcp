import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';
import { deliverEmail } from './lib/deliver-email.js';

/**
 * Generic notification sender — the channel-agnostic successor to send-email.
 *
 * Sends a PRE-COMPOSED body to a recipient over a channel (email today;
 * sms / push / other are future). It does not template — compose the body
 * upstream (a Query Job or instruction slice) when it needs formatting. For
 * sending a pre-filled eForm link, use send-eform-link instead (it mints the
 * token + carries the prefill).
 */
export const sendNotificationConnector: Connector = {
  name: 'send-notification',
  description:
    "Sends a pre-composed notification to a recipient over a channel (channel='email' today; sms/other future). " +
    "Body is supplied ready-to-send — this connector does not template; compose it upstream if formatting is needed. " +
    "Generic successor to send-email. Returns { success, messageId, sentAt, error }. `error` carries the failure " +
    "reason (null on success). Dry-run (MMC_EMAIL_DRY_RUN=true OR no RESEND_API_KEY) returns a synthetic messageId " +
    "without sending.",
  inputParams: [
    { name: 'channel', type: 'string', required: false, description: "Delivery channel: 'email' (default). 'sms'/others are not yet implemented and return success:false." },
    { name: 'to', type: 'string', required: true, description: 'Recipient for the channel (email address when channel=email).' },
    { name: 'subject', type: 'string', required: true, description: 'Subject line (email).' },
    { name: 'bodyText', type: 'string', required: true, description: 'Plain-text body, pre-composed. This connector does not interpolate templates.' },
    { name: 'bodyHtml', type: 'string', required: false, description: 'Optional HTML body (email). Text-only when omitted.' },
    { name: 'fromEmail', type: 'string', required: false, description: 'Sender address (email). Falls back to MMC_EMAIL_FROM env.' },
    { name: 'replyTo', type: 'string', required: false, description: 'Optional reply-to address (email).' },
  ],
  outputParams: [
    { name: 'success', type: 'boolean', description: 'True on successful send (or dry-run). False on missing input, unsupported channel, or provider error.' },
    { name: 'messageId', type: 'string', description: "Provider message id. Synthetic 'dry-run-<ts>' in dry-run mode." },
    { name: 'sentAt', type: 'string', description: 'ISO timestamp captured at invocation.' },
    { name: 'error', type: 'string', description: 'Failure reason when success is false (missing input, unsupported channel, or provider error); null on success. Map to a fact to branch to an error scenario.' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['success', 'messageId', 'sentAt', 'error'] }),

  execute: async (_ctx: ConnectorContext, params: Record<string, any>, input: Record<string, any> = {}) => {
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') return params[k];
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
      }
      return undefined;
    };
    const channel = String(pick('channel') || 'email').toLowerCase();
    const to = pick('to', 'toEmail', 'to-email');
    const subject = pick('subject');
    const bodyText = pick('bodyText', 'body-text', 'text');
    const bodyHtml = pick('bodyHtml', 'body-html', 'html');
    const fromEmail = pick('fromEmail', 'from-email', 'from');
    const replyTo = pick('replyTo', 'reply-to');

    if (channel !== 'email') {
      // Only email is implemented; don't pretend other channels delivered.
      return { success: false, messageId: null, sentAt: new Date().toISOString(), error: `unsupported channel: ${channel}` };
    }
    return deliverEmail({ to, subject, bodyText, bodyHtml, from: fromEmail, replyTo });
  },
};
