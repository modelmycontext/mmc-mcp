
import { logger } from '@src/utils/logger.js';

export class LlmService {
  /**
   * Evaluates a single business rule condition using the LLM.
   * Returns true if the condition holds, false otherwise.
   *
   * @param factName   Human-readable name of the fact being evaluated
   * @param factValue  Current string value of the fact
   * @param prompt     Natural language description of the condition to check
   * @param allFacts   Optional full fact context — included in the LLM prompt so
   *                   conditions that reference multiple facts can be evaluated.
   */
  async evaluateRule(
    factName: string,
    factValue: string,
    prompt: string,
    allFacts?: Record<string, any>,
  ): Promise<boolean> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL;

    if (!apiKey || !model) {
      logger.warn({ factName }, '[LLM] evaluateRule: OPENROUTER_API_KEY or OPENROUTER_MODEL not set — defaulting to false');
      return false;
    }

    const factTable = allFacts && Object.keys(allFacts).length > 0
      ? Object.entries(allFacts)
          .filter(([k]) => k !== 'sessionId')
          .map(([k, v]) => `- ${k}: ${formatValue(v)}`)
          .join('\n')
      : null;

    const question = `You are evaluating a single business rule condition against the facts below.

${factTable ? `Known facts:\n${factTable}\n\n` : ''}Primary fact under evaluation: "${factName}" = ${JSON.stringify(factValue)}

Condition: ${prompt}

Today's date is ${new Date().toISOString().slice(0, 10)}.

Think step by step. If the condition involves dates, compute the exact gap in days before deciding. Nested facts may appear as JSON objects — parse them and use the relevant inner field.

End your response with a final line containing exactly one word — either \`true\` or \`false\` — and nothing else on that line.`;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: question }],
          temperature: 0
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      const raw: string = data.choices?.[0]?.message?.content ?? '';
      const result = parseBoolean(raw);
      logger.info({ factName, factValue, prompt, raw, result }, '[LLM] evaluateRule result');
      return result;
    } catch (error: any) {
      logger.error({ error: error.message, factName, prompt }, `[LLM] evaluateRule failed: ${error.message}`);
      // Fail-safe: treat as false so the scenario is excluded rather than incorrectly included
      return false;
    }
  }

  /**
   * Executes a free-text instruction against the current facts and returns
   * a JSON result.  This is the "ai.eval" path: when an automation item
   * has no connector job but carries a natural-language `text` instruction,
   * the LLM interprets it using the available facts and produces structured
   * output that can be merged back into the fact pool.
   *
   * When `inScopeFactNames` is provided, the prompt enumerates exactly that
   * list — including facts the slice's contract permits but that are not yet
   * set at runtime, marked `(not set)`. This both gives the LLM a complete
   * picture of the contract and lets it surface unmet preconditions via
   * `_missingFacts` instead of guessing values out of thin air.
   */
  async evaluateInstruction(
    instruction: string,
    facts: Record<string, any>,
    returnedFactName?: string | string[],
    inScopeFactNames?: string[],
  ): Promise<Record<string, any>> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL;

    if (!apiKey || !model) {
      logger.warn('[LLM] evaluateInstruction: OPENROUTER_API_KEY or OPENROUTER_MODEL not set');
      return {};
    }

    // Names this step is expected to PRODUCE — must be excluded from the
    // inputs table, otherwise the LLM sees them as `(not set)` and mistakes
    // them for missing INPUTS (then takes the _missingFacts escape hatch
    // instead of producing them).
    const outputNames = new Set<string>(
      Array.isArray(returnedFactName)
        ? returnedFactName
        : returnedFactName ? [returnedFactName] : [],
    );

    let factTable: string;
    let missingFactsClause = '';
    if (inScopeFactNames && inScopeFactNames.length > 0) {
      // Show every in-scope fact EXCEPT this step's own outputs, marking
      // unset ones explicitly so the LLM distinguishes "value is empty
      // string" from "fact not yet produced".
      const seen = new Set<string>();
      const inputRows = inScopeFactNames
        .filter(n => n && n !== 'sessionId' && !outputNames.has(n) && !seen.has(n) && (seen.add(n), true))
        .map(n => {
          const v = facts[n];
          const isMissing = v === undefined || v === null || v === '';
          return `- ${n}: ${isMissing ? '(not set)' : formatValue(v)}`;
        });
      factTable = inputRows.length > 0 ? inputRows.join('\n') : '(no inputs in scope)';
      missingFactsClause = `\n\nIf you cannot complete the instruction because one or more INPUT facts above are (not set), do NOT guess and do NOT list any of the OUTPUT facts you are asked to produce. Instead return a JSON object of the form:\n  {"_missingFacts": ["input-fact-name", ...], "_reason": "short explanation"}\nOnly list facts from the "Input facts" section above. Output facts you are tasked to produce must NEVER appear in _missingFacts.`;
    } else {
      factTable = Object.entries(facts)
        .filter(([k]) => k !== 'sessionId' && !outputNames.has(k))
        .map(([k, v]) => `- ${k}: ${formatValue(v)}`)
        .join('\n') || '(no inputs)';
    }

    const outputClause = Array.isArray(returnedFactName) && returnedFactName.length > 0
      ? `OUTPUT FACTS — produce a value for EACH of these (your job is to PRODUCE these, not consume them):\n${returnedFactName.map(n => `  - "${n}"`).join('\n')}\nReturn a JSON object with one key per output fact, each holding that fact's computed value. Every listed key MUST be present. Do not nest one fact inside another.`
      : returnedFactName
        ? `OUTPUT FACT — produce a value for "${returnedFactName}" (your job is to PRODUCE this, not consume it). Return a JSON object with the key "${returnedFactName}" containing the result.`
        : 'Return a JSON object with the result. Use descriptive keys.';

    const question = `You are an automation step in a business workflow. Execute the instruction below using the input facts to produce the output facts.

Input facts:
${factTable}

Instruction: ${instruction}

Today's date is ${new Date().toISOString().slice(0, 10)}.

${outputClause}${missingFactsClause}

Return ONLY valid JSON — no markdown, no explanation.`;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: question }],
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      const raw: string = data.choices?.[0]?.message?.content ?? '';
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const result = JSON.parse(cleaned);
      logger.info({ instruction: instruction.slice(0, 100), returnedFactName, resultKeys: Object.keys(result) }, '[LLM] evaluateInstruction result');
      return result;
    } catch (error: any) {
      logger.error({ error: error.message, instruction: instruction.slice(0, 100) }, `[LLM] evaluateInstruction failed: ${error.message}`);
      return {};
    }
  }
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Robustly extract a boolean from an LLM response. Handles:
 *   - Exact "true" / "false" (any case)
 *   - Leading/trailing whitespace, punctuation, or quotes
 *   - Markdown code fences (```true```, `true`)
 *   - Chain-of-thought reasoning that ends with a final verdict line
 *   - Mixed content — prefers whichever token appears LAST (the conclusion)
 *
 * We prefer the LAST occurrence because models tend to reason with phrases like
 * "Is this true? Let's check..." and then end with the actual answer. Picking the
 * first token would misread the reasoning as the verdict.
 *
 * Returns false when neither token is present (fail-safe: exclude scenario).
 */
function parseBoolean(raw: string): boolean {
  if (!raw) return false;
  const text = raw.toLowerCase();

  // Prefer the last line containing only "true"/"false" (the structured final answer).
  const lines = text.split(/\r?\n/).map(l => l.replace(/[`"'*_\[\]()\s,.:;!?]+/g, ' ').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === 'true' || lines[i] === 'false') return lines[i] === 'true';
  }

  // Fallback: find the LAST standalone true/false token anywhere in the text.
  let lastIdx = -1;
  let lastVal = false;
  const re = /\b(true|false)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastIdx = m.index;
    lastVal = m[1] === 'true';
  }
  if (lastIdx === -1) return false;
  return lastVal;
}
