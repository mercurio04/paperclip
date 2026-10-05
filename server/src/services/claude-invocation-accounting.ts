import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type InvocationUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
type Ledger = Record<string, Record<string, unknown>>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown) => Math.floor(amount(value) ?? 0);
const fields = ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"] as const;
function ledger(value: unknown): Ledger {
  return Object.fromEntries(Object.entries(object(value)).flatMap(([name, entry]) => {
    const parsed = object(entry);
    return Object.keys(parsed).length ? [[name, parsed]] : [];
  }));
}
function tokens(current: Ledger, previous: Ledger): InvocationUsage {
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const [model, raw] of Object.entries(current)) {
    const before = previous[model];
    // A CLI ledger reset is one event, not an independent reset per counter.
    const reset = before && fields.some(key => count(raw[key]) < count(before[key]));
    const delta = (key: typeof fields[number]) => count(raw[key]) - (before && !reset ? count(before[key]) : 0);
    totals.inputTokens += delta("inputTokens") + delta("cacheCreationInputTokens");
    totals.cachedInputTokens += delta("cacheReadInputTokens");
    totals.outputTokens += delta("outputTokens");
  }
  return totals;
}
function invocationTokens(value: unknown): InvocationUsage | null {
  const raw = object(value);
  if (!Object.keys(raw).length) return null;
  return { inputTokens: count(raw.input_tokens) + count(raw.cache_creation_input_tokens),
    cachedInputTokens: count(raw.cache_read_input_tokens), outputTokens: count(raw.output_tokens) };
}

/** ACPX reports per-turn usage/cost through a separate contract. */
export function isClaudeCliAccountingResult(result: AdapterExecutionResult): boolean {
  const raw = object(result.resultJson);
  return raw.type === "result" || "modelUsage" in raw || "total_cost_usd" in raw;
}

/** Resolve new Claude invocations without changing their provider result/history.
 * modelUsage and total_cost_usd are cumulative across ordinary CLI resumes;
 * usage is the invocation's main-chain usage. A missing resumed baseline must
 * never charge the whole historical session as new work.
 */
export function resolveClaudeInvocationAccounting(
  result: AdapterExecutionResult, previousResult: unknown, resumed: boolean,
) {
  const raw = object(result.resultJson), previous = object(previousResult);
  const currentLedger = ledger(raw.modelUsage), previousLedger = ledger(previous.modelUsage);
  const hasLedger = Object.keys(currentLedger).length > 0;
  const hasBaseline = Object.keys(previousLedger).length > 0;
  const currentCost = amount(raw.total_cost_usd) ?? amount(result.costUsd);
  const previousCost = amount(previous.total_cost_usd);
  const unknownBaseline = resumed && (!hasBaseline || previousCost === null);
  const normalizedUsage = hasLedger && (!resumed || hasBaseline)
    ? tokens(currentLedger, resumed ? previousLedger : {})
    : invocationTokens(raw.usage) ?? (resumed || !result.usage ? null : {
      inputTokens: count(result.usage.inputTokens), cachedInputTokens: count(result.usage.cachedInputTokens),
      outputTokens: count(result.usage.outputTokens),
    });
  const accountedCostUsd = currentCost === null ? null : !resumed ? currentCost
    : previousCost === null ? null : currentCost >= previousCost ? currentCost - previousCost : currentCost;
  return { normalizedUsage, accountedCostUsd,
    derivedFromSessionTotals: resumed && hasLedger && hasBaseline,
    accountingSource: unknownBaseline ? "claude_invocation_missing_baseline"
      : resumed ? "claude_session_delta" : "claude_initial_invocation" };
}
