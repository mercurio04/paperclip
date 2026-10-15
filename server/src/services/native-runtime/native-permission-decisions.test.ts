import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
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
  reconcileTerminalNativePermissionOutcomes,
  settleNativePermissionDecision,
  sweepTerminalNativePermissionOutcomes,
} from "./native-permission-decisions.js";
import { logActivity } from "../activity-log.js";

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

  it("terminal reconciliation never leaves a delivered claim without native outcome (H13)", async () => {
    const delivered = async (requestId: string) => {
      const claim = await claimNativePermissionDecision(db, { ...claimInput("once"), requestId });
      await settleNativePermissionDecision(db, { id: claim!.id, status: "delivered" });
      return claim!;
    };
    const committedLate = await delivered("perm-terminal-committed");
    const lost = await delivered("perm-terminal-lost");
    const settled = await delivered("perm-terminal-settled");
    await applyNativePermissionSettle(db,
      { companyId, agentId, runId, requestId: "perm-terminal-settled", nativeOutcome: "once_applied" },
      async () => {});
    // The runnerd relay was committed durably but its consumer callback never ran.
    await db.insert(heartbeatRunEvents).values({
      companyId, runId, agentId, seq: 9_001, eventType: "harness.diagnostic", stream: "system", level: "info",
      payload: { prpEvent: { eventType: "harness.diagnostic", payload: {
        code: "permission_native_outcome", requestId: "perm-terminal-committed", nativeOutcome: "rejected_terminal",
      } } },
    });
    const result = await reconcileTerminalNativePermissionOutcomes(db, {
      companyId, runId, reason: "native_outcome_unobserved_at_terminal",
    });
    expect(result.recovered).toEqual([
      { id: committedLate.id, requestId: "perm-terminal-committed", nativeOutcome: "rejected_terminal" },
    ]);
    expect(result.uncertain.map((row) => row.requestId)).toEqual(["perm-terminal-lost"]);
    const rows = await db.select().from(nativePermissionDecisions);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(committedLate.id)).toMatchObject({ status: "delivered", nativeOutcome: "rejected_terminal" });
    expect(byId.get(lost.id)).toMatchObject({
      status: "dispatch_uncertain", nativeOutcome: null, error: "native_outcome_unobserved_at_terminal",
    });
    expect(byId.get(settled.id)).toMatchObject({ status: "delivered", nativeOutcome: "once_applied" });
    expect(rows.filter((row) => row.runId === runId && row.status === "delivered" && row.nativeOutcome === null))
      .toEqual([]);
    // Idempotent.
    await expect(reconcileTerminalNativePermissionOutcomes(db, {
      companyId, runId, reason: "native_outcome_unobserved_at_terminal",
    })).resolves.toEqual({ recovered: [], uncertain: [] });
  });

  it("boot sweep reconciles terminal runs whose fast-path timer died with the server (H13 crash)", async () => {
    const newRun = async (status: string) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status,
        runtimeMode: "native", contextSnapshot: {},
        ...(status === "running" ? {} : { finishedAt: new Date() }),
      });
      return id;
    };
    const deliver = async (run: string, requestId: string) => {
      const claim = await claimNativePermissionDecision(db, { ...claimInput("once"), runId: run, requestId });
      await settleNativePermissionDecision(db, { id: claim!.id, status: "delivered" });
      return claim!;
    };
    // Board cancel || once: run cancelled, claim delivered, server killed before the 4s timer.
    const cancelledRun = await newRun("cancelled");
    const crashed = await deliver(cancelledRun, "perm-crash-lost");
    // A persisted outcome whose consumer never ran (other terminal status).
    const succeededRun = await newRun("succeeded");
    const committed = await deliver(succeededRun, "perm-crash-committed");
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: succeededRun, agentId, seq: 1, eventType: "harness.diagnostic", stream: "system", level: "info",
      payload: { prpEvent: { eventType: "harness.diagnostic", payload: {
        code: "permission_native_outcome", requestId: "perm-crash-committed", nativeOutcome: "once_applied",
      } } },
    });
    const timedOutRun = await newRun("timed_out");
    const timedOut = await deliver(timedOutRun, "perm-crash-timed-out");
    // Live run: its consumer may still record the outcome; never touched.
    const liveRun = await newRun("running");
    const live = await deliver(liveRun, "perm-crash-live");
    // Excluded (resuming) terminal run is left for its own recovery.
    const resumingRun = await newRun("failed");
    const resuming = await deliver(resumingRun, "perm-crash-resuming");

    const audit = (entry: Parameters<typeof logActivity>[1]) => logActivity(db, entry);
    const first = await sweepTerminalNativePermissionOutcomes(db,
      { trigger: "startup_terminal_sweep", excludeRunIds: [resumingRun] }, audit);
    expect(first).toEqual({ runs: 3, recovered: 1, uncertain: 2, failedRunIds: [] });

    const rows = new Map((await db.select().from(nativePermissionDecisions)).map((row) => [row.id, row]));
    expect(rows.get(crashed.id)).toMatchObject({
      status: "dispatch_uncertain", nativeOutcome: null, error: "native_outcome_unobserved_at_terminal",
    });
    expect(rows.get(timedOut.id)).toMatchObject({ status: "dispatch_uncertain", nativeOutcome: null });
    expect(rows.get(committed.id)).toMatchObject({ status: "delivered", nativeOutcome: "once_applied" });
    expect(rows.get(live.id)).toMatchObject({ status: "delivered", nativeOutcome: null });
    expect(rows.get(resuming.id)).toMatchObject({ status: "delivered", nativeOutcome: null });

    const audits = await db.select().from(activityLog).where(eq(activityLog.entityType, "heartbeat_run"));
    const forRun = (run: string) => audits.filter((row) => row.entityId === run)
      .map((row) => ({ action: row.action, status: (row.details as Record<string, unknown>)?.status ?? null,
        reason: (row.details as Record<string, unknown>)?.reason ?? null,
        nativeOutcome: (row.details as Record<string, unknown>)?.nativeOutcome ?? null }));
    expect(forRun(cancelledRun)).toEqual([{ action: "heartbeat.runtime_permission_reconciled",
      status: "dispatch_uncertain", reason: "native_outcome_unobserved_at_terminal", nativeOutcome: null }]);
    expect(forRun(succeededRun)).toEqual([{ action: "heartbeat.runtime_permission_native_outcome",
      status: null, reason: null, nativeOutcome: "once_applied" }]);
    expect(forRun(liveRun)).toEqual([]);

    // Idempotent: a second boot (or the periodic tick) is a no-op without new audit rows.
    await expect(sweepTerminalNativePermissionOutcomes(db,
      { trigger: "startup_terminal_sweep", excludeRunIds: [resumingRun] }, audit))
      .resolves.toEqual({ runs: 0, recovered: 0, uncertain: 0, failedRunIds: [] });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityType, "heartbeat_run")))
      .toHaveLength(audits.length);

    // Periodic use never pre-empts the live fast-path window.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, liveRun));
    await expect(sweepTerminalNativePermissionOutcomes(db,
      { trigger: "periodic_terminal_sweep", settledBefore: new Date(Date.now() - 60_000) }, audit))
      .resolves.toMatchObject({ runs: 0 });
    await expect(sweepTerminalNativePermissionOutcomes(db,
      { trigger: "periodic_terminal_sweep", settledBefore: new Date(Date.now() + 60_000) }, audit))
      .resolves.toMatchObject({ runs: 2, uncertain: 2 });
  });
});
