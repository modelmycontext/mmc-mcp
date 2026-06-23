import {createHmac, timingSafeEqual} from 'node:crypto';

/**
 * Compact HMAC-signed bearer-token format used for form jtis.
 *
 *   <base64url(payloadJSON)>.<base64url(sig)>
 *
 * The payload is a self-contained routing envelope — correlationId + eventType +
 * templateId + expiry. mmc-mcp's webhook verifies the signature and extracts
 * the payload; it never queries any forms-specific store. The signing key is
 * a shared secret between whoever mints (workbench) and whoever consumes
 * (mmc-mcp's webhook).
 *
 * Why not full JWT? No alg negotiation, no header — simpler is harder to
 * misuse. The format is fixed: HMAC-SHA256, payload encoding is JSON. If we
 * need rotation or alg agility later, switch to JWT then.
 */

export interface JtiPayload {
  /**
   * The mmc-mcp workflow-instance id (`correlationId`) this form is bound to.
   * The webhook stamps it onto the inbound event so the submission rejoins the
   * exact instance that minted the link — across the transport hop, with no
   * dependency on any session (workflow-instance-isolation RFC D4). Was
   * `sessionId`.
   */
  correlationId: string;
  /** Event type to publish on the instance's bus when the webhook fires. */
  eventType: string;
  /** Workbench-side FormTemplate id (opaque to mmc-mcp). */
  templateId: string;
  /** Unix epoch milliseconds. */
  exp: number;
  /** Optional extra fields the mint side wants the subscriber to receive. */
  extras?: Record<string, unknown>;
}

const b64urlEncode = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (str: string): Buffer => {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
};

export type VerifyResult =
  | {ok: true; payload: JtiPayload}
  | {ok: false; reason: 'malformed' | 'bad-signature' | 'expired'; message: string};

/** Verify a jti string. Returns the decoded payload or a structured error. */
export function verifyJti(jti: string, key: string): VerifyResult {
  if (!jti || typeof jti !== 'string') {
    return {ok: false, reason: 'malformed', message: 'Empty token.'};
  }
  const dot = jti.indexOf('.');
  if (dot < 1 || dot === jti.length - 1) {
    return {ok: false, reason: 'malformed', message: 'Token is not in payload.sig format.'};
  }
  const payloadB64 = jti.slice(0, dot);
  const sigB64 = jti.slice(dot + 1);

  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return {ok: false, reason: 'malformed', message: 'Signature is not valid base64url.'};
  }
  const expectedSig = createHmac('sha256', key).update(payloadB64).digest();
  if (providedSig.length !== expectedSig.length) {
    return {ok: false, reason: 'bad-signature', message: 'Signature length mismatch.'};
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return {ok: false, reason: 'bad-signature', message: 'Signature does not match.'};
  }

  let payload: JtiPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    return {ok: false, reason: 'malformed', message: 'Payload is not valid JSON.'};
  }
  if (!payload.correlationId || !payload.eventType || typeof payload.exp !== 'number') {
    return {ok: false, reason: 'malformed', message: 'Payload missing required fields.'};
  }
  if (Date.now() > payload.exp) {
    return {ok: false, reason: 'expired', message: 'Token has expired.'};
  }

  return {ok: true, payload};
}

/** Sign a payload — exported for tests; production mint happens on the workbench side. */
export function signJti(payload: JtiPayload, key: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig = createHmac('sha256', key).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}
