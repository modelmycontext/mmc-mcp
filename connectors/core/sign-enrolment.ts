import type { Connector } from '@sdk/connectorTypes.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const UPLOAD_DIR = 'data/files';

/**
 * sign-enrolment — renders a signed enrolment-agreement PDF from the applicant's
 * details + captured signature image, stores it, and returns a tamper-evident
 * hash. This is the producer for the evidence-chain facts on `enrolment-completed`
 * (forms.md blocker 4):
 *   - signed-pdf-url  → a /files URL to the generated PDF
 *   - evidence-hash   → sha256(pdf bytes), hex (tamper-evident)
 *   - rfc3161-token   → a trusted timestamp. HONEST SCOPE: a correct RFC3161 token
 *                       requires a real Time-Stamping Authority (ASN.1 TimeStampReq/
 *                       Resp). Until that integration exists this is returned as
 *                       null with rfc3161Status='not-configured' — NOT a fake token.
 *
 * The PDF is rendered with pdf-lib (pure JS — works under both Node and Bun).
 */
export const signEnrolmentConnector: Connector = {
  name: 'sign-enrolment',
  description:
    'Generates a signed enrolment-agreement PDF embedding the applicant details and signature image, ' +
    'stores it under a reference key, and returns the PDF url plus a sha256 evidence hash. ' +
    'rfc3161Token is returned only when a Time-Stamping Authority is configured (MMC_RFC3161_TSA_URL); ' +
    'otherwise it is null with rfc3161Status="not-configured" (no fake token is produced).',
  inputParams: [
    { name: 'referenceKey', type: 'string', required: true, description: 'Grouping key for the stored PDF (use the applicant id).' },
    { name: 'title', type: 'string', required: false, description: 'Document title (default: "Enrolment Agreement").' },
    { name: 'applicantName', type: 'string', required: false, description: 'Applicant full name, shown prominently.' },
    { name: 'fields', type: 'object', required: false, description: 'Map of label → value rendered as the agreement body (e.g. {"Date of birth":"2008-04-15"}).' },
    { name: 'signatureImage', type: 'string', required: false, description: 'PNG signature as a data URL or bare base64. Embedded into the PDF when present.' },
    { name: 'agreementText', type: 'string', required: false, description: 'Optional agreement/consent paragraph rendered above the signature.' },
  ],
  outputParams: [
    { name: 'signedPdfUrl', type: 'string', description: 'URL path to the stored signed PDF (/files/<key>/<id>.pdf).' },
    { name: 'evidenceHash', type: 'string', description: 'sha256 (hex) of the PDF bytes — tamper-evident.' },
    { name: 'rfc3161Token', type: 'string', description: 'RFC3161 timestamp token (base64), or null when no TSA is configured.' },
    { name: 'rfc3161Status', type: 'string', description: '"issued" | "not-configured" | "error".' },
    { name: 'documentRef', type: 'string', description: 'Stored-file reference (matches the file-store convention).' },
    { name: 'success', type: 'boolean', description: 'False if a required input was missing.' },
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['signedPdfUrl', 'evidenceHash', 'rfc3161Token', 'rfc3161Status', 'documentRef', 'success'] }),

  execute: async (_ctx, params, input) => {
    const pick = (k: string) => (params[k] ?? input[k]);
    const referenceKey = pick('referenceKey');
    if (!referenceKey || typeof referenceKey !== 'string') {
      return { success: false, signedPdfUrl: null, evidenceHash: null, rfc3161Token: null, rfc3161Status: 'error', documentRef: null };
    }
    const title = (pick('title') as string) || 'Enrolment Agreement';
    const applicantName = (pick('applicantName') as string) || '';
    const agreementText = (pick('agreementText') as string) || '';
    const fieldsRaw = pick('fields');
    const fields: Record<string, unknown> =
      fieldsRaw && typeof fieldsRaw === 'object' && !Array.isArray(fieldsRaw) ? fieldsRaw as Record<string, unknown> : {};
    const signatureImage = pick('signatureImage') as string | undefined;

    const pdfBytes = await renderPdf({ title, applicantName, fields, agreementText, signatureImage });

    const digest = crypto.createHash('sha256').update(pdfBytes).digest();
    const evidenceHash = digest.toString('hex');

    // Store the PDF using the same on-disk layout as file-store (sidecar incl.).
    const safeKey = referenceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = crypto.randomUUID();
    const storedName = `${docId}.pdf`;
    const dir = path.resolve(UPLOAD_DIR, safeKey);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, storedName);
    await fs.writeFile(filePath, pdfBytes);
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify({
      documentRef: docId,
      referenceKey,
      originalName: `${title.replace(/[^a-zA-Z0-9_-]+/g, '-')}.pdf`,
      storedName,
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.length,
      evidenceHash,
      storedAt: new Date().toISOString(),
    }, null, 2));

    const signedPdfUrl = `/files/${safeKey}/${storedName}`;

    // RFC3161 trusted timestamp — real TSA call when MMC_RFC3161_TSA_URL is set.
    // Sends a DER TimeStampReq over the PDF's sha256 imprint and stores the
    // returned timeStampToken (base64). No TSA configured ⇒ null /
    // 'not-configured' (we never fabricate a token).
    let rfc3161Token: string | null = null;
    let rfc3161Status = 'not-configured';
    const tsaUrl = process.env.MMC_RFC3161_TSA_URL;
    if (tsaUrl) {
      try {
        const res = await requestRfc3161Token(digest, tsaUrl);
        rfc3161Token = res.token;
        rfc3161Status = res.status;
      } catch {
        rfc3161Token = null;
        rfc3161Status = 'error';
      }
    }

    return { success: true, signedPdfUrl, evidenceHash, rfc3161Token, rfc3161Status, documentRef: docId };
  },
};

