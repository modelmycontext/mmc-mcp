import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { signEnrolmentConnector, renderPdf, buildTimeStampReq, parseTimeStampResp } from '../../connectors/core/sign-enrolment.js';

// Tiny short-form DER builder for crafting test TSA responses (lengths < 128).
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag, content.length]), content]);
const grantedResp = (token: Buffer) =>
  tlv(0x30, Buffer.concat([tlv(0x30, tlv(0x02, Buffer.from([0]))), token])); // SEQ{ SEQ{INT 0}, token }

// A 1x1 transparent PNG (valid) for signature-embed coverage.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const ctx: any = { eventBus: { publish: async () => {} }, dataSources: {}, tools: {} };

describe('renderPdf', () => {
  it('produces valid PDF bytes (with and without a signature)', async () => {
    const withSig = await renderPdf({
      title: 'Enrolment Agreement', applicantName: 'Aria Whitcombe',
      fields: { 'Date of birth': '2008-04-15', Email: 'aria@example.nz' },
      agreementText: 'I confirm the details above are correct.',
      signatureImage: `data:image/png;base64,${PNG_1x1}`,
    });
    expect(withSig.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // PDF magic
    expect(withSig.length).toBeGreaterThan(800);

    const noSig = await renderPdf({ title: 'X', applicantName: '', fields: {}, agreementText: '' });
    expect(noSig.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('sign-enrolment connector', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mmc-sign-'));
    process.chdir(tmp); // UPLOAD_DIR is 'data/files' relative to cwd
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MMC_RFC3161_TSA_URL;
  });

  it('stores a PDF and returns a deterministic evidence hash + url', async () => {
    const res: any = await signEnrolmentConnector.execute(ctx, {
      referenceKey: 'APP-2026-0613',
      applicantName: 'Aria Whitcombe',
      fields: { Email: 'aria@example.nz' },
      signatureImage: PNG_1x1,
    }, {});

    expect(res.success).toBe(true);
    expect(res.signedPdfUrl).toMatch(/^\/files\/APP-2026-0613\/[0-9a-f-]+\.pdf$/);
    expect(res.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.rfc3161Token).toBeNull();
    expect(res.rfc3161Status).toBe('not-configured');

    // The stored file exists, is a PDF, and its bytes hash to evidenceHash.
    const stored = path.join(tmp, 'data', 'files', 'APP-2026-0613', `${res.documentRef}.pdf`);
    expect(fs.existsSync(stored)).toBe(true);
    const bytes = fs.readFileSync(stored);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(res.evidenceHash);

    // Sidecar metadata carries the hash + mime.
    const meta = JSON.parse(fs.readFileSync(`${stored}.meta.json`, 'utf8'));
    expect(meta.mimeType).toBe('application/pdf');
    expect(meta.evidenceHash).toBe(res.evidenceHash);
  });

  it('sanitises the reference key into the storage path', async () => {
    const res: any = await signEnrolmentConnector.execute(ctx, { referenceKey: 'a/b ../c' }, {});
    expect(res.success).toBe(true);
    // The key segment is sanitised to [a-zA-Z0-9_-] only — no separators or
    // ".." survive, so the regex matching the whole URL proves no traversal.
    expect(res.signedPdfUrl).toMatch(/^\/files\/[a-zA-Z0-9_-]+\/[0-9a-f-]+\.pdf$/);
  });

  it('fails closed when referenceKey is missing', async () => {
    const res: any = await signEnrolmentConnector.execute(ctx, {}, {});
    expect(res.success).toBe(false);
    expect(res.signedPdfUrl).toBeNull();
  });

  it('issues a real rfc3161 token when the TSA grants one', async () => {
    process.env.MMC_RFC3161_TSA_URL = 'https://tsa.example/timestamp';
    const token = tlv(0x30, Buffer.from('cafebabe', 'hex')); // stand-in ContentInfo
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(grantedResp(token), { status: 200 }),
    );
    try {
      const res: any = await signEnrolmentConnector.execute(ctx, { referenceKey: 'k', signatureImage: PNG_1x1 }, {});
      expect(res.rfc3161Status).toBe('issued');
      expect(res.rfc3161Token).toBe(token.toString('base64'));
      // the TSA was called with an RFC-3161 query carrying the PDF's sha256 imprint
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      expect((init as any).headers['Content-Type']).toBe('application/timestamp-query');
      const sentHex = Buffer.from((init as any).body).toString('hex');
      expect(sentHex).toContain('0420' + res.evidenceHash); // OCTET STRING(32) = the imprint
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never fabricates a token — TSA failure yields error/null, not a fake', async () => {
    process.env.MMC_RFC3161_TSA_URL = 'https://tsa.example/timestamp';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));
    try {
      const res: any = await signEnrolmentConnector.execute(ctx, { referenceKey: 'k' }, {});
      expect(res.success).toBe(true);          // signing/storage still succeeds
      expect(res.rfc3161Token).toBeNull();
      expect(res.rfc3161Status).toBe('error');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('RFC-3161 DER codec', () => {
  const digest = crypto.createHash('sha256').update('hello').digest();

  it('buildTimeStampReq emits a well-formed TimeStampReq', () => {
    const req = buildTimeStampReq(digest, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    expect(req[0]).toBe(0x30); // SEQUENCE
    const hex = req.toString('hex');
    expect(hex).toContain('020101');                              // version INTEGER 1
    expect(hex).toContain('300d06096086480165030402010500');      // sha256 AlgorithmIdentifier (openssl-verified)
    expect(hex).toContain('0420' + digest.toString('hex'));       // messageImprint hashedMessage
    expect(hex).toContain('0101ff');                              // certReq BOOLEAN TRUE
  });

  it('parseTimeStampResp extracts the token on granted, null on rejection', () => {
    const token = tlv(0x30, Buffer.from('deadbeef', 'hex'));
    const granted = parseTimeStampResp(grantedResp(token));
    expect(granted.statusCode).toBe(0);
    expect(granted.token?.equals(token)).toBe(true);

    const rejected = parseTimeStampResp(tlv(0x30, tlv(0x30, tlv(0x02, Buffer.from([2])))));
    expect(rejected.statusCode).toBe(2);
    expect(rejected.token).toBeNull();
  });
});
