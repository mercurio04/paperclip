// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntimeState, HeartbeatRun } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunListItem } from "./AgentDetail";
import { CostsSection, RunListItem as ProductionRunListItem } from "./AgentDetail.production";

vi.mock("@/lib/router", async original => ({
  ...await original<typeof import("@/lib/router")>(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

describe.each([RunListItem, ProductionRunListItem])("Claude cost rendering (%#)", Row => {
  it.each(["zero", "unknown", "delta"])("renders invocation %s without a cumulative raw fallback", mode => {
    const run: Partial<HeartbeatRun> = { id: "run-1", status: "succeeded", invocationSource: "on_demand",
      createdAt: new Date("2026-10-05T00:00:00Z"),
      usageJson: { accountingSource: "claude_session_delta", provider: "anthropic", billingType: "metered_api",
        inputTokens: 10, outputTokens: 20, costStatus: mode === "unknown" ? "unpriced" : "reported",
        ...(mode === "unknown" ? {} : { costUsd: mode === "zero" ? 0 : 0.1568486 }) },
      resultJson: { total_cost_usd: 16.533545 } };
    const html = renderToStaticMarkup(<Row run={run as HeartbeatRun} isSelected={false} agentId="agent-1" />);
    expect(html).not.toContain("$16.534");
    if (mode === "unknown") expect(html).toContain("Unknown");
    else if (mode === "delta") expect(html).toContain("$0.157");
    else { expect(html).not.toContain("Unknown"); expect(html).not.toContain("$0.157"); }
    expect(run.resultJson).toEqual({ total_cost_usd: 16.533545 });
  });
});

it("does not present a known invoice subtotal as complete when a Claude invocation is unpriced", () => {
  const run: Partial<HeartbeatRun> = { id: "unknown-run", createdAt: new Date("2026-10-05T00:00:00Z"), usageJson: {
    accountingSource: "claude_invocation_missing_baseline", billingType: "metered_api", costStatus: "unpriced" },
    resultJson: { total_cost_usd: 16.533545 } };
  const state = { totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalCostCents: 20 } as AgentRuntimeState;
  const html = renderToStaticMarkup(<CostsSection runs={[run as HeartbeatRun]} runtimeState={state} />);
  expect(html).not.toContain("$0.20");
  expect(html).toContain("Unknown");
  expect(html).not.toContain("$16.5335");
});
