import { describe, it, expect, vi } from 'vitest';
import { executeViewSlice } from '../../src/services/viewSliceRunner.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

function makeViewSlice(opts: {
  name?: string;
  queries?: any[];
  facts?: any[];
} = {}) {
  return {
    id: 'slice-view',
    name: opts.name ?? 'view-thing',
    queries: opts.queries ?? [],
    facts: opts.facts ?? [],
  };
}

function makeFactIdToName(pairs: Array<[string, string]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, name] of pairs) m.set(id, name);
  return m;
}

describe('executeViewSlice', () => {
  it('runs a single query job and returns its declared facts as the projection', async () => {
    const executeConnector = vi.fn().mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    const slice = makeViewSlice({
      queries: [{
        id: 'q1',
        name: 'list-rows',
        facts: [{ id: 'f-rows', name: 'rows' }],
        jobLink: {
          job: { id: 'j1', name: 'list-rows', toolId: 'list-tool' },
          inputMappings: { collection: '@collection-name' },
          outputMappings: { rows: '@rows' },
          returnedFact: { id: 'f-rows', name: 'rows' },
        },
      }],
      facts: [{ id: 'f-rows', name: 'rows' }],
    });
    const factIdToName = makeFactIdToName([['f-rows', 'rows'], ['f-collection-name', 'collection-name']]);

    const { projection, errors } = await executeViewSlice(
      slice,
      factIdToName,
      { 'collection-name': 'orders' },
      { executeConnector },
    );

    expect(executeConnector).toHaveBeenCalledWith(
      'list-tool',
      expect.objectContaining({ collection: 'orders' }),
      undefined,
    );
    expect(projection).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
    expect(errors).toEqual([]);
  });

  it('runs multiple queries and aggregates their facts into one projection', async () => {
    const executeConnector = vi.fn()
      .mockResolvedValueOnce({ rows: [1, 2, 3] })
      .mockResolvedValueOnce({ count: 42 });
    const slice = makeViewSlice({
      queries: [
        {
          id: 'q1', name: 'rows-q', facts: [{ id: 'f-rows', name: 'rows' }],
          jobLink: { job: { id: 'j1', name: 'rows', toolId: 'tool-a' }, outputMappings: { rows: '@rows' }, returnedFact: { id: 'f-rows', name: 'rows' } },
        },
        {
          id: 'q2', name: 'count-q', facts: [{ id: 'f-count', name: 'count' }],
          jobLink: { job: { id: 'j2', name: 'count', toolId: 'tool-b' }, outputMappings: { count: '@count' }, returnedFact: { id: 'f-count', name: 'count' } },
        },
      ],
    });
    const factIdToName = makeFactIdToName([['f-rows', 'rows'], ['f-count', 'count']]);

    const { projection, errors } = await executeViewSlice(slice, factIdToName, {}, { executeConnector });

    expect(projection).toEqual({ rows: [1, 2, 3], count: 42 });
    expect(errors).toEqual([]);
  });

  it('captures query failure as an error and continues with partial projection', async () => {
    const executeConnector = vi.fn()
      .mockRejectedValueOnce(new Error('connector down'))
      .mockResolvedValueOnce({ ok: true });
    const slice = makeViewSlice({
      queries: [
        {
          id: 'q1', name: 'broken', facts: [{ id: 'f-rows', name: 'rows' }],
          jobLink: { job: { id: 'j1', name: 'broken', toolId: 'tool-a' }, outputMappings: { rows: '@rows' }, returnedFact: { id: 'f-rows', name: 'rows' } },
        },
        {
          id: 'q2', name: 'ok', facts: [{ id: 'f-ok', name: 'ok' }],
          jobLink: { job: { id: 'j2', name: 'ok', toolId: 'tool-b' }, outputMappings: { ok: '@ok' }, returnedFact: { id: 'f-ok', name: 'ok' } },
        },
      ],
    });
    const factIdToName = makeFactIdToName([['f-rows', 'rows'], ['f-ok', 'ok']]);

    const { projection, errors } = await executeViewSlice(slice, factIdToName, {}, { executeConnector });

    expect(projection).toEqual({ ok: true }); // first query failed, second succeeded
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ tool: 'tool-a', name: 'broken', error: 'connector down' });
  });

  it('only includes facts from the slice contract in the projection (caller args do not leak)', async () => {
    const executeConnector = vi.fn().mockResolvedValue({ rows: ['a'] });
    const slice = makeViewSlice({
      queries: [{
        id: 'q1', name: 'rows-q', facts: [{ id: 'f-rows', name: 'rows' }],
        jobLink: { job: { id: 'j1', name: 'rows', toolId: 'tool' }, outputMappings: { rows: '@rows' }, returnedFact: { id: 'f-rows', name: 'rows' } },
      }],
    });
    const factIdToName = makeFactIdToName([['f-rows', 'rows']]);
    // Caller passes a fact the slice does NOT declare — must not appear in
    // the projection.
    const { projection } = await executeViewSlice(slice, factIdToName, { 'secret-key': 's3cr3t' }, { executeConnector });
    expect(projection).toEqual({ rows: ['a'] });
    expect(projection).not.toHaveProperty('secret-key');
  });

  it('throws when called on a non-View slice', async () => {
    const automationSlice = {
      id: 'a',
      name: 'auto',
      command: { name: 'do-it' }, // command present → automation
      queries: [],
    };
    await expect(
      executeViewSlice(automationSlice, new Map(), {}, { executeConnector: vi.fn() }),
    ).rejects.toThrow(/non-View slice/);
  });
});
