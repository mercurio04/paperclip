import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import {
  beginLocalNativeSessionTerminationProof,
  completeTerminatedLocalNativeSessionCleanup,
  localNativeSessionCleanupQuarantined,
} from "../../vendor/paperclip-runner/index.js";

/**
 * Bounded termination of the dedicated local processes of ONE native run:
 * its `paperclip-runnerd` process group (recorded on the run row at spawn)
 * and every provider process group runnerd reported through
 * `provider_startup_ownership` (the OpenCode proxy + `opencode serve`).
 *
 * Selection verifies each group leader from /proc (pid is the group leader and
 * its kernel start time matches the recorded window) and keeps that verified
 * identity (pid, pgid, start time) in the target. The identity is re-read from
 * /proc immediately before every signal: each liveness probe during the settle
 * and grace waits, the SIGTERM and the SIGKILL escalation. If the leader's
 * identity changed, or the leader is gone while its group still answers
 * (ambiguous), nothing more is sent to that group, escalation stops for it and
 * the change is recorded as `identity_changed`. A residual race between the
 * /proc read and kill(2) remains (Node has no pidfd signalling).
 *
 * The in-process cleanup quarantine of the run is never pre-empted: only after
 * every selected group was proven terminated (no survivors, no identity change,
 * no unverifiable recorded process, no signalling error) may the reaper release
 * the quarantine entry of exactly this run + runner instance. A recorded group
 * that already exited counts only when verifiably dead: nothing answers for
 * its pid/group, or its pid now belongs to a process started after the
 * recorded spawn window. While the proof runs, the agent's next admission waits
 * (bounded) for the verdict rather than failing on a quarantine about to be
 * released; a kept quarantine still fails it closed.
 */

export const NATIVE_DEDICATED_PROCESSES_TERMINATED = "native.dedicated_processes_terminated";

export type LinuxProcessStat = { pid: number; ppid: number; pgid: number; state: string; startedAtMs: number };

let bootTimeMs: number | null = null;
function readBootTimeMs(): number | null {
  if (bootTimeMs !== null) return bootTimeMs;
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
    const value = line ? Number(line.slice(6).trim()) : NaN;
    bootTimeMs = Number.isFinite(value) ? value * 1000 : null;
  } catch {
    bootTimeMs = null;
  }
  return bootTimeMs;
}

/** Parse /proc/<pid>/stat. Start time has ~1s precision (btime is in seconds). */
export function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    const boot = readBootTimeMs();
    const ticks = Number(fields[19]);
    if (boot === null || !Number.isFinite(ticks)) return null;
    return {
      pid,
      state: fields[0] ?? "?",
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      startedAtMs: boot + (ticks * 1000) / 100, // USER_HZ is 100 on Linux
    };
  } catch {
    return null;
  }
}

export type NativeDedicatedProcessTarget = {
  role: "runnerd" | "provider";
  processGroupId: number;
  /** Verified group leader identity (pid === processGroupId). */
  pid: number;
  startedAtMs: number;
};

