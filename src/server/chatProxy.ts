// chatProxy.ts — the LLM streaming proxy for the co-hosted dashboard UI.
//
// Ported from mmc-workflow/src/server/api/chat.ts so the whole runtime (engine
// + dashboard) ships as one mmc-mcp deployment. Accepts an Anthropic-shaped
// request, converts to OpenAI/OpenRouter format, streams the response back as
// the same SSE envelope the mmc-workflow client (ChatDialog.streamChat) already
// expects: `content_block_delta` text deltas, a terminal `final_message`
// (Anthropic-shaped, with tool_use blocks), and a `[DONE]` sentinel.
//
// Hono's streamSSE is used (not a node ServerResponse) so this runs unchanged
// under both @hono/node-server and Bun's serve.
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { logger } from '@src/utils/logger.js';

/** Convert an Anthropic-format message array (+ system) into OpenAI messages.
 *  Exported for unit testing. */
export function toOpenAiMessages(anthropicMessages: any[], system: unknown): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const msg of anthropicMessages ?? []) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        } else if (block.type === 'text') {
          out.push({ role: 'user', content: block.text });
        }
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      let textParts = '';
      const toolCalls: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') textParts += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
      const assistantMsg: any = { role: 'assistant', content: textParts || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    } else {
      out.push({ role: msg.role, content: msg.content });
    }
  }
  return out;
}

/** Mounts POST /api/chat — the dashboard's streaming LLM proxy. */
export function mountChatProxyRoute(app: Hono): void {
  app.post('/api/chat', async (c) => {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
    if (!apiKey) {
      return c.json({ error: 'OPENROUTER_API_KEY is not set' }, 500);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { messages: anthropicMessages, system, tools: anthropicTools, model, max_tokens } = body ?? {};
    const openaiMessages = toOpenAiMessages(anthropicMessages, system);
    const openaiTools = (anthropicTools ?? []).map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    // Prefer the request's model, then the deployment default, then a safe
    // literal. Keep this fallback in sync with the workbench's VITE_AI_MODEL
    // before a production push (see memory project_pre_deploy_synthesizer_model).
    const resolvedModel = model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4';

    let upstream: Response;
    try {
      upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'EBD Connect',
        },
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: max_tokens || 4096,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          stream: true,
        }),
      });
    } catch (err: any) {
      logger.warn({ error: err?.message }, '[chatProxy] OpenRouter fetch failed');
      return c.json({ error: err?.message ?? 'Upstream request failed' }, 502);
    }

    if (!upstream.ok || !upstream.body) {
      const errBody = await upstream.text().catch(() => '');
      return c.json({ error: errBody || `OpenRouter API error: ${upstream.status}` }, (upstream.status || 502) as any);
    }

    return streamSSE(c, async (stream) => {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }
            const delta = chunk.choices?.[0]?.delta;
            const finish = chunk.choices?.[0]?.finish_reason;
            if (finish) finishReason = finish;

            if (delta?.content) {
              fullText += delta.content;
              await stream.writeSSE({
                data: JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: delta.content },
                }),
              });
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { id: tc.id || '', name: '', arguments: '' });
                const entry = toolCallsMap.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }
          }
        }

        // Build the Anthropic-shaped terminal message the client expects.
        const content: any[] = [];
        if (fullText) content.push({ type: 'text', text: fullText });
        for (const [, tc] of toolCallsMap) {
          let parsedArgs: any = {};
          try { parsedArgs = JSON.parse(tc.arguments); } catch { /* keep empty */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedArgs });
        }
        const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
        await stream.writeSSE({
          data: JSON.stringify({ type: 'final_message', message: { role: 'assistant', content, stop_reason: stopReason } }),
        });
        await stream.writeSSE({ data: '[DONE]' });
      } catch (err: any) {
        logger.warn({ error: err?.message }, '[chatProxy] stream relay error');
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: err?.message ?? 'stream error' }) });
      }
    });
  });
}
