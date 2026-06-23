import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mountChatProxyRoute, toOpenAiMessages } from '../../src/server/chatProxy.js';

function buildApp() {
  const app = new Hono();
  mountChatProxyRoute(app);
  return app;
}

describe('toOpenAiMessages', () => {
  it('prepends a system message when present', () => {
    expect(toOpenAiMessages([], 'be nice')[0]).toEqual({ role: 'system', content: 'be nice' });
    expect(toOpenAiMessages([], undefined)).toEqual([]);
  });

  it('maps a tool_result block to an OpenAI tool message', () => {
    const out = toOpenAiMessages(
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'OK' }] }],
      undefined,
    );
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'OK' }]);
  });

  it('stringifies non-string tool_result content', () => {
    const out = toOpenAiMessages(
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: { a: 1 } }] }],
      undefined,
    );
    expect(out[0].content).toBe('{"a":1}');
  });

  it('maps assistant tool_use blocks to OpenAI tool_calls with JSON args', () => {
    const out = toOpenAiMessages(
      [{ role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call_9', name: 'find-json-record', input: { q: 'x' } },
      ] }],
      undefined,
    );
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'calling',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'find-json-record', arguments: '{"q":"x"}' } }],
    });
  });

  it('passes through plain string-content messages', () => {
    expect(toOpenAiMessages([{ role: 'user', content: 'hi' }], undefined))
      .toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('POST /api/chat', () => {
  const origKey = process.env.OPENROUTER_API_KEY;
  const origAlt = process.env.OPEN_ROUTER_API_KEY;
  const origModel = process.env.OPENROUTER_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    delete process.env.OPEN_ROUTER_API_KEY;
    process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = origKey;
    if (origAlt === undefined) delete process.env.OPEN_ROUTER_API_KEY; else process.env.OPEN_ROUTER_API_KEY = origAlt;
    if (origModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = origModel;
  });

  it('500s when no OpenRouter key is configured', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const res = await buildApp().request('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(500);
    expect((await res.json() as any).error).toMatch(/OPENROUTER_API_KEY/);
  });

  it('relays OpenRouter deltas as content_block_delta + a terminal final_message', async () => {
    // Fake OpenRouter SSE: two content deltas, then [DONE].
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode(sse)); ctrl.close(); },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const res = await buildApp().request('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'anthropic/claude-sonnet-4' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();

    // Two text deltas relayed in the client's expected envelope.
    expect(text).toContain('"type":"content_block_delta"');
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
    // Terminal Anthropic-shaped message + DONE sentinel.
    expect(text).toContain('"type":"final_message"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('data: [DONE]');

    // Verify we called OpenRouter with OpenAI-shaped, stream:true body.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe('anthropic/claude-sonnet-4');
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('assembles streamed tool_call fragments into a tool_use final_message', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"find-json-record","arguments":"{\\"q\\":"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode(sse)); ctrl.close(); },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const res = await buildApp().request('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
    });
    const text = await res.text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"find-json-record"');
    expect(text).toContain('"stop_reason":"tool_use"');
    // input reassembled from the two argument fragments
    expect(text).toContain('"input":{"q":"x"}');
  });

  it('propagates an OpenRouter error status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );
    const res = await buildApp().request('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(429);
  });
});
