import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmService } from '../../src/services/llm.js';

vi.mock('@src/utils/logger.js', async () =>
  (await import('../_helpers/loggerMock')).loggerMock(),
);

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

  it('with inScopeFactNames, lists contracted INPUT facts (marks unset ones) and excludes the OUTPUT fact', async () => {
    const fetchSpy = mockFetchOnce({ decision: 'approve' });
    const llm = new LlmService();
    await llm.evaluateInstruction(
      'decide',
      { 'plan-tier': 'gold' }, // input plan-tier set; input customer-id missing; decision is the output
      'decision',
      ['plan-tier', 'customer-id', 'decision', 'plan-tier'], // duplicates tolerated
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const prompt = body.messages[0].content as string;
    // Inputs appear in the inputs table — set ones with values, unset ones marked.
    expect(prompt).toContain('- plan-tier: gold');
    expect(prompt).toContain('- customer-id: (not set)');
    // The output fact must NOT appear in the inputs table — it's something this
    // step PRODUCES, not consumes. Showing it as "(not set)" used to confuse the
    // LLM into reporting it as a missing input.
    expect(prompt).not.toContain('- decision: (not set)');
    expect(prompt).not.toContain('- decision:');
    // …but the output fact must still be named in the OUTPUT FACT clause.
    expect(prompt).toContain('OUTPUT FACT');
    expect(prompt).toContain('"decision"');
    // plan-tier appears once even though we passed it twice — dedup works.
    expect(prompt.match(/- plan-tier:/g)).toHaveLength(1);
    // The missing-facts clause is included whenever inScopeFactNames is non-empty.
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
