import type { Connector, ConnectorContext } from '@sdk/connectorTypes.js';
import { deliverEmail } from './lib/deliver-email.js';

/**
 * Transactional-email connector backed by Resend.
 *
 * DEPRECATED — prefer `send-notification` (generic, channel-agnostic) or
 * `send-eform-link` (form-link sender). Kept registered for backward
 * compatibility with models that still reference `send-email`; delivery logic
 * is shared via `deliverEmail()`.
 *
 * Side-effecting / non-idempotent on a live send — invoke as a Command Job.
 * Dry-run (MMC_EMAIL_DRY_RUN=true OR no RESEND_API_KEY) returns a synthetic
 * messageId without contacting Resend.
 */
export const sendEmailConnector: Connector = {
  name: 'send-email',
  description:
    "Sends a transactional email via Resend (one-shot). DEPRECATED — prefer send-notification (generic) or " +
    "send-eform-link (form links). Caller supplies a composed body; does not template. Returns { success, " +
    "messageId, sentAt, error }. `error` carries the failure reason (null on success). Dry-run " +
    "(MMC_EMAIL_DRY_RUN=true OR no RESEND_API_KEY) returns a synthetic messageId.",
  inputParams: [
    { name: "toEmail", type: "string", required: true, description: "Recipient email address." },
    { name: "subject", type: "string", required: true, description: "Email subject line." },
    { name: "bodyText", type: "string", required: true, description: "Plain-text body, pre-composed — this connector does not interpolate templates." },
    { name: "bodyHtml", type: "string", required: false, description: "Optional HTML body. Resend renders text-only when omitted." },
    { name: "fromEmail", type: "string", required: false, description: "Sender address. Falls back to MMC_EMAIL_FROM env. Must be on a Resend-verified domain for live sends." },
    { name: "replyTo", type: "string", required: false, description: "Optional reply-to address." },
  ],
  outputParams: [
    { name: "success", type: "boolean", description: "True on successful send (or dry-run). False on missing input or provider error." },
    { name: "messageId", type: "string", description: "Provider-issued message id. Synthetic 'dry-run-<ts>' in dry-run mode." },
    { name: "sentAt", type: "string", description: "ISO timestamp captured at invocation. Present even on failure for diagnostics." },
    { name: "error", type: "string", description: "Failure reason when success is false (missing input or provider error); null on success. Map to a fact to branch to an error scenario." },
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
    return deliverEmail({
      to: pick('toEmail', 'to-email', 'to'),
      subject: pick('subject'),
      bodyText: pick('bodyText', 'body-text', 'text'),
      bodyHtml: pick('bodyHtml', 'body-html', 'html'),
      from: pick('fromEmail', 'from-email', 'from'),
      replyTo: pick('replyTo', 'reply-to'),
    });
  },
};
