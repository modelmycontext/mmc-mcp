import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonWriteConnector } from '../../connectors/core/json-write.js';

// Minimal JsonDataSource stand-in mirroring the real one: read() throws when the
// collection file is absent, write() persists JSON. Lets us assert the actual
// stored record.
function makeCtx(dataDir: string) {
  const fileFor = (c: string) => path.join(dataDir, `${c}.json`);
  return {
    dataSources: {
      json: {
        async read(collection: string): Promise<any[]> {
          // Mirror the REAL JsonDataSource: throw on a missing collection file.
          // (A lenient `return []` here would mask json-write's need to create a
          // new collection on first write.)
          if (!fs.existsSync(fileFor(collection))) {
            throw new Error(`Collection "${collection}" not found.`);
          }
          return JSON.parse(fs.readFileSync(fileFor(collection), 'utf8'));
        },
        async write(collection: string, data: any[]): Promise<void> {
          fs.writeFileSync(fileFor(collection), JSON.stringify(data, null, 2));
        },
      },
    },
  } as any;
}

describe('json-write — record sourcing', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-jsonwrite-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('builds the record from resolved PARAMS (automation-job path, input={})', async () => {
    // This is exactly how the Automation path calls it: resolveJobParams folds
    // the job's inputMappings into top-level `params`, and the executor invokes
    // the connector with `input = {}`. Before the fix the record came only from
    // `input`, so this wrote an empty record (success:false).
    const ctx = makeCtx(dir);
    const params = {
      collection: 'enrolment-records',
      upsert: true,
      idField: 'applicant-id',
      'applicant-id': 'APP-2026-0614',
      'applicant-name': 'Aria Whitcombe',
      'application-form': { 'full-name': 'Aria Whitcombe', 'signature-png': 'data:image/png;base64,AAAA' },
      'signed-pdf-url': '/files/APP-2026-0614/x.pdf',
      'evidence-hash': 'abc123',
    };
    const res: any = await jsonWriteConnector.execute(ctx, params, {});
    expect(res.success).toBe(true);

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'enrolment-records.json'), 'utf8'));
    expect(stored).toHaveLength(1);
    const rec = stored[0];
    expect(rec['applicant-id']).toBe('APP-2026-0614');
    expect(rec['applicant-name']).toBe('Aria Whitcombe');
    expect(rec['signed-pdf-url']).toBe('/files/APP-2026-0614/x.pdf');
    expect(rec['evidence-hash']).toBe('abc123');
    // Composite fact persists as a nested object.
    expect(rec['application-form']['full-name']).toBe('Aria Whitcombe');
    // Static config keys must NOT leak into the record.
    expect(rec.collection).toBeUndefined();
    expect(rec.idField).toBeUndefined();
    expect(rec.upsert).toBeUndefined();
  });

  it('upserts by idField on a second write (same applicant-id)', async () => {
    const ctx = makeCtx(dir);
    const base = { collection: 'enrolment-records', upsert: true, idField: 'applicant-id', 'applicant-id': 'APP-1' };
    await jsonWriteConnector.execute(ctx, { ...base, 'applicant-name': 'First' }, {});
    await jsonWriteConnector.execute(ctx, { ...base, 'applicant-name': 'Updated' }, {});
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'enrolment-records.json'), 'utf8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]['applicant-name']).toBe('Updated');
  });

  it('still builds the record from input (interface/complete-slice path)', async () => {
    const ctx = makeCtx(dir);
    const res: any = await jsonWriteConnector.execute(
      ctx,
      { collection: 'members', upsert: true, idField: 'id' },
      { id: 'm-1', name: 'Jo' },
    );
    expect(res.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8'));
    expect(stored[0]).toEqual({ id: 'm-1', name: 'Jo' });
  });

  it('returns success:false when there is nothing to write', async () => {
    const ctx = makeCtx(dir);
    const res: any = await jsonWriteConnector.execute(ctx, { collection: 'empty', upsert: true, idField: 'id' }, {});
    expect(res.success).toBe(false);
  });
});
