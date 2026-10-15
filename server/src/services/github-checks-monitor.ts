import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { buildIssueMonitorRescheduledPatch } from "./issue-execution-policy.js";
import { GithubProbeError, ghRead, probeGithubChecks, type GithubChecksTarget, type GithubProbeEvent } from "./github-checks-probe.js";

type Claim = Pick<typeof issues.$inferSelect, "id" | "companyId" | "assigneeAgentId" | "monitorNextCheckAt" | "monitorWakeRequestedAt" | "executionPolicy">;
type ProbeState = {
  version: 1;
  target: string;
  checks?: unknown;
  consecutiveErrors: number;
  intervalMinutes: number;
  pendingEvent?: GithubProbeEvent;
};
export function githubChecksMonitorEnabled() {
  return process.env.PAPERCLIP_GITHUB_CHECKS_MONITOR_ENABLED === "true";
}

/** CAS protects a concurrent clear, close, reassignment, rearm or expired claim. */
export function githubMonitorClaimCondition(claim: Claim) {
  return and(
    eq(issues.id, claim.id), eq(issues.companyId, claim.companyId),
    eq(issues.monitorWakeRequestedAt, claim.monitorWakeRequestedAt!),
    eq(issues.monitorNextCheckAt, claim.monitorNextCheckAt!),
    eq(issues.assigneeAgentId, claim.assigneeAgentId!), isNull(issues.assigneeUserId),
    inArray(issues.status, ["in_progress", "in_review"]),
    sql`${issues.executionPolicy} = ${JSON.stringify(claim.executionPolicy)}::jsonb`,
  );
}

export async function dispatchGithubChecksMonitor<T>(input: {
  db: Db;
  claim: Claim;
  policy: IssueExecutionPolicy;
  now: Date;
  dispatch: (claim: typeof issues.$inferSelect, event?: GithubProbeEvent, now?: Date) => Promise<T>;
}): Promise<T | { outcome: "rescheduled" | "skipped" }> {
  const { db, claim, policy, now } = input;
  const monitor = policy.monitor!;
  const target = monitor as GithubChecksTarget;
  const targetKey = JSON.stringify([target.repo, target.prNumber, target.headSha, target.expectedChecks,
    target.intervalMinutes, monitor.timeoutAt, monitor.maxAttempts]);
  // Serialize the complete dispatch, including delivery, across server processes.
  // No row lock is held here: enqueueWakeup takes its own issue/agent locks.
  // A process crash releases this lock; the existing 5-minute claim lease recovers.
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-checks:${claim.companyId}:${claim.id}`}, 0))`);
    const current = await db.select().from(issues).where(githubMonitorClaimCondition(claim)).then(rows => rows[0]);
    if (!current) return { outcome: "skipped" as const };
    const previous = current.monitorProbeState as ProbeState | null;
    const state = previous?.version === 1 && previous.target === targetKey ? previous : null;
    // A crash after probe or wake delivery must not query GitHub or deliver twice.
    if (state?.pendingEvent) {
      return input.dispatch({ ...current, monitorAttemptCount: Math.max(0, current.monitorAttemptCount - 1) }, state.pendingEvent);
    }
    const timeout = new Date(monitor.timeoutAt!).getTime();
    if (now.getTime() >= timeout || current.monitorAttemptCount >= monitor.maxAttempts!) {
      return input.dispatch(current);
    }
    const attempt = current.monitorAttemptCount + 1;
    // Count the poll before I/O, including a failed query or a process crash.
    const [reserved] = await db.update(issues).set({ monitorAttemptCount: attempt })
      .where(githubMonitorClaimCondition(claim)).returning({ id: issues.id });
    if (!reserved) return { outcome: "skipped" as const };
    const intervalMinutes = Math.min(30, Math.max(5, state ? state.intervalMinutes * 1.5 : target.intervalMinutes));
    let nextState: ProbeState = { version: 1, target: targetKey, intervalMinutes, consecutiveErrors: 0 };
    let event: GithubProbeEvent | null = null;
    let cancelled = false;
    const started = performance.now();
    try {
      const result = await probeGithubChecks(target, async (endpoint, signal) => {
        const [live] = await db.select({ id: issues.id }).from(issues).where(githubMonitorClaimCondition(claim));
        if (!live) { cancelled = true; throw new GithubProbeError("transient"); }
        return ghRead(endpoint, signal);
      });
      nextState.checks = result.checks;
      event = result.event;
    } catch (error) {
      if (cancelled) return { outcome: "skipped" as const };
      const probeError = error instanceof GithubProbeError ? error : new GithubProbeError("transient");
      const consecutiveErrors = (state?.consecutiveErrors ?? 0) + 1;
      nextState.consecutiveErrors = consecutiveErrors;
      nextState.checks = state?.checks;
      if (probeError.kind === "access" || consecutiveErrors >= 3) {
        event = { reason: "probe_error", repo: target.repo, prNumber: target.prNumber, headSha: target.headSha,
          allGreen: false, probeError: { kind: probeError.kind, status: probeError.status, consecutiveErrors } };
      }
    }
    // Use elapsed I/O time for the deadline, while allowing deterministic tick dates.
    const finishedAt = new Date(now.getTime() + (performance.now() - started));
    if (finishedAt.getTime() >= timeout) {
      const [saved] = await db.update(issues).set({ monitorProbeState: nextState })
        .where(githubMonitorClaimCondition(claim)).returning();
      return saved ? input.dispatch(saved, undefined, finishedAt) : { outcome: "skipped" as const };
    }
    if (event) {
      nextState.pendingEvent = event;
      const [saved] = await db.update(issues).set({ monitorProbeState: nextState })
        .where(githubMonitorClaimCondition(claim)).returning();
      if (!saved) return { outcome: "skipped" as const };
      return input.dispatch({ ...saved, monitorAttemptCount: attempt - 1 }, event);
    }
    if (attempt >= monitor.maxAttempts!) {
      const [saved] = await db.update(issues).set({ monitorProbeState: nextState })
        .where(githubMonitorClaimCondition(claim)).returning();
      return saved ? input.dispatch(saved, undefined, finishedAt) : { outcome: "skipped" as const };
    }
    const nextCheckAt = new Date(Math.min(timeout, finishedAt.getTime() + intervalMinutes * 60_000));
    const [saved] = await db.update(issues).set({
      ...buildIssueMonitorRescheduledPatch({ issue: { ...current, monitorAttemptCount: attempt }, policy, nextCheckAt }),
      monitorProbeState: nextState, updatedAt: finishedAt,
    }).where(githubMonitorClaimCondition(claim)).returning({ id: issues.id });
    return { outcome: saved ? "rescheduled" as const : "skipped" as const };
  });
}
