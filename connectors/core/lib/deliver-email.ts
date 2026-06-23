import { logger } from '@src/utils/logger.js';

/**
 * Shared transactional-email delivery (Resend), used by send-email,
 * send-notification (channel=email) and send-eform-link. Centralises the
 * dry-run policy and the MMC_EMAIL_FROM fallback so the connectors stay thin.
 *
 * Dry-run is the safe default in dev: when `MMC_EMAIL_DRY_RUN=true` OR
 * `RESEND_API_KEY` is unset, returns a synthetic messageId without contacting
 * Resend. Side-effecting and non-idempotent on a live send — callers must
 * invoke as a Command Job (at-most-once), never a Query Job.
 */
export interface DeliverEmailInput {
  to?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  from?: string;
  replyTo?: string;
}

export interface DeliverResult {
  success: boolean;
  messageId: string | null;
  sentAt: string;
  /**
   * Failure reason when `success === false`; `null` on success. Exposed (not
   * just logged) so a slice can map it to a fact and branch to an error
   * scenario. Always a present key — `null`, never omitted — so a downstream
   * `outputMapping` that maps `error` is never seen as a "field not returned"
   * fatal on a successful send (mirrors `messageId`).
   */
  error: string | null;
}

export const isEmailDryRun = (): boolean =>
  process.env.MMC_EMAIL_DRY_RUN === 'true' || !process.env.RESEND_API_KEY;

export async function deliverEmail(i: DeliverEmailInput): Promise<DeliverResult> {
  const sentAt = new Date().toISOString();
  const from = i.from || process.env.MMC_EMAIL_FROM;

  if (!i.to || !i.subject || !i.bodyText || !from) {
    const missing = [
      !i.to && 'to', !i.subject && 'subject', !i.bodyText && 'bodyText', !from && 'from',
    ].filter(Boolean).join(', ');
    logger.warn(
      { hasTo: !!i.to, hasSubject: !!i.subject, hasBody: !!i.bodyText, hasFrom: !!from },
      '[deliver-email] missing required input — not sending',
    );
    return { success: false, messageId: null, sentAt, error: `missing required input: ${missing}` };
  }

  if (isEmailDryRun()) {
    return { success: true, messageId: `dry-run-${Date.now()}`, sentAt, error: null };
  }

  try {
    // Lazy import so dry-run / test paths don't pay the SDK load cost.
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY!);
    const result: any = await resend.emails.send({
      from,
      to: i.to,
      subject: i.subject,
      text: i.bodyText,
      ...(i.bodyHtml ? { html: i.bodyHtml } : {}),
      ...(i.replyTo ? { replyTo: i.replyTo } : {}),
    });
    if (result?.error) {
      const e = result.error;
      const errMsg = typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e));
      logger.warn({ to: i.to, from, error: result.error }, '[deliver-email] Resend rejected the send');
      return { success: false, messageId: null, sentAt, error: errMsg };
    }
    logger.info({ to: i.to, from, messageId: result?.data?.id ?? null }, '[deliver-email] sent');
    return { success: true, messageId: result?.data?.id ?? null, sentAt, error: null };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    logger.error({ to: i.to, from, error: errMsg }, '[deliver-email] threw during live send');
    return { success: false, messageId: null, sentAt, error: errMsg };
  }
}
