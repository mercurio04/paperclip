import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { assertAssignableAgent } from "../services/agent-assignability.ts";
import {
  agentAssignmentIsHardLocked,
  agentInvocationIsManualOnly,
  inertAgentPermissions,
  inertAgentRuntimeConfig,
  MANUAL_ONLY_SKIP_REASON,
  preserveInertLocks,
} from "../services/agent-invocation-policy.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Manual-only policy test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

describe("agent invocation policy helpers", () => {
  it("builds inert permissions with the hard lock and no creation authority", () => {
    const permissions = inertAgentPermissions({ canCreateAgents: true, trustPreset: "standard" });
    expect(permissions).toMatchObject({
      canCreateAgents: false,
      canCreateSkills: false,
      trustPreset: "standard",
      invocationPolicy: { mode: "manual_only" },
      authorizationPolicy: { protectedAgent: { blockAssignment: true } },
    });
    expect(agentInvocationIsManualOnly(permissions)).toBe(true);
    expect(agentAssignmentIsHardLocked(permissions)).toBe(true);
  });

  it("forces every automatic wake switch off", () => {
    expect(inertAgentRuntimeConfig({ heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }))
      .toMatchObject({
        heartbeat: {
          enabled: false,
          intervalSec: 60,
          wakeOnDemand: false,
          wakeOnAssignment: false,
          wakeOnOnDemand: false,
          wakeOnAutomation: false,
        },
      });
  });

  it("does not hard-lock an agent that only carries the legacy protected-agent block", () => {
    const legacy = { authorizationPolicy: { protectedAgent: { blockAssignment: true } } };
    expect(agentInvocationIsManualOnly(legacy)).toBe(false);
    expect(agentAssignmentIsHardLocked(legacy)).toBe(false);
  });

  it("keeps the inert locks when a permissions rewrite tries to drop them", () => {
    const existing = inertAgentPermissions({});
    const next = preserveInertLocks(existing, {
      canCreateAgents: true,
      canAssignTasks: true,
      authorizationPolicy: {},
      invocationPolicy: { mode: "automatic" },
    });
    expect(agentAssignmentIsHardLocked(next)).toBe(true);
    expect(next.canCreateAgents).toBe(true);
    // Non manual-only agents are untouched.
    expect(preserveInertLocks({}, { canCreateAgents: true })).toEqual({ canCreateAgents: true });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

describeEmbeddedPostgres("manual-only agent policy (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-manual-only-policy-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seed(options: { manualOnly: boolean }) {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    const baseRuntime = { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } };
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: options.manualOnly ? "bombero" : "regular",
      role: "general",
      // Activated by the board after inert creation (paused agents are not
      // invokable at all, including manually).
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: options.manualOnly ? inertAgentRuntimeConfig(baseRuntime) : baseRuntime,
      permissions: options.manualOnly ? inertAgentPermissions({}) : {},
      lastHeartbeatAt: new Date("2026-01-01T00:00:00Z"),
    });
    return { companyId, ownerUserId, agentId };
  }

  const automaticWakes = [
    { source: "assignment" as const, reason: "issue_assigned" },
    { source: "automation" as const, reason: "issue_commented" },
    { source: "automation" as const, reason: "issue_comment_mentioned" },
    { source: "automation" as const, reason: "issue_blockers_resolved" },
    { source: "automation" as const, reason: "issue_children_completed" },
    { source: "automation" as const, reason: "issue_monitor_recovery" },
    { source: "on_demand" as const, reason: "run_liveness_continuation" },
    { source: "timer" as const, reason: "heartbeat_timer" },
  ];

  it.each(automaticWakes)("skips a $source/$reason wake for a manual-only agent", async (wake) => {
    const { agentId } = await seed({ manualOnly: true });
    const run = await heartbeat.wakeup(agentId, {
      source: wake.source,
      triggerDetail: "system",
      reason: wake.reason,
      payload: { issueId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run).toBeNull();
    const requests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: "skipped", reason: MANUAL_ONLY_SKIP_REASON });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("skips a user-requested on-demand wake that is not an explicit manual click", async () => {
    const { agentId, ownerUserId } = await seed({ manualOnly: true });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
    });
    expect(run).toBeNull();
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(request).toMatchObject({ status: "skipped", reason: MANUAL_ONLY_SKIP_REASON });
  });

  it("runs an explicit authenticated human invocation despite wakeOnDemand=false", async () => {
    const { agentId, ownerUserId } = await seed({ manualOnly: true });
    const run = await heartbeat.wakeup(agentId, {
      manualUserWake: true,
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
      contextSnapshot: { responsibleUserId: ownerUserId },
    });
    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("never schedules timer heartbeats for a manual-only agent", async () => {
    const { agentId } = await seed({ manualOnly: true });
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: false } },
    }).where(eq(agents.id, agentId));
    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));
    expect(result.enqueued).toBe(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
  });

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    payload: Record<string, unknown>;
    requestedByActorType: "system" | "user";
    requestedByActorId: string;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "scheduled_retry",
      payload: input.payload,
      status: "queued",
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { wakeReason: "scheduled_retry" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  it.each([
    { label: "no manual receipt", payload: {}, actor: "system" as const },
    { label: "a forged system manual receipt", payload: { manualUserWake: true }, actor: "system" as const },
  ])("cancels a queued run inserted outside enqueueWakeup with $label", async ({ payload, actor }) => {
    const { companyId, agentId } = await seed({ manualOnly: true });
    const runId = await seedQueuedRun({
      companyId,
      agentId,
      payload,
      requestedByActorType: actor,
      requestedByActorId: "recovery",
    });
    await heartbeat.resumeQueuedRuns();
    const run = await waitForRun(db, runId);
    expect(run?.status).toBe("cancelled");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("keeps automatic wakes for an agent that did not opt in (regression)", async () => {
    const { agentId } = await seed({ manualOnly: false });
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(run).not.toBeNull();
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(request?.reason).not.toBe(MANUAL_ONLY_SKIP_REASON);
    await waitForRun(db, run!.id);
  });

  it("denies assigning work or routines to a manual-only agent on the service path", async () => {
    const { companyId, agentId } = await seed({ manualOnly: true });
    await expect(assertAssignableAgent(db, companyId, agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_not_assignable", reason: "assignment_blocked" },
    });
    await expect(assertAssignableAgent(db, companyId, agentId, { kind: "routine" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("keeps assignment open for a regular agent and the legacy protected-agent block (regression)", async () => {
    const { companyId, agentId } = await seed({ manualOnly: false });
    await expect(assertAssignableAgent(db, companyId, agentId)).resolves.toBeUndefined();
    await db.update(agents).set({
      permissions: { authorizationPolicy: { protectedAgent: { blockAssignment: true } } },
    }).where(eq(agents.id, agentId));
    await expect(assertAssignableAgent(db, companyId, agentId)).resolves.toBeUndefined();
  });
});
