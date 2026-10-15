import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import {
  authorizeTerminatedLocalNativeSessionCleanup,
  completeTerminatedLocalNativeSessionCleanup,
  localNativeSessionCleanupQuarantined,
} from "../../vendor/paperclip-runner/index.js";

/**
 * Bounded termination of the dedicated local processes of ONE native run:
 * its `paperclip-runnerd` process group (recorded on the run row at spawn)
 * and every provider process group runnerd reported through
 * `provider_startup_ownership` (the OpenCode proxy + `opencode serve`).
 *
 * Identity is re-verified from /proc before any signal (pid is the group
 * leader and its kernel start time matches the recorded window), so a reused
 * PID or an unrelated/shared process (e.g. a shared llama-server, the server
 * itself) is never signalled. Graceful SIGTERM first, SIGKILL after the grace.
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
};

export type NativeDedicatedReaperDeps = {
  readStat: (pid: number) => LinuxProcessStat | null;
  signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const START_TOLERANCE_MS = 3_000;

const defaultDeps: NativeDedicatedReaperDeps = {
  readStat: readLinuxProcessStat,
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
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
      targets.push({ role: "runnerd", processGroupId: runner.pid });
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
    targets.push({ role: "provider", processGroupId: pid });
  }
  return targets;
}

/** Signal verified groups: SIGTERM, wait `graceMs`, SIGKILL survivors. */
export async function signalNativeDedicatedProcessGroups(
  targets: NativeDedicatedProcessTarget[],
  options: { graceMs: number; killWaitMs: number },
  deps: NativeDedicatedReaperDeps = defaultDeps,
) {
  const alive = (target: NativeDedicatedProcessTarget) => deps.signalGroup(target.processGroupId, 0);
  const waitGone = async (pending: NativeDedicatedProcessTarget[], ms: number) => {
    const deadline = deps.now() + ms;
    let left = pending.filter(alive);
    while (left.length > 0 && deps.now() < deadline) {
      await deps.sleep(100);
      left = left.filter(alive);
    }
    return left;
  };
  const terminated = targets.filter(alive);
  for (const target of terminated) deps.signalGroup(target.processGroupId, "SIGTERM");
  const afterTerm = await waitGone(terminated, options.graceMs);
  for (const target of afterTerm) deps.signalGroup(target.processGroupId, "SIGKILL");
  const survivors = await waitGone(afterTerm, options.killWaitMs);
  return { terminated, killed: afterTerm, survivors };
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
  quarantineWaitMs?: number;
  deps?: NativeDedicatedReaperDeps;
}) {
  const deps = input.deps ?? defaultDeps;
  if (input.run.runtimeMode !== "native" || (process.platform !== "linux" && !input.deps)) return null;
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
  const select = () => selectNativeDedicatedProcessTargets({
    runner: { pid: input.run.processPid, processGroupId: input.run.processGroupId, startedAt: input.run.processStartedAt },
    providerSpawns,
    runStartedAt: input.run.startedAt ?? null,
    deps,
  });
  let targets = select();
  if (targets.length > 0 && (input.settleMs ?? 0) > 0) {
    const deadline = deps.now() + input.settleMs!;
    while (deps.now() < deadline && targets.some((t) => deps.signalGroup(t.processGroupId, 0))) await deps.sleep(250);
    targets = targets.filter((t) => deps.signalGroup(t.processGroupId, 0));
  }
  if (targets.length === 0) return { targets: [], terminated: [], killed: [], survivors: [] };
  const authorization = input.reason === "board_cancel" && input.run.runnerInstanceId
    ? authorizeTerminatedLocalNativeSessionCleanup({
      companyId: input.run.companyId, runId: input.run.id, runnerInstanceId: input.run.runnerInstanceId,
    })
    : null;
  const outcome = await signalNativeDedicatedProcessGroups(
    targets,
    { graceMs: input.graceMs ?? 5_000, killWaitMs: input.killWaitMs ?? 2_000 },
    deps,
  );
  // The in-process owner of a cancelled session cannot prove a durable
  // suspension once its runner was killed and would quarantine the cleanup,
  // blocking every later session of the agent. The authorization above (taken
  // before signalling, for this exact run + runner instance) suppresses that
  // quarantine; it is revoked if any group survived. A quarantine that already
  // existed is retired only after every recorded group is proven absent.
  if (outcome.survivors.length > 0) authorization?.revoke();
  let quarantineRetired: boolean | null = null;
  if (input.reason === "board_cancel" && outcome.survivors.length === 0 && input.run.runnerInstanceId) {
    quarantineRetired = !localNativeSessionCleanupQuarantined({ companyId: input.run.companyId, runId: input.run.id });
    const deadline = deps.now() + (input.quarantineWaitMs ?? 15_000);
    while (!quarantineRetired && deps.now() < deadline) {
      if (localNativeSessionCleanupQuarantined({ companyId: input.run.companyId, runId: input.run.id }) &&
          completeTerminatedLocalNativeSessionCleanup({
            companyId: input.run.companyId, runId: input.run.id, runnerInstanceId: input.run.runnerInstanceId,
          })) {
        quarantineRetired = true;
        break;
      }
      await deps.sleep(100);
    }
  }
  await appendHeartbeatRunEvent(input.db, {
    companyId: input.run.companyId,
    runId: input.run.id,
    agentId: input.run.agentId,
    eventType: NATIVE_DEDICATED_PROCESSES_TERMINATED,
    stream: "system",
    level: outcome.survivors.length > 0 ? "error" : "info",
    message: outcome.survivors.length > 0
      ? "Dedicated native runner/provider processes survived SIGKILL."
      : "Dedicated native runner/provider processes terminated.",
    payload: {
      reason: input.reason,
      targets: outcome.terminated,
      sigkilled: outcome.killed,
      survivors: outcome.survivors,
      quarantineRetired,
    },
  });
  return { targets, ...outcome, quarantineRetired };
}