export type NativeDedicatedReaperDeps = {
  readStat: (pid: number) => LinuxProcessStat | null;
  signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const START_TOLERANCE_MS = 3_000;
/** Both values come from the same /proc computation; only float noise is tolerated. */
const IDENTITY_TOLERANCE_MS = 10;

const defaultDeps: NativeDedicatedReaperDeps = {
  readStat: readLinuxProcessStat,
  signalGroup: (pgid, signal) => {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      // EPERM means alive but not ours: never treat it as ours.
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now: () => Date.now(),
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Pure identity selection; exported for tests. */
export function selectNativeDedicatedProcessTargets(input: {
  runner: { pid: number | null; processGroupId: number | null; startedAt: Date | null } | null;
  providerSpawns: Array<{ processId: unknown; processGroupId: unknown; recordedAt: Date }>;
  runStartedAt: Date | null;
  deps: Pick<NativeDedicatedReaperDeps, "readStat">;
  selfPid?: number;
}): NativeDedicatedProcessTarget[] {
  const selfPid = input.selfPid ?? process.pid;
  const selfGroup = input.deps.readStat(selfPid)?.pgid ?? null;
  const targets: NativeDedicatedProcessTarget[] = [];
  const forbidden = (pid: number) => pid <= 1 || pid === selfPid || pid === selfGroup;
  let runnerStartMs: number | null = null;
  let runnerAlivePid: number | null = null;
  const runner = input.runner;
  if (runner?.pid && runner.processGroupId === runner.pid && runner.startedAt && !forbidden(runner.pid)) {
    const stat = input.deps.readStat(runner.pid);
    runnerStartMs = runner.startedAt.getTime();
    if (
      stat && stat.state !== "Z" && stat.pgid === runner.pid &&
      Math.abs(stat.startedAtMs - runnerStartMs) <= START_TOLERANCE_MS
    ) {
      targets.push({ role: "runnerd", processGroupId: runner.pid, pid: runner.pid, startedAtMs: stat.startedAtMs });
      runnerAlivePid = runner.pid;
    }
  }
  const lowerBound = runnerStartMs ?? input.runStartedAt?.getTime() ?? null;
  for (const spawn of input.providerSpawns) {
    const pid = spawn.processId;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid !== spawn.processGroupId || forbidden(pid)) continue;
    if (targets.some((target) => target.processGroupId === pid) || lowerBound === null) continue;
    const stat = input.deps.readStat(pid);
    if (!stat || stat.state === "Z" || stat.pgid !== pid) continue;
    // The provider group leader must have started between this run's runnerd
    // start and runnerd's spawn report; a recycled PID starts later.
    if (stat.startedAtMs < lowerBound - START_TOLERANCE_MS ||
        stat.startedAtMs > spawn.recordedAt.getTime() + START_TOLERANCE_MS) continue;
    // While runnerd lives, its provider must still be its direct child.
    if (runnerAlivePid !== null && stat.ppid !== runnerAlivePid) continue;
    targets.push({ role: "provider", processGroupId: pid, pid, startedAtMs: stat.startedAtMs });
  }
  return targets;
}

type GroupState = "alive" | "gone" | "identity_changed";

/**
 * Re-verify a target from /proc right now. A matching live leader is alive. A
 * matching zombie leader still pins the PID (no reuse), so its group is probed
 * with the null signal. Any mismatch is a changed identity. A vanished leader
 * whose group still answers the null signal cannot be re-verified: ambiguous,
 * treated as a changed identity (never signalled again).
 */
function inspectTarget(target: NativeDedicatedProcessTarget, deps: NativeDedicatedReaperDeps): GroupState {
  const stat = deps.readStat(target.pid);
  if (stat) {
    if (stat.pid !== target.pid || stat.pgid !== target.processGroupId ||
        Math.abs(stat.startedAtMs - target.startedAtMs) > IDENTITY_TOLERANCE_MS) return "identity_changed";
    if (stat.state !== "Z") return "alive";
    return deps.signalGroup(target.processGroupId, 0) ? "alive" : "gone";
  }
  return deps.signalGroup(target.processGroupId, 0) ? "identity_changed" : "gone";
}

export type NativeDedicatedSignalOutcome = {
  terminated: NativeDedicatedProcessTarget[];
  killed: NativeDedicatedProcessTarget[];
  survivors: NativeDedicatedProcessTarget[];
  identityChanged: Array<NativeDedicatedProcessTarget & { phase: string }>;
  signalErrors: Array<NativeDedicatedProcessTarget & { signal: NodeJS.Signals }>;
  /** Every target is gone, none changed identity and every signal was delivered. */
  proven: boolean;
};

/**
 * Optionally wait `settleMs` for a natural exit, then SIGTERM, wait `graceMs`,
 * SIGKILL survivors. Every liveness probe and signal re-verifies the identity.
 */
export async function signalNativeDedicatedProcessGroups(
  targets: NativeDedicatedProcessTarget[],
  options: { graceMs: number; killWaitMs: number; settleMs?: number },
  deps: NativeDedicatedReaperDeps = defaultDeps,
): Promise<NativeDedicatedSignalOutcome> {
  const changed = new Set<NativeDedicatedProcessTarget>();
  const identityChanged: NativeDedicatedSignalOutcome["identityChanged"] = [];
  const signalErrors: NativeDedicatedSignalOutcome["signalErrors"] = [];
  const check = (target: NativeDedicatedProcessTarget, phase: string): GroupState => {
    if (changed.has(target)) return "identity_changed";
    const state = inspectTarget(target, deps);
    if (state === "identity_changed") {
      changed.add(target);
      identityChanged.push({ ...target, phase });
    }
    return state;
  };
  const stillAlive = (pending: NativeDedicatedProcessTarget[], phase: string) =>
    pending.filter((target) => check(target, phase) === "alive");
  const waitGone = async (pending: NativeDedicatedProcessTarget[], ms: number, phase: string, step: number) => {
    const deadline = deps.now() + ms;
    let left = stillAlive(pending, phase);
    while (left.length > 0 && deps.now() < deadline) {
      await deps.sleep(step);
      left = stillAlive(left, phase);
    }
    return left;
  };
  const send = (pending: NativeDedicatedProcessTarget[], signal: NodeJS.Signals, phase: string) => {
    const sent: NativeDedicatedProcessTarget[] = [];
    for (const target of pending) {
      // Re-verified immediately before the signal; never sent on mismatch.
      if (check(target, phase) !== "alive") continue;
      sent.push(target);
      if (!deps.signalGroup(target.processGroupId, signal)) signalErrors.push({ ...target, signal });
    }
    return sent;
  };
  const settled = (options.settleMs ?? 0) > 0
    ? await waitGone(targets, options.settleMs!, "settle", 250)
    : targets;
  const terminated = send(settled, "SIGTERM", "before_sigterm");
  const afterTerm = await waitGone(terminated, options.graceMs, "grace", 100);
  const killed = send(afterTerm, "SIGKILL", "before_sigkill");
  const survivors = await waitGone(killed, options.killWaitMs, "after_sigkill", 100);
  return {
    terminated,
    killed,
    survivors,
    identityChanged,
    signalErrors,
    proven: survivors.length === 0 && identityChanged.length === 0 && signalErrors.length === 0,
  };
}

/**
 * Terminate the dedicated runnerd/provider groups of a local native run and
 * record the outcome as a server-authored run event. Remote runs are skipped
 * (their PIDs do not live in this host's process table).
 */
export async function terminateNativeDedicatedProcesses(input: {
  db: Db;
  run: {
    id: string;
    companyId: string;
    agentId: string;
    runtimeMode: string | null;
    processPid: number | null;
    processGroupId: number | null;
    processStartedAt: Date | null;
    runnerInstanceId?: string | null;
    startedAt?: Date | null;
  };
  reason: "board_cancel" | "restart_recovery_blocked";
  /** Wait for a natural exit before signalling (the owner may close it itself). */
  settleMs?: number;
  graceMs?: number;
  killWaitMs?: number;
  /** After proof, how long to wait for the owner's failed close to quarantine. */
  quarantineWaitMs?: number;
  deps?: NativeDedicatedReaperDeps;
}) {
  const deps = input.deps ?? defaultDeps;
  if (input.run.runtimeMode !== "native" || (process.platform !== "linux" && !input.deps)) return null;
  // While this proof runs, a later admission of the same cleanup domain waits
  // (bounded) for the verdict instead of failing fast on the quarantine this
  // reaper may release. It suppresses nothing: the owner's failed close still
  // quarantines, and only a proven termination below releases it.
  const proof = input.reason === "board_cancel" && input.run.runnerInstanceId
    ? beginLocalNativeSessionTerminationProof({
      companyId: input.run.companyId,
      runId: input.run.id,
      runnerInstanceId: input.run.runnerInstanceId,
      maxWaitMs: (input.settleMs ?? 0) + (input.graceMs ?? 5_000) + (input.killWaitMs ?? 2_000) +
        (input.quarantineWaitMs ?? 15_000) + 5_000,
    })
    : null;
  try {
    return await terminateVerifiedNativeDedicatedProcesses(input, deps);
  } finally {
    proof?.settle();
  }
}

/**
 * A recorded process that is not a selected target is proven dead when nothing
 * answers for its pid/group, or when its pid now belongs to a process that
 * started after the recorded spawn window (Linux never reuses a pid while a
 * process group with that id still exists, so our group is gone as well).
 * Anything else (live mismatch, zombie leader with a live group, malformed
 * record) is unknown and keeps the quarantine.
 */
function recordedProcessProvenDead(
  pid: unknown,
  latestOwnStartMs: number | null,
  deps: NativeDedicatedReaperDeps,
): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  const stat = deps.readStat(pid);
  if (stat) {
    return latestOwnStartMs !== null && stat.startedAtMs > latestOwnStartMs + START_TOLERANCE_MS;
  }
  return !deps.signalGroup(pid, 0);
}

async function terminateVerifiedNativeDedicatedProcesses(
  input: Parameters<typeof terminateNativeDedicatedProcesses>[0],
  deps: NativeDedicatedReaperDeps,
) {
  const leases = await input.db.select({ provider: environmentLeases.provider })
    .from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, input.run.companyId), eq(environmentLeases.heartbeatRunId, input.run.id)));
  if (leases.some((lease) => lease.provider !== "local")) return null;
  const diagnostics = await input.db.select({ payload: heartbeatRunEvents.payload, createdAt: heartbeatRunEvents.createdAt })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, input.run.companyId),
      eq(heartbeatRunEvents.runId, input.run.id),
      eq(heartbeatRunEvents.eventType, "harness.diagnostic"),
    ));
  const providerSpawns = diagnostics.flatMap((event) => {
    const payload = record(event.payload);
    const prp = record(record(payload.prpEvent).payload);
    const body = Object.keys(prp).length > 0 ? prp : payload;
    const startup = record(body.startup);
    if (body.code !== "provider_startup_ownership" || startup.phase !== "spawned") return [];
    return [{ processId: startup.processId, processGroupId: startup.processGroupId, recordedAt: event.createdAt }];
  });
  const targets = selectNativeDedicatedProcessTargets({
    runner: { pid: input.run.processPid, processGroupId: input.run.processGroupId, startedAt: input.run.processStartedAt },
    providerSpawns,
    runStartedAt: input.run.startedAt ?? null,
    deps,
  });
  // Recorded processes that are neither verified targets nor proven dead are
  // unknown state: never signalled, and they block the quarantine release.
  const recorded: Array<{ role: "runnerd" | "provider"; processId: unknown; latestOwnStartMs: number | null }> = [
    ...(input.run.processPid != null
      ? [{ role: "runnerd" as const, processId: input.run.processPid,
        latestOwnStartMs: input.run.processStartedAt?.getTime() ?? null }]
      : []),
    ...providerSpawns.map((spawn) => ({ role: "provider" as const, processId: spawn.processId,
      latestOwnStartMs: spawn.recordedAt.getTime() })),
  ];
  const unverified = recorded
    .filter(({ processId: pid, latestOwnStartMs }) =>
      !targets.some((target) => target.pid === pid) && !recordedProcessProvenDead(pid, latestOwnStartMs, deps))
    .map(({ role, processId }) => ({ role, processId }));
  if (targets.length === 0 && unverified.length === 0 && input.reason !== "board_cancel") {
    return { targets: [], terminated: [], killed: [], survivors: [], identityChanged: [], signalErrors: [],
      unverified: [], terminationProven: input.run.processPid != null, cleanupQuarantine: null };
  }
  const outcome = await signalNativeDedicatedProcessGroups(
    targets,
    { settleMs: input.settleMs ?? 0, graceMs: input.graceMs ?? 5_000, killWaitMs: input.killWaitMs ?? 2_000 },
    deps,
  );
  // Proof covers every recorded process of the run: the runnerd identity must
  // have been recorded, and each recorded group is either signalled to a
  // proven exit or was already verifiably gone (absent / pid reused later).
  const terminationProven = input.run.processPid != null && unverified.length === 0 && outcome.proven;
  // The in-process owner of a cancelled session cannot prove a durable
  // suspension once its runner was killed and quarantines the cleanup as
  // usual. Only now, with termination proven, may the quarantine entry of
  // exactly this run + runner instance be released; otherwise it stays.
  let cleanupQuarantine: "released" | "kept" | "not_observed" | null = null;
  if (input.reason === "board_cancel" && input.run.runnerInstanceId) {
    cleanupQuarantine = localNativeSessionCleanupQuarantined({ companyId: input.run.companyId, runId: input.run.id })
      ? "kept" : "not_observed";
    if (terminationProven) {
      const deadline = deps.now() + (input.quarantineWaitMs ?? 15_000);
      for (;;) {
        if (localNativeSessionCleanupQuarantined({ companyId: input.run.companyId, runId: input.run.id })) {
          cleanupQuarantine = "kept";
          if (completeTerminatedLocalNativeSessionCleanup({
            companyId: input.run.companyId, runId: input.run.id, runnerInstanceId: input.run.runnerInstanceId,
          })) {
            cleanupQuarantine = "released";
            break;
          }
        }
        if (deps.now() >= deadline) break;
        await deps.sleep(100);
      }
    }
  }
  const anomaly = outcome.identityChanged.length > 0 || outcome.signalErrors.length > 0 || unverified.length > 0;
  await appendHeartbeatRunEvent(input.db, {
    companyId: input.run.companyId,
    runId: input.run.id,
    agentId: input.run.agentId,
    eventType: NATIVE_DEDICATED_PROCESSES_TERMINATED,
    stream: "system",
    level: outcome.survivors.length > 0 ? "error" : anomaly ? "warn" : "info",
    message: outcome.survivors.length > 0
      ? "Dedicated native runner/provider processes survived SIGKILL."
      : anomaly
        ? "Dedicated native runner/provider termination could not be proven; cleanup stays quarantined."
        : "Dedicated native runner/provider processes terminated.",
    payload: {
      reason: input.reason,
      targets: outcome.terminated,
      sigkilled: outcome.killed,
      survivors: outcome.survivors,
      identity_changed: outcome.identityChanged,
      signalErrors: outcome.signalErrors,
      unverified,
      terminationProven,
      cleanupQuarantine,
    },
  });
  return { targets, ...outcome, unverified, terminationProven, cleanupQuarantine };
}
