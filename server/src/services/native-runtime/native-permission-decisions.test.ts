import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  nativePermissionDecisions,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  applyNativePermissionSettle,
  claimNativePermissionDecision,
  nativePermissionOutcomeFromEvent,
  reconcileCrashedNativePermissionClaims,
  settleNativePermissionDecision,
} from "./native-permission-decisions.js";

describe("native permission outcome relayed by runnerd", () => {
  const diagnostic = (payload: Record<string, unknown>) => ({ eventType: "harness.diagnostic", payload });
  it("extracts only a valid permission_native_outcome diagnostic", () => {
    expect(nativePermissionOutcomeFromEvent(diagnostic({
      code: "permission_native_outcome", requestId: "runtime-request-1", nativeOutcome: "rejected_terminal",
    }))).toEqual({ requestId: "runtime-request-1", nativeOutcome: "rejected_terminal" });
    expect(nativePermissionOutcomeFromEvent(diagnostic({
      code: "permission_native_outcome", requestId: "runtime-request-1", nativeOutcome: "once",
    }))).toBeNull();
    expect(nativePermissionOutcomeFromEvent(diagnostic({
      code: "permission_native_outcome", nativeOutcome: "once_applied",
    }))).toBeNull();
    expect(nativePermissionOutcomeFromEvent(diagnostic({
      code: "permission_expired", requestId: "runtime-request-1", nativeOutcome: "rejected_expired",
    }))).toBeNull();
    expect(nativePermissionOutcomeFromEvent({
      eventType: "runtime_request.resolved",
      payload: { code: "permission_native_outcome", requestId: "runtime-request-1", nativeOutcome: "once_applied" },
    })).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("native permission decision claims (embedded Postgres)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permission-decisions-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "opencode",
      role: "general",
      status: "idle",
      adapterType: "paperclip_runner",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {},
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const claimInput = (decision: "once" | "reject") => ({
    companyId,
    agentId,
    runId,
    requestId: "perm-1",
    turnId: "turn-1",
    contractSha256: "a".repeat(64),
    decision,
    resolverUserId: "admin",
  });

  it("claims a request exactly once, even under concurrent decisions", async () => {
    const results = await Promise.all([
      claimNativePermissionDecision(db, claimInput("once")),
      claimNativePermissionDecision(db, claimInput("reject")),
      claimNativePermissionDecision(db, claimInput("once")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "claimed", requestId: "perm-1", error: null });
  });

  it("settles only claimed rows and never reopens an uncertain claim", async () => {
    const [row] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.runId, runId));
    await settleNativePermissionDecision(db, {
      id: row!.id,
      status: "dispatch_uncertain",
      error: "timeout",
    });
    await settleNativePermissionDecision(db, { id: row!.id, status: "delivered" });
    const [after] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.id, row!.id));
    expect(after).toMatchObject({ status: "dispatch_uncertain", error: "timeout" });
    await expect(claimNativePermissionDecision(db, claimInput("once"))).resolves.toBeNull();
  });

  it("reconciles pre-crash claimed rows to dispatch_uncertain only, never touching later or settled rows", async () => {
    const before = await claimNativePermissionDecision(db, { ...claimInput("once"), requestId: "perm-crash" });
    const stale = await claimNativePermissionDecision(db, { ...claimInput("once"), requestId: "perm-stale" });
    await settleNativePermissionDecision(db, { id: stale!.id, status: "stale" });
    const [{ now }] = (await db.execute(sql`select clock_timestamp() as now`)) as unknown as Array<{ now: string }>;
    const boundary = new Date(now);
    await new Promise((r) => setTimeout(r, 20));
    const after = await claimNativePermissionDecision(db, { ...claimInput("once"), requestId: "perm-live" });
    const moved = await reconcileCrashedNativePermissionClaims(db, {
      companyId, runId, claimedBefore: boundary, reason: "server_restart_dispatch_outcome_unknown",
    });
    expect(moved.map((row) => row.requestId)).toEqual(["perm-crash"]);
    const rows = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.runId, runId));
    const byRequest = Object.fromEntries(rows.map((row) => [row.requestId, row]));
    expect(byRequest["perm-crash"]).toMatchObject({ id: before!.id, status: "dispatch_uncertain", error: "server_restart_dispatch_outcome_unknown" });
    expect(byRequest["perm-stale"]).toMatchObject({ status: "stale" });
    expect(byRequest["perm-live"]).toMatchObject({ id: after!.id, status: "claimed" });
    // Never redelivered: a second decision for the reconciled request is refused.
    await expect(claimNativePermissionDecision(db, { ...claimInput("once"), requestId: "perm-crash" })).resolves.toBeNull();
    // Idempotent.
    await expect(reconcileCrashedNativePermissionClaims(db, {
      companyId, runId, claimedBefore: boundary, reason: "again",
    })).resolves.toEqual([]);
  });
  it("records native_outcome first-write-wins and audits conflicts (cancel||once race)", async () => {
    const claim = await claimNativePermissionDecision(db, {
      ...claimInput("once"),
      requestId: "perm-race",
    });
    expect(claim).not.toBeNull();
    await settleNativePermissionDecision(db, { id: claim!.id, status: "delivered" });
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const audit = async (entry: { action: string; details: Record<string, unknown> }) => {
      audits.push({ action: entry.action, details: entry.details });
    };
    const settle = (nativeOutcome: unknown, requestId = "perm-race") =>
      applyNativePermissionSettle(db, { companyId, agentId, runId, requestId, nativeOutcome }, audit);

    // Delivered but no settle yet: outcome stays null.
    let [row] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.id, claim!.id));
    expect(row).toMatchObject({ status: "delivered", nativeOutcome: null });

    // Unknown values and requests without a claim are ignored.
    await expect(settle("granted")).resolves.toBeNull();
    await expect(settle("rejected_terminal", "no-such-request")).resolves.toEqual({ kind: "no_claim" });

    // Terminal state won the race: the driver sent native reject.
    await expect(settle("rejected_terminal")).resolves.toEqual({ kind: "recorded", id: claim!.id });
    // Duplicate settle is a no-op; a conflicting one never overwrites.
    await expect(settle("rejected_terminal")).resolves.toEqual({ kind: "unchanged", id: claim!.id });
    await expect(settle("once_applied")).resolves.toEqual({
      kind: "conflict", id: claim!.id, existing: "rejected_terminal",
    });
    [row] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.id, claim!.id));
    expect(row).toMatchObject({ status: "delivered", nativeOutcome: "rejected_terminal" });
    expect(audits).toEqual([
      {
        action: "heartbeat.runtime_permission_native_outcome",
        details: { agentId, runId, requestId: "perm-race", nativeOutcome: "rejected_terminal" },
      },
      {
        action: "heartbeat.runtime_permission_native_outcome_conflict",
        details: {
          agentId, runId, requestId: "perm-race",
          nativeOutcome: "once_applied", existingNativeOutcome: "rejected_terminal",
        },
      },
    ]);
  });
});