/** Decode a PNG signature given as a data URL or bare base64. Returns null if absent/unparseable. */
function decodePng(signatureImage: string | undefined): Buffer | null {
  if (!signatureImage || typeof signatureImage !== 'string') return null;
  const m = signatureImage.match(/^data:image\/png;base64,(.*)$/);
  const b64 = m ? m[1] : signatureImage;
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

interface RenderArgs {
  title: string;
  applicantName: string;
  fields: Record<string, unknown>;
  agreementText: string;
  signatureImage?: string;
}

/** Render a single-page A4 PDF and return its bytes. Exported for testing. */
export async function renderPdf(args: RenderArgs): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(args.title);
  const page = doc.addPage([595.28, 841.89]); // A4 portrait (pt)
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.047, 0.165, 0.263);
  const grey = rgb(0.4, 0.4, 0.4);

  const margin = 54;
  let y = 841.89 - margin;
  const draw = (text: string, opts: { size?: number; bold?: boolean; color?: any; gap?: number } = {}) => {
    const size = opts.size ?? 11;
    page.drawText(text, { x: margin, y, size, font: opts.bold ? fontBold : font, color: opts.color ?? navy });
    y -= (opts.gap ?? size + 8);
  };

  draw(args.title, { size: 20, bold: true, gap: 30 });
  if (args.applicantName) draw(args.applicantName, { size: 14, bold: true, gap: 26 });

  for (const [label, value] of Object.entries(args.fields)) {
    if (value === undefined || value === null || value === '') continue;
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    page.drawText(`${label}:`, { x: margin, y, size: 10, font: fontBold, color: grey });
    page.drawText(v.slice(0, 90), { x: margin + 150, y, size: 10, font, color: navy });
    y -= 20;
  }

  if (args.agreementText) {
    y -= 14;
    for (const line of wrap(args.agreementText, 95)) draw(line, { size: 9.5, color: grey, gap: 14 });
  }

  // Signature block
  y -= 24;
  draw('Signature:', { size: 10, bold: true, gap: 8 });
  const png = decodePng(args.signatureImage);
  if (png) {
    try {
      const img = await doc.embedPng(png);
      const w = 200;
      const h = (img.height / img.width) * w;
      const drawH = Math.min(h, 90);
      const drawW = (img.width / img.height) * drawH;
      page.drawImage(img, { x: margin, y: y - drawH, width: drawW, height: drawH });
      y -= drawH + 6;
    } catch {
      draw('[signature image could not be embedded]', { size: 9, color: grey });
    }
  } else {
    draw('[no signature provided]', { size: 9, color: grey });
  }
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 220, y }, thickness: 0.75, color: grey });
  y -= 14;
  draw(`Generated ${new Date().toISOString()}`, { size: 8, color: grey });

  return Buffer.from(await doc.save());
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { if (line) lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

// ── RFC-3161 trusted timestamp (Time-Stamp Protocol) ────────────────────────
// Dependency-free client: builds a DER TimeStampReq over a sha256 message
// imprint, POSTs it to a Time-Stamping Authority, and returns the base64
// timeStampToken from the TimeStampResp. We faithfully store the token the TSA
// issues; validating the TSA's own signature is a separate verification-time
// concern and is intentionally out of scope here.

/** DER definite-form length. */
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** DER TLV: tag + length + content. */
function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

/** DER INTEGER from a positive big-endian magnitude (kept positive per X.690). */
function derPositiveInt(magnitude: Buffer): Buffer {
  let m = magnitude.length === 0 ? Buffer.from([0]) : magnitude;
  let i = 0;
  while (i < m.length - 1 && m[i] === 0) i++; // strip leading zeros, keep ≥1 byte
  m = m.subarray(i);
  if (m[0] & 0x80) m = Buffer.concat([Buffer.from([0]), m]);
  return der(0x02, m);
}

// AlgorithmIdentifier for sha-256: SEQUENCE(0x0d) { OID 2.16.840.1.101.3.4.2.1, NULL }.
// SEQUENCE length is 0x0d (13) = OID TLV (11) + NULL (2). Verified byte-for-byte
// against `openssl ts -query -sha256`.
const SHA256_ALG_ID = Buffer.from([
  0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00,
]);

/** Build a DER-encoded RFC-3161 TimeStampReq for a sha256 digest. Exported for testing. */
export function buildTimeStampReq(digest: Buffer, nonce: Buffer): Buffer {
  const messageImprint = der(0x30, Buffer.concat([SHA256_ALG_ID, der(0x04, digest)]));
  const version = derPositiveInt(Buffer.from([1]));
  const nonceInt = derPositiveInt(nonce);
  const certReq = Buffer.from([0x01, 0x01, 0xff]); // BOOLEAN TRUE — return the TSA cert
  return der(0x30, Buffer.concat([version, messageImprint, nonceInt, certReq]));
}

/** Minimal DER TLV reader. */
function readTlv(buf: Buffer, offset: number): { tag: number; contentStart: number; contentEnd: number; end: number } {
  const tag = buf[offset];
  let p = offset + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  return { tag, contentStart: p, contentEnd: p + len, end: p + len };
}

/**
 * Parse a TimeStampResp: SEQUENCE { PKIStatusInfo, timeStampToken OPTIONAL }.
 * Returns the PKIStatus code and the raw timeStampToken DER (when granted).
 * Exported for testing.
 */
export function parseTimeStampResp(resp: Buffer): { statusCode: number; token: Buffer | null } {
  const outer = readTlv(resp, 0);                          // TimeStampResp SEQUENCE
  const statusInfo = readTlv(resp, outer.contentStart);    // PKIStatusInfo SEQUENCE
  const statusInt = readTlv(resp, statusInfo.contentStart); // PKIStatus INTEGER
  let statusCode = 0;
  for (let i = statusInt.contentStart; i < statusInt.contentEnd; i++) statusCode = (statusCode << 8) | resp[i];
  let token: Buffer | null = null;
  if (statusInfo.end < outer.contentEnd) {                 // optional timeStampToken present
    const tok = readTlv(resp, statusInfo.end);
    token = resp.subarray(statusInfo.end, tok.end);
  }
  return { statusCode, token };
}

/**
 * Request a trusted timestamp for a sha256 digest from an RFC-3161 TSA.
 * Returns the base64 timeStampToken + status ('issued' | 'error'). Exported so
 * a live smoke test can exercise it against a real TSA.
 */
export async function requestRfc3161Token(digest: Buffer, tsaUrl: string): Promise<{ token: string | null; status: string }> {
  const nonce = crypto.randomBytes(8);
  const reqDer = buildTimeStampReq(digest, nonce);
  const resp = await fetch(tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: reqDer,
  });
  if (!resp.ok) return { token: null, status: 'error' };
  const respBuf = Buffer.from(await resp.arrayBuffer());
  const { statusCode, token } = parseTimeStampResp(respBuf);
  if ((statusCode === 0 || statusCode === 1) && token) {   // 0 granted, 1 grantedWithMods
    return { token: token.toString('base64'), status: 'issued' };
  }
  return { token: null, status: 'error' };
}
