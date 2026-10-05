import { describe, expect, it } from "vitest";
import { formatRunCost, formatRunCostSummary, visibleRunCostUsd } from "./utils";

const raw = { total_cost_usd: 16.533545 };
const claude = { accountingSource: "claude_session_delta", provider: "anthropic", billingType: "metered_api" };

describe("normalized Claude invocation cost in the board", () => {
  it("never replaces a priced zero delta with the historical session cost", () => {
    expect(visibleRunCostUsd({ ...claude, costStatus: "reported", costUsd: 0 }, raw)).toBe(0);
  });
  it("prefers a nonzero invocation delta and leaves the original result unchanged", () => {
    expect(visibleRunCostUsd({ ...claude, costStatus: "reported", costUsd: 0.1568486 }, raw)).toBe(0.1568486);
    expect(raw).toEqual({ total_cost_usd: 16.533545 });
  });
  it.each(["metered_api", "unknown", "subscription_included"])("keeps missing-baseline cost unknown for %s", billingType => {
    expect(visibleRunCostUsd({ ...claude, accountingSource: "claude_invocation_missing_baseline", billingType,
      costStatus: "unpriced" }, raw)).toBeNull();
  });
  it.each([undefined, Number.NaN, -1])("does not use a raw session as a price when normalized cost is %s", costUsd => {
    expect(visibleRunCostUsd({ ...claude, costStatus: "reported", costUsd }, raw)).toBeNull();
  });
  it("retains subscription invoice zero for a priced invocation", () => {
    expect(visibleRunCostUsd({ ...claude, billingType: "subscription_included", costStatus: "reported", costUsd: 3.1 }, raw)).toBe(0);
  });
  it("does not present a legacy Claude resume session total as an invocation price without a baseline", () => {
    expect(visibleRunCostUsd({ provider: "anthropic", sessionReused: true, costStatus: "reported", costUsd: 16.533545 }, raw)).toBeNull();
    expect(visibleRunCostUsd({ provider: "anthropic", sessionReused: false, costUsd: 0.5 }, raw)).toBe(0.5);
    expect(visibleRunCostUsd({ provider: "anthropic", sessionReused: true, costUsd: 0.15 }, { cumulativeCostUsd: 5 })).toBe(0.15); // ACPX remains per-turn.
  });
  it("preserves existing legacy and other-provider behavior", () => {
    expect(visibleRunCostUsd({ provider: "openai", costStatus: "unpriced" }, { costUsd: 0.75 })).toBe(0.75);
    expect(visibleRunCostUsd({ billingType: "subscription_included" }, raw)).toBe(0);
    expect(visibleRunCostUsd({ costUsd: 0 }, { cost_usd: 0.5 })).toBe(0.5);
    expect(visibleRunCostUsd(null, raw)).toBe(16.533545);
  });
  it("shows missing price and incomplete totals without displaying zero or a complete subtotal", () => {
    expect(formatRunCost(visibleRunCostUsd({ ...claude, costStatus: "unpriced" }, raw))).toBe("Unknown");
    expect(formatRunCost(0.1568486)).toBe("$0.1568");
    expect(formatRunCost(0)).toBe("-");
    expect(formatRunCostSummary(0.1568486, true)).toBe("Cost unknown (known $0.1568)");
    expect(formatRunCostSummary(0, true)).toBe("Cost unknown");
    expect(formatRunCostSummary(0.1568486, false)).toBe("$0.1568");
  });
});
