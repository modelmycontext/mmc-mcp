/**
 * First-match scenario selection (model-contract.md Decision 3 / issue #78).
 *
 * Scenarios are evaluated in AUTHORED ORDER and the FIRST whose predicate
 * passes is selected — exactly one scenario executes per slice run. A no-rule
 * catch-all placed last is the natural `otherwise` branch.
 *
 * Predicates are side-effect-free (they read a pre-built fact snapshot and
 * never mutate it), so they are evaluated in PARALLEL and the winner is chosen
 * by authored index over the COLLECTED results — never by completion order.
 * A fast later scenario must never beat a slow earlier one; this is what keeps
 * parallel-then-select-by-index semantically identical to sequential
 * first-match while preserving multi-LLM-rule latency (sequential worst case
 * re-serializes per-scenario LLM evaluation past the lambda timeout).
 *
 * Accepted cost: later scenarios' predicates still run (and their results are
 * discarded) even when an earlier scenario wins.
 */
export async function selectFirstMatch<S>(
  scenarios: readonly S[],
  matches: (scenario: S, index: number) => boolean | Promise<boolean>,
): Promise<{ scenario: S; index: number } | null> {
  // Promise.all preserves input-array order regardless of resolution timing,
  // so the index scan below is authored-order, not completion-order.
  const results = await Promise.all(scenarios.map((s, i) => matches(s, i)));
  for (let i = 0; i < results.length; i++) {
    if (results[i]) return { scenario: scenarios[i], index: i };
  }
  return null;
}
