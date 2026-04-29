import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmService } from '../../src/services/llm.js';

vi.mock('@src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const originalFetch = globalThis.fetch;

function mockFetchOnce(json: unknown) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }),
  });
  (globalThis as any).fetch = fetchSpy;
  return fetchSpy;
}

describe('LlmService.evaluateInstruction', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_MODEL = 'test-model';
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  it('returns {} when env credentials are missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const llm = new LlmService();
    const result = await llm.evaluateInstruction('do thing', { x: 1 }, 'y');
    expect(result).toEqual({});
  });

  it('without inScopeFactNames, lists exactly the keys from the facts argument', async () => {
    const fetchSpy = mockFetchOnce({ result: 'ok' });
    const llm = new LlmService();
    await llm.evaluateInstruction(
      'decide',
      { 'plan-tier': 'gold', 'customer': { name: 'Alice' } },
      'decision',
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('- plan-tier: gold');
    expect(prompt).toContain('- customer: ');
    expect(prompt).not.toContain('(not set)');
    expect(prompt).not.toContain('_missingFacts');
  });

  it('with inScopeFactNames, lists every contracted fact and marks unset ones (not set)', async () => {
    const fetchSpy = mockFetchOnce({ decision: 'approve' });
    const llm = new LlmService();
    await llm.evaluateInstruction(
      'decide',
      { 'plan-tier': 'gold' }, // `decision` is in scope but unset
      'decision',
      ['plan-tier', 'decision', 'plan-tier'], // duplicates tolerated
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('- plan-tier: gold');
    expect(prompt).toContain('- decision: (not set)');
    // plan-tier appears once even though we passed it twice — dedup works.
    expect(prompt.match(/- plan-tier:/g)).toHaveLength(1);
    // The missing-facts clause is included.
    expect(prompt).toContain('_missingFacts');
    expect(prompt).toContain('do NOT guess');
  });

  it('omits the missing-facts clause when inScopeFactNames is undefined or empty', async () => {
    const fetchSpy = mockFetchOnce({});
    const llm = new LlmService();
    await llm.evaluateInstruction('decide', { x: 1 }, 'y');
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).messages[0].content as string;
    expect(prompt).not.toContain('_missingFacts');

    const fetchSpy2 = mockFetchOnce({});
    await llm.evaluateInstruction('decide', { x: 1 }, 'y', []);
    const prompt2 = JSON.parse(fetchSpy2.mock.calls[0][1].body).messages[0].content as string;
    expect(prompt2).not.toContain('_missingFacts');
  });

  it('parses valid JSON responses including markdown-fenced blocks', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '```json\n{"decision":"approve"}\n```' } }] }),
    });
    (globalThis as any).fetch = fetchSpy;
    const llm = new LlmService();
    const result = await llm.evaluateInstruction('decide', {}, 'decision');
    expect(result).toEqual({ decision: 'approve' });
  });
});
