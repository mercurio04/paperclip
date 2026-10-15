import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
  describe("github_checks deterministic polling", () => {
    const headSha = "a".repeat(40);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    let fixtureDir: string;
    let fixtureFile: string;
    let fixture: Record<string, unknown>;
    const target = { kind: "github_checks", repo: "example/project", prNumber: 4, headSha,
      expectedChecks: ["build", "test"], intervalMinutes: 5, timeoutAt: "2026-04-11T15:00:00Z", maxAttempts: 10 };
    const run = (name: string, conclusion: string | null = null) => ({ id: name === "build" ? 1 : 2, name,
      status: conclusion ? "completed" : "in_progress", conclusion, app: { id: 1 } });
    const saveFixture = () => writeFileSync(fixtureFile, JSON.stringify(fixture));
    const calls = () => existsSync(fixtureFile + ".calls") ? readFileSync(fixtureFile + ".calls", "utf8").trim().split("\n") : [];
    const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
    const wakes = () => db.select().from(agentWakeupRequests);
    beforeEach(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), "github-monitor-"));
      fixtureFile = join(fixtureDir, "fixture.json");
      fixture = { pr: { head: { sha: headSha }, state: "open", merged: false }, runs: [run("build", "success"), run("test")] };
      saveFixture();
      vi.stubEnv("PATH", fileURLToPath(new URL("./fixtures/github-checks", import.meta.url)) + ":" + process.env.PATH);
      vi.stubEnv("GITHUB_MONITOR_FIXTURE", fixtureFile);
      vi.stubEnv("PAPERCLIP_GITHUB_CHECKS_MONITOR_ENABLED", "true");
    });
    afterEach(() => { vi.unstubAllEnvs(); rmSync(fixtureDir, { recursive: true, force: true }); });

    it("G2 no change: zero wakes, persisted digest and bounded backoff", async () => {
      const { issueId } = await seedFixture({ monitor: target });
      let row = await readIssue(issueId);
      for (const minutes of [5, 7.5, 11.25, 16.875, 25.3125, 30, 30]) {
        const now = row.monitorAttemptCount === 0 ? tickAt : row.monitorNextCheckAt!;
        await heartbeatService(db).tickTimers(now);
        row = await readIssue(issueId);
        expect(row.monitorNextCheckAt!.getTime() - now.getTime()).toBeGreaterThanOrEqual(minutes * 60_000);
        expect(row.monitorNextCheckAt!.getTime() - now.getTime()).toBeLessThan(minutes * 60_000 + 2_000);
        expect(row.monitorWakeRequestedAt).toBeNull();
        expect(row.monitorProbeState).toMatchObject({ intervalMinutes: minutes, consecutiveErrors: 0 });
        expect(parseIssueExecutionState(row.executionState)?.monitor?.attemptCount).toBe(row.monitorAttemptCount);
        expect(normalizeIssueExecutionPolicy(row.executionPolicy)?.monitor?.timeoutAt).toBe(target.timeoutAt);
      }
      expect(row.monitorAttemptCount).toBe(7);
      expect(await wakes()).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      expect(row.executionPolicy).not.toHaveProperty("monitorProbeState");
    });
    it.each(["head_changed", "pr_closed", "merged", "failure", "cancelled", "timed_out", "action_required", "green", "missing"])("G2 %s: one structured wake and no further query", async kind => {
      const { issueId } = await seedFixture({ monitor: target });
      if (kind === "head_changed") fixture.pr = { head: { sha: "b".repeat(40) }, state: "open", merged: false };
      else if (["pr_closed", "merged"].includes(kind)) fixture.pr = { head: { sha: headSha }, state: "closed", merged: kind === "merged" };
      else fixture.runs = kind === "missing" ? [run("build", "success")] : [run("build", "success"), run("test", kind === "green" ? "success" : kind)];
      saveFixture();
      await heartbeatService(db).tickTimers(tickAt);
      const firstCalls = calls().length;
      await heartbeatService(db).tickTimers(new Date(tickAt.getTime() + 6 * 60_000));
      const events = await wakes();
      expect(events).toHaveLength(1);
      expect(events[0]!.idempotencyKey).toBe(`issue-monitor:${issueId}:2026-04-11T12:30:00.000Z`);
      expect(events[0]!.payload?.githubChecks).toMatchObject({ repo: target.repo, headSha,
        reason: kind === "merged" ? "pr_closed" : kind === "green" ? "checks_completed" : kind === "missing" ? "expected_checks_missing" : ["head_changed", "pr_closed"].includes(kind) ? kind : "checks_failed" });
      expect(calls()).toHaveLength(firstCalls);
      expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
    });
    it.each(["HTTP 500", "HTTP 429", "HTTP 403 rate limit exceeded", "network unavailable"])("G2 %s: third consecutive error wakes, never green", async error => {
      const { issueId } = await seedFixture({ monitor: target });
      fixture.error = error; saveFixture();
      for (let attempt = 1; attempt <= 3; attempt++) {
        const row = await readIssue(issueId);
        await heartbeatService(db).tickTimers(attempt === 1 ? tickAt : row.monitorNextCheckAt!);
        expect(await wakes()).toHaveLength(attempt === 3 ? 1 : 0);
      }
      expect((await wakes())[0]!.payload?.githubChecks).toMatchObject({ reason: "probe_error", allGreen: false, probeError: { kind: "transient", consecutiveErrors: 3 } });
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(3);
    });
    it.each([401, 403, 404])("G2 HTTP %s: immediate error wake with no raw output", async status => {
      await seedFixture({ monitor: target }); fixture.error = `private-text HTTP ${status}`; saveFixture();
      await heartbeatService(db).tickTimers(tickAt);
      expect(await wakes()).toHaveLength(1);
      expect((await wakes())[0]!.payload?.githubChecks).toMatchObject({ reason: "probe_error", probeError: { kind: "access", status } });
      expect(JSON.stringify(await wakes())).not.toContain("private-text");
    });
    it("G2 successful poll resets consecutive errors", async () => {
      const { issueId } = await seedFixture({ monitor: target }); fixture.error = "HTTP 500"; saveFixture();
      await heartbeatService(db).tickTimers(tickAt);
      delete fixture.error; saveFixture();
      await heartbeatService(db).tickTimers((await readIssue(issueId)).monitorNextCheckAt!);
      expect((await readIssue(issueId)).monitorProbeState?.consecutiveErrors).toBe(0);
      expect(await wakes()).toHaveLength(0);
    });
    it.each(["timeout", "attempts", "last_attempt"])("G2 %s: clear/recover without extending limits", async kind => {
      const { issueId } = await seedFixture({ monitor: { ...target, ...(kind === "timeout" ? { timeoutAt: tickAt.toISOString() } : { maxAttempts: 1 }) }, monitorAttemptCount: kind === "attempts" ? 1 : 0 });
      await heartbeatService(db).tickTimers(tickAt);
      expect(calls()).toHaveLength(kind === "last_attempt" ? 3 : 0);
      const row = await readIssue(issueId);
      expect(row.monitorNextCheckAt).toBeNull();
      expect(parseIssueExecutionState(row.executionState)?.monitor?.clearReason).toBe(kind === "timeout" ? "timeout_exceeded" : "max_attempts_exhausted");
      expect(await wakes()).toHaveLength(1);
    });
    it("G2 clamps next poll to the original deadline", async () => {
      const deadline = new Date(tickAt.getTime() + 60_000);
      const { issueId } = await seedFixture({ monitor: { ...target, intervalMinutes: 1, timeoutAt: deadline.toISOString() } });
      await heartbeatService(db).tickTimers(tickAt);
      expect((await readIssue(issueId)).monitorNextCheckAt).toEqual(deadline);
      await heartbeatService(db).tickTimers(deadline);
      expect(calls()).toHaveLength(3);
      expect(await wakes()).toHaveLength(1);
    });
    it("G2 concurrent ticks have one effective claim", async () => {
      const { issueId } = await seedFixture({ monitor: target }); fixture.delay = 50; saveFixture();
      await Promise.all([heartbeatService(db).tickTimers(tickAt), heartbeatService(db).tickTimers(tickAt)]);
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(1);
      expect(calls()).toHaveLength(3);
      expect(await wakes()).toHaveLength(0);
    });
    it("G2 crash after claim: lease recovers only after five minutes", async () => {
      const { issueId } = await seedFixture({ monitor: target });
      await db.update(issues).set({ monitorWakeRequestedAt: tickAt, monitorAttemptCount: 1 }).where(eq(issues.id, issueId));
      await heartbeatService(db).tickTimers(new Date(tickAt.getTime() + 5 * 60_000));
      expect(calls()).toHaveLength(0);
      fixture.runs = [run("build", "success"), run("test", "success")]; saveFixture();
      const now = new Date(tickAt.getTime() + 5 * 60_000 + 1);
      await Promise.all([heartbeatService(db).tickTimers(now), heartbeatService(db).tickTimers(now)]);
      expect(await wakes()).toHaveLength(1);
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(2);
    });
    it("G2 clear or close cancels future probes", async () => {
      const { issueId } = await seedFixture({ monitor: target });
      await db.update(issues).set({ monitorNextCheckAt: null }).where(eq(issues.id, issueId));
      await heartbeatService(db).tickTimers(tickAt);
      await db.update(issues).set({ monitorNextCheckAt: tickAt, status: "done" }).where(eq(issues.id, issueId));
      await heartbeatService(db).tickTimers(tickAt);
      expect(calls()).toHaveLength(0);
    });
    it.each(["clear", "rearm", "close"])("G2 %s during query: CAS discards stale result", async kind => {
      const { issueId } = await seedFixture({ monitor: target }); fixture.delay = 200; saveFixture();
      const tick = heartbeatService(db).tickTimers(tickAt);
      const deadline = Date.now() + 5000;
      while (!calls().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls().length).toBeGreaterThan(0);
      await db.update(issues).set(kind === "close" ? { status: "done" } : kind === "clear" ? { monitorNextCheckAt: null, monitorWakeRequestedAt: null } : { monitorNextCheckAt: new Date(tickAt.getTime() + 60_000), monitorWakeRequestedAt: null }).where(eq(issues.id, issueId));
      await tick;
      expect(await wakes()).toHaveLength(0);
      expect((await readIssue(issueId)).monitorProbeState).toBeNull();
    });
    it.each(["disabled", "external_service"])("G2 %s: legacy one-shot behavior and no gh calls", async kind => {
      if (kind === "disabled") vi.stubEnv("PAPERCLIP_GITHUB_CHECKS_MONITOR_ENABLED", "false");
      await seedFixture({ monitor: kind === "external_service" ? { kind, serviceName: "Deploy health" } : target });
      await heartbeatService(db).tickTimers(tickAt);
      expect(await wakes()).toHaveLength(1);
      expect(calls()).toHaveLength(0);
      expect((await wakes())[0]!.payload).not.toHaveProperty("githubChecks");
    });
    it.each([false, true])("G2 crash around wake delivery (delivered=%s): durable event replays at most once", async delivered => {
      const { issueId, companyId, agentId } = await seedFixture({ monitor: target });
      await heartbeatService(db).tickTimers(tickAt);
      const row = await readIssue(issueId);
      const scheduledAt = row.monitorNextCheckAt!;
      const event = { reason: "checks_completed", repo: target.repo, prNumber: target.prNumber, headSha, allGreen: true };
      await db.update(issues).set({ monitorProbeState: { ...row.monitorProbeState, pendingEvent: event },
        monitorWakeRequestedAt: tickAt }).where(eq(issues.id, issueId));
      if (delivered) await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued", reason: "issue_monitor_due",
        payload: { issueId, githubChecks: event }, idempotencyKey: `issue-monitor:${issueId}:${scheduledAt.toISOString()}` });
      const count = calls().length;
      await heartbeatService(db).tickTimers(new Date(scheduledAt.getTime() + 5 * 60_000 + 1));
      expect(await wakes()).toHaveLength(1);
      expect(calls()).toHaveLength(count);
      expect((await readIssue(issueId)).monitorNextCheckAt).toBeNull();
    });
    it("G2 additive migration is idempotent on the disposable database", async () => {
      const migration = readFileSync(fileURLToPath(new URL("../../../packages/db/src/migrations/0280_shallow_spitfire.sql", import.meta.url)), "utf8");
      await db.execute(sql.raw(migration));
      await db.execute(sql.raw(migration));
    });
    it("G2 real process restart: durable monitor resumes in a fresh loopback server", async () => {
      const { issueId } = await seedFixture({ monitor: target });
      const start = async () => {
        const child = fork(fileURLToPath(new URL("./fixtures/github-checks/restart-server.ts", import.meta.url)), [], {
          execArgv: ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url))], cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: { ...process.env, GITHUB_MONITOR_TEST_DB: tempDb!.connectionString }, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("server start timeout")), 20000); child.once("message", () => { clearTimeout(timer); resolve(); }); child.once("exit", code => reject(new Error(`server exited ${code}`))); });
        return child;
      };
      const tick = async (child: ReturnType<typeof fork>, now: Date) => {
        const message = new Promise<unknown>(resolve => child.once("message", resolve)); child.send({ now: now.toISOString() });
        expect(await message).not.toHaveProperty("error");
      };
      const stop = async (child: ReturnType<typeof fork>) => { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; };
      const first = await start();
      try { await tick(first, tickAt); } finally { await stop(first); }
      const row = await readIssue(issueId);
      expect(row.monitorAttemptCount).toBe(1); expect(await wakes()).toHaveLength(0);
      fixture.runs = [run("build", "success"), run("test", "success")]; saveFixture();
      const second = await start();
      try { expect(second.pid).not.toBe(first.pid); await tick(second, row.monitorNextCheckAt!); } finally { await stop(second); }
      expect(await wakes()).toHaveLength(1);
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(2);
    }, 60000);
  });

});
