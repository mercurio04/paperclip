import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { readFileSync } from "node:fs";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { isClaudeCliAccountingResult, resolveClaudeInvocationAccounting } from "../services/claude-invocation-accounting.js";
const result = (raw: Record<string, unknown>): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false,
  provider: "anthropic", billingType: "subscription_included", resultJson: raw, costUsd: raw.total_cost_usd as number });
const ledger = (input: number, creation: number, read: number, output: number, cost: number) => ({
  total_cost_usd: cost, modelUsage: { opus: { inputTokens: input, cacheCreationInputTokens: creation,
    cacheReadInputTokens: read, outputTokens: output, costUSD: cost } } });

describe("Claude invocation accounting", () => {
  it("deltas every audited resumed invocation without changing the raw result", () => {
    const fixtures = JSON.parse(readFileSync(new URL("./fixtures/claude-resumed-invocations.json", import.meta.url), "utf8"));
    let previous: Record<string, unknown> | undefined;
    let cost = 0;
    for (const raw of fixtures) {
      const saved = JSON.stringify(raw);
      const resolved = resolveClaudeInvocationAccounting(result(raw), previous, Boolean(previous));
      expect(resolved.normalizedUsage).toEqual({ inputTokens: raw.usage.input_tokens + raw.usage.cache_creation_input_tokens,
        cachedInputTokens: raw.usage.cache_read_input_tokens, outputTokens: raw.usage.output_tokens });
      expect(JSON.stringify(raw)).toBe(saved);
      cost += resolved.accountedCostUsd!;
      previous = raw;
    }
    expect(cost).toBeCloseTo(4.0733152, 8);
  });
  it("carries the adapter's raw ledger through server normalization with separate cache reads", () => {
    const fixtures = JSON.parse(readFileSync(new URL("./fixtures/claude-resumed-invocations.json", import.meta.url), "utf8"));
    const parsed = parseClaudeStreamJson(JSON.stringify({ type: "result", ...fixtures[1] }));
    expect(parsed.usageBasis).toBe("session_cumulative");
    const resolved = resolveClaudeInvocationAccounting({ ...result(parsed.resultJson!), usage: parsed.usage }, fixtures[0], true);
    expect(resolved.normalizedUsage).toEqual({ inputTokens: 7169, cachedInputTokens: 411903, outputTokens: 857 });
    expect(resolved.accountedCostUsd).toBeCloseTo(0.1568486, 8);
    expect(parsed.costUsd).toBeCloseTo(2.9037956, 8);
  });
  it("leaves ACPX per-turn and Codex accounting outside the CLI ledger path", () => {
    expect(isClaudeCliAccountingResult(result({ status: "succeeded", cumulativeCostUsd: 5,
      usage: { inputTokens: 500 } }))).toBe(false);
    expect(isClaudeCliAccountingResult(result({ type: "result", usage: { input_tokens: 1 } }))).toBe(true);
  });
  it("counts a rotated fresh session without subtracting the old session", () => {
    expect(resolveClaudeInvocationAccounting(result(ledger(3, 5, 100, 2, 0.25)),
      ledger(100, 200, 10000, 300, 5), false)).toMatchObject({
      normalizedUsage: { inputTokens: 8, cachedInputTokens: 100, outputTokens: 2 }, accountedCostUsd: 0.25 });
  });
  it("does not substitute raw session tokens if the resumed invocation and baseline are missing", () => {
    const run = result(ledger(100, 200, 10000, 300, 5));
    run.usage = { inputTokens: 300, cachedInputTokens: 10000, outputTokens: 300 };
    expect(resolveClaudeInvocationAccounting(run, null, true)).toMatchObject({
      normalizedUsage: null, accountedCostUsd: null, accountingSource: "claude_invocation_missing_baseline" });
  });
  it("keeps cache reads separate from input plus cache creation", () => {
    const resolved = resolveClaudeInvocationAccounting(result(ledger(10, 20, 1000, 30, 0.012345)), null, false);
    expect(resolved.normalizedUsage).toEqual({ inputTokens: 30, cachedInputTokens: 1000, outputTokens: 30 });
    expect(resolved.accountedCostUsd).toBe(0.012345); // USD, not rounded cents or subscription invoice.
  });
  it("retains sidechain/subagent output and new models when subtracting a session ledger", () => {
    const before = ledger(10, 20, 1000, 30, 1);
    const after: ReturnType<typeof ledger> & { usage?: Record<string, number> } = ledger(15, 25, 2000, 40, 1.5);
    Object.assign(after.modelUsage, { haiku: { inputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 100,
      outputTokens: 50, costUSD: 0.2 } });
    after.usage = { input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 10 };
    expect(resolveClaudeInvocationAccounting(result(after), before, true).normalizedUsage)
      .toEqual({ inputTokens: 15, cachedInputTokens: 1100, outputTokens: 60 });
  });
  it("does not charge a zero-work replay carrying the prior session totals", () => {
    const prior = ledger(10, 20, 1000, 30, 1.25);
    expect(resolveClaudeInvocationAccounting(result(prior), prior, true)).toMatchObject({
      normalizedUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, accountedCostUsd: 0 });
  });
  it("resets an entire model ledger, including counters that happen to increase", () => {
    const prior = ledger(10, 20, 1000, 30, 1.25), next = ledger(2, 40, 1500, 10, 0.4);
    expect(resolveClaudeInvocationAccounting(result(next), prior, true)).toMatchObject({
      normalizedUsage: { inputTokens: 42, cachedInputTokens: 1500, outputTokens: 10 }, accountedCostUsd: 0.4 });
  });
  it("uses invocation tokens and unknown cost when a resumed session has no trustworthy baseline", () => {
    const raw = { ...ledger(100, 200, 10000, 300, 5), usage: { input_tokens: 1, cache_creation_input_tokens: 2,
      cache_read_input_tokens: 100, output_tokens: 3 } };
    expect(resolveClaudeInvocationAccounting(result(raw), null, true)).toMatchObject({
      normalizedUsage: { inputTokens: 3, cachedInputTokens: 100, outputTokens: 3 }, accountedCostUsd: null,
      accountingSource: "claude_invocation_missing_baseline" });
  });
  it("keeps an unreported cost unknown and rejects nonfinite/negative counts", () => {
    const raw = { usage: { input_tokens: 10.8, cache_creation_input_tokens: -1, output_tokens: Number.NaN } };
    expect(resolveClaudeInvocationAccounting(result(raw), null, false)).toMatchObject({
      normalizedUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 }, accountedCostUsd: null });
  });
});
