import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateApplicationIdConnector } from '../../connectors/core/generate-application-id.js';

// JsonDataSource stand-in mirroring the real one: read() throws on a missing
// collection, write() persists — so we exercise first-mint creation + the
// persisted per-year counter across calls.
function makeCtx(dataDir: string) {
  const fileFor = (c: string) => path.join(dataDir, `${c}.json`);
  return {
    dataSources: {
      json: {
        async read(collection: string): Promise<any[]> {
          if (!fs.existsSync(fileFor(collection))) throw new Error(`Collection "${collection}" not found.`);
          return JSON.parse(fs.readFileSync(fileFor(collection), 'utf8'));
        },
        async write(collection: string, data: any[]): Promise<void> {
          fs.writeFileSync(fileFor(collection), JSON.stringify(data, null, 2));
        },
      },
    },
  } as any;
}

describe('generate-application-id', () => {
  let dir: string;
  const YEAR = new Date().getFullYear().toString(); // connector uses currentLocalDate()'s year

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-genappid-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('mints APP-<year>-001 on first call and increments the persisted counter', async () => {
    const ctx = makeCtx(dir);
    const a: any = await generateApplicationIdConnector.execute(ctx, {}, {});
    expect(a.success).toBe(true);
    expect(a.applicationId).toBe(`APP-${YEAR}-001`);
    expect(a.sequence).toBe(1);

    const b: any = await generateApplicationIdConnector.execute(ctx, {}, {});
    expect(b.applicationId).toBe(`APP-${YEAR}-002`);
    expect(b.sequence).toBe(2);

    // Counter persisted in the collection file.
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'application-id-counters.json'), 'utf8'));
    expect(rows).toEqual([{ year: YEAR, count: 2 }]);
  });

  it('honours a custom prefix and pad width', async () => {
    const ctx = makeCtx(dir);
    const r: any = await generateApplicationIdConnector.execute(ctx, { prefix: 'ENR', pad: 5 }, {});
    expect(r.applicationId).toBe(`ENR-${YEAR}-00001`);
  });

  it('continues an existing year counter rather than resetting', async () => {
    fs.writeFileSync(path.join(dir, 'application-id-counters.json'), JSON.stringify([{ year: YEAR, count: 41 }]));
    const ctx = makeCtx(dir);
    const r: any = await generateApplicationIdConnector.execute(ctx, {}, {});
    expect(r.applicationId).toBe(`APP-${YEAR}-042`);
    expect(r.sequence).toBe(42);
  });
});
