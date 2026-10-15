import { describe, expect, it, vi } from "vitest";
import {
  selectNativeDedicatedProcessTargets,
  signalNativeDedicatedProcessGroups,
  terminateNativeDedicatedProcesses,
  type LinuxProcessStat,
  type LinuxProcessStatRead,
  type NativeDedicatedSignalResult,
} from "./native-dedicated-process-reaper.js";

const vendor = vi.hoisted(() => ({
  quarantined: new Set<string>(),
  released: [] as unknown[],
  log: [] as string[],
}));
vi.mock("../heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: vi.fn(async () => {}) }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({
  localNativeSessionCleanupQuarantined: ({ runId }: { runId: string }) => vendor.quarantined.has(runId),
  beginLocalNativeSessionTerminationProof: (binding: { runId: string }) => {
    vendor.log.push(`begin:${binding.runId}`);
    return { settle: () => vendor.log.push(`settle:${binding.runId}`) };
  },
  completeTerminatedLocalNativeSessionCleanup: (binding: { runId: string }) => {
    vendor.log.push(`release:${binding.runId}`);
    vendor.released.push(binding);
    vendor.quarantined.delete(binding.runId);
    return true;
  },
}));

const T0 = Date.parse("2026-10-15T07:00:00.000Z");
const stat = (pid: number, pgid: number, ppid: number, startedAtMs: number, state = "S"): LinuxProcessStat =>
  ({ pid, pgid, ppid, startedAtMs, state });

describe("native dedicated process reaper identity", () => {
  const table = new Map<number, LinuxProcessStat>([
    [100, stat(100, 100, 1, T0 - 60_000)], // server itself
    [382, stat(382, 382, 100, T0 + 200)], // runnerd
    [383, stat(383, 383, 382, T0 + 1_500)], // opencode proxy group leader
    [500, stat(500, 500, 1, T0 + 90_000)], // recycled pid / shared llama-server started later
    [600, stat(600, 601, 382, T0 + 1_600)], // not a group leader
  ]);
  const deps = { readStat: (pid: number) => table.get(pid) ?? null };
  const spawnedAt = new Date(T0 + 2_000);

  it("selects only the verified runnerd and provider groups of the run", () => {
    expect(selectNativeDedicatedProcessTargets({
      runner: { pid: 382, processGroupId: 382, startedAt: new Date(T0) },
      providerSpawns: [
        { processId: 383, processGroupId: 383, recordedAt: spawnedAt },
        { processId: 500, processGroupId: 500, recordedAt: spawnedAt },
        { processId: 600, processGroupId: 600, recordedAt: spawnedAt },
        { processId: 100, processGroupId: 100, recordedAt: spawnedAt },
      ],
      runStartedAt: new Date(T0 - 1_000),
      deps,
      selfPid: 100,
    })).toEqual([
      { role: "runnerd", processGroupId: 382, pid: 382, startedAtMs: T0 + 200 },
      { role: "provider", processGroupId: 383, pid: 383, startedAtMs: T0 + 1_500 },
    ]);
  });

  it("refuses a runnerd PID whose start time does not match (PID reuse)", () => {
    expect(selectNativeDedicatedProcessTargets({
      runner: { pid: 500, processGroupId: 500, startedAt: new Date(T0) },
      providerSpawns: [],
      runStartedAt: null,
      deps,
      selfPid: 100,
    })).toEqual([]);
  });

  it("after runnerd died, still reaps the orphaned provider group within the spawn window", () => {
    const orphan = new Map(table);
    orphan.delete(382);
    orphan.set(383, stat(383, 383, 1, T0 + 1_500));
    expect(selectNativeDedicatedProcessTargets({
      runner: { pid: 382, processGroupId: 382, startedAt: new Date(T0) },
      providerSpawns: [{ processId: 383, processGroupId: 383, recordedAt: spawnedAt }],
      runStartedAt: null,
      deps: { readStat: (pid) => orphan.get(pid) ?? null },
      selfPid: 100,
    })).toEqual([{ role: "provider", processGroupId: 383, pid: 383, startedAtMs: T0 + 1_500 }]);
  });
});

describe("native dedicated process group signalling", () => {
  const runnerd = { role: "runnerd" as const, processGroupId: 382, pid: 382, startedAtMs: T0 + 200 };
  const provider = { role: "provider" as const, processGroupId: 383, pid: 383, startedAtMs: T0 + 1_500 };
  const harness = () => {
    const procs = new Map<number, LinuxProcessStat>([[382, stat(382, 382, 100, T0 + 200)], [383, stat(383, 383, 382, T0 + 1_500)]]);
    const signals: string[] = [];
    let clock = 0;
    const deps = {
      readStat: (pid: number): LinuxProcessStatRead => procs.get(pid) ?? null,
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0): NativeDedicatedSignalResult => {
        if (signal === 0) return procs.has(pgid);
        signals.push(`${signal}:${pgid}`);
        return true;
      },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    };
    return { procs, signals, deps };
  };

  it("sends SIGTERM, then SIGKILL only to verified groups that outlive the grace", async () => {
    const { procs, signals, deps } = harness();
    const signalGroup = deps.signalGroup;
    deps.signalGroup = (pgid, signal) => {
      const result = signalGroup(pgid, signal);
      if ((signal === "SIGTERM" && pgid === 382) || signal === "SIGKILL") procs.delete(pgid);
      return result;
    };
    const outcome = await signalNativeDedicatedProcessGroups([runnerd, provider], { graceMs: 1_000, killWaitMs: 500 }, deps);
    expect(signals).toEqual(["SIGTERM:382", "SIGTERM:383", "SIGKILL:383"]);
    expect(outcome.killed).toEqual([provider]);
    expect(outcome.survivors).toEqual([]);
    expect(outcome.identityChanged).toEqual([]);
    expect(outcome.proven).toBe(true);
  });

  it("never signals a group whose leader vanished while the group still answers (ambiguous)", async () => {
    const { procs, signals, deps } = harness();
    procs.delete(382);
    deps.signalGroup = (pgid, signal) => {
      if (signal === 0) return true;
      signals.push(`${signal}:${pgid}`);
      return true;
    };
    const outcome = await signalNativeDedicatedProcessGroups([runnerd], { graceMs: 1_000, killWaitMs: 500 }, deps);
    expect(signals).toEqual([]);
    expect(outcome.identityChanged).toEqual([{ ...runnerd, phase: "before_sigterm" }]);
    expect(outcome.proven).toBe(false);
  });

  it("stops and is not proven when the leader becomes unverifiable (EPERM probe of a zombie leader) (H14)", async () => {
    const { procs, signals, deps } = harness();
    procs.set(382, stat(382, 382, 100, T0 + 200, "Z"));
    const signalGroup = deps.signalGroup;
    deps.signalGroup = (pgid, signal) => signal === 0 && pgid === 382 ? "error" as const : signalGroup(pgid, signal);
    const outcome = await signalNativeDedicatedProcessGroups([runnerd], { graceMs: 1_000, killWaitMs: 500 }, deps);
    expect(signals).toEqual([]);
    expect(outcome.unverifiable).toEqual([{ ...runnerd, phase: "before_sigterm" }]);
    expect(outcome.proven).toBe(false);
  });

  it("stops and is not proven when /proc becomes unreadable during the grace (H14)", async () => {
    const { procs, signals, deps } = harness();
    let unreadable = false;
    const readStat = deps.readStat;
    deps.readStat = (pid: number) => unreadable && pid === 383 ? "unreadable" : readStat(pid);
    const signalGroup = deps.signalGroup;
    deps.signalGroup = (pgid, signal) => {
      const result = signalGroup(pgid, signal);
      if (signal === "SIGTERM" && pgid === 382) procs.delete(382);
      if (signal === "SIGTERM" && pgid === 383) unreadable = true;
      return result;
    };
    const outcome = await signalNativeDedicatedProcessGroups([runnerd, provider], { graceMs: 1_000, killWaitMs: 500 }, deps);
    expect(signals).toEqual(["SIGTERM:382", "SIGTERM:383"]);
    expect(outcome.unverifiable).toEqual([{ ...provider, phase: "grace" }]);
    expect(outcome.proven).toBe(false);
  });

  it("is not proven when a signal could not be delivered", async () => {
    const { procs, deps } = harness();
    deps.signalGroup = (pgid, signal) => {
      if (signal === 0) return procs.has(pgid);
      procs.delete(pgid);
      return false;
    };
    const outcome = await signalNativeDedicatedProcessGroups([runnerd], { graceMs: 1_000, killWaitMs: 500 }, deps);
    expect(outcome.signalErrors).toEqual([{ ...runnerd, signal: "SIGTERM" }]);
    expect(outcome.survivors).toEqual([]);
    expect(outcome.proven).toBe(false);
  });
});

describe("native dedicated process reaper cleanup quarantine", () => {
  const run = {
    id: "reap-run", companyId: "company", agentId: "agent", runtimeMode: "native",
    processPid: 382, processGroupId: 382, processStartedAt: new Date(T0), runnerInstanceId: "runner-1",
  };
  const db = () => {
    const answers: unknown[][] = [[], []];
    return { select: () => ({ from: () => ({ where: async () => answers.shift() }) }) } as any;
  };
  const deps = (onSignal: (signal: NodeJS.Signals, procs: Map<number, LinuxProcessStat>) => void) => {
    const procs = new Map([[382, stat(382, 382, 100, T0 + 200)]]);
    let clock = T0 + 60_000;
    return {
      readStat: (pid: number) => procs.get(pid) ?? null,
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) return procs.has(pgid);
        onSignal(signal, procs);
        return true;
      },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    };
  };

  it("releases exactly this run + runner quarantine only after termination is proven", async () => {
    vendor.quarantined.clear(); vendor.released.length = 0;
    vendor.quarantined.add("reap-run");
    const outcome = await terminateNativeDedicatedProcesses({
      db: db(), run, reason: "board_cancel", graceMs: 500, killWaitMs: 100,
      deps: deps((_signal, procs) => procs.delete(382)),
    });
    expect(outcome?.terminationProven).toBe(true);
    expect(outcome?.cleanupQuarantine).toBe("released");
    expect(vendor.released).toEqual([{ companyId: "company", runId: "reap-run", runnerInstanceId: "runner-1" }]);
  });

  it("keeps the quarantine when a group survives SIGKILL", async () => {
    vendor.quarantined.clear(); vendor.released.length = 0;
    vendor.quarantined.add("reap-run");
    const outcome = await terminateNativeDedicatedProcesses({
      db: db(), run, reason: "board_cancel", graceMs: 500, killWaitMs: 100, quarantineWaitMs: 1_000,
      deps: deps(() => {}),
    });
    expect(outcome?.survivors).toHaveLength(1);
    expect(outcome?.terminationProven).toBe(false);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(vendor.released).toEqual([]);
    expect(vendor.quarantined.has("reap-run")).toBe(true);
  });

  it("keeps the quarantine and stops escalation when the identity changes after SIGTERM", async () => {
    vendor.quarantined.clear(); vendor.released.length = 0;
    vendor.quarantined.add("reap-run");
    const sent: NodeJS.Signals[] = [];
    const outcome = await terminateNativeDedicatedProcesses({
      db: db(), run, reason: "board_cancel", graceMs: 500, killWaitMs: 100,
      deps: deps((signal, procs) => { sent.push(signal); procs.set(382, stat(382, 382, 1, T0 + 50_000)); }),
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(outcome?.identityChanged).toEqual([expect.objectContaining({ processGroupId: 382, phase: "grace" })]);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(vendor.released).toEqual([]);
  });

  it("keeps the quarantine when a recorded process could not be verified", async () => {
    vendor.quarantined.clear(); vendor.released.length = 0;
    vendor.quarantined.add("reap-run");
    const answers: unknown[][] = [[], [{
      payload: { code: "provider_startup_ownership", startup: { phase: "spawned", processId: 700, processGroupId: 700 } },
      createdAt: new Date(T0 + 2_000),
    }]];
    const reaperDeps = deps((_signal, procs) => procs.delete(382));
    const readStat = reaperDeps.readStat;
    // Live, inside the spawn window, but not runnerd's child: unknown, never ours to prove.
    reaperDeps.readStat = (pid) => pid === 700 ? stat(700, 700, 1, T0 + 1_500) : readStat(pid);
    const outcome = await terminateNativeDedicatedProcesses({
      db: { select: () => ({ from: () => ({ where: async () => answers.shift() }) }) } as any,
      run, reason: "board_cancel", graceMs: 500, killWaitMs: 100, deps: reaperDeps,
    });
    expect(outcome?.unverified).toEqual([{ role: "provider", processId: 700 }]);
    expect(outcome?.terminationProven).toBe(false);
    expect(vendor.released).toEqual([]);
  });
});

describe("native dedicated process reaper proof when processes already exited", () => {
  const run = {
    id: "gone-run", companyId: "company", agentId: "agent", runtimeMode: "native",
    processPid: 382, processGroupId: 382, processStartedAt: new Date(T0), runnerInstanceId: "runner-1",
  };
  const spawnEvent = (pid: number) => ({
    payload: { code: "provider_startup_ownership", startup: { phase: "spawned", processId: pid, processGroupId: pid } },
    createdAt: new Date(T0 + 2_000),
  });
  const db = (events: unknown[]) => {
    const answers: unknown[][] = [[], events];
    return { select: () => ({ from: () => ({ where: async () => answers.shift() }) }) } as any;
  };
  const deps = (procs: Map<number, LinuxProcessStat>, groups = new Set<number>()) => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    let clock = T0 + 60_000;
    return {
      signals,
      readStat: (pid: number): LinuxProcessStatRead => procs.get(pid) ?? null,
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0): NativeDedicatedSignalResult => {
        signals.push([pgid, signal]);
        return signal === 0 ? procs.has(pgid) || groups.has(pgid) : true;
      },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    };
  };
  const reset = () => {
    vendor.quarantined.clear(); vendor.released.length = 0; vendor.log.length = 0;
  };

  it("counts runnerd and provider groups that are already gone as proof and releases after the quarantine appears", async () => {
    reset();
    const reaperDeps = deps(new Map());
    let polls = 0;
    const sleep = reaperDeps.sleep;
    // The owner's close fails (and quarantines) only after the proof.
    reaperDeps.sleep = async (ms: number) => { if (++polls === 3) vendor.quarantined.add("gone-run"); await sleep(ms); };
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([spawnEvent(383)]), run, reason: "board_cancel", settleMs: 1_000, deps: reaperDeps,
    });
    expect(outcome?.targets).toEqual([]);
    expect(outcome?.unverified).toEqual([]);
    expect(outcome?.terminationProven).toBe(true);
    expect(outcome?.cleanupQuarantine).toBe("released");
    expect(reaperDeps.signals.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(vendor.log).toEqual(["begin:gone-run", "release:gone-run", "settle:gone-run"]);
  });

  it("treats a recorded pid now owned by a later-started process as our process being dead", async () => {
    reset();
    vendor.quarantined.add("gone-run");
    const reaperDeps = deps(new Map([
      [382, stat(382, 382, 1, T0 + 50_000)], // runnerd pid reused later
      [383, stat(383, 383, 1, T0 + 40_000)], // provider pid reused after its spawn report
    ]));
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([spawnEvent(383)]), run, reason: "board_cancel", deps: reaperDeps,
    });
    expect(outcome?.unverified).toEqual([]);
    expect(outcome?.terminationProven).toBe(true);
    expect(outcome?.cleanupQuarantine).toBe("released");
    expect(reaperDeps.signals.filter(([, signal]) => signal !== 0)).toEqual([]);
  });

  it("keeps the quarantine when a vanished leader's group still answers (unknown)", async () => {
    reset();
    vendor.quarantined.add("gone-run");
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([spawnEvent(383)]), run, reason: "board_cancel", quarantineWaitMs: 500, deps: deps(new Map(), new Set([383])),
    });
    expect(outcome?.unverified).toEqual([{ role: "provider", processId: 383 }]);
    expect(outcome?.terminationProven).toBe(false);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(vendor.released).toEqual([]);
    expect(vendor.log).toEqual(["begin:gone-run", "settle:gone-run"]);
  });

  it("keeps the quarantine when /proc says no such pid but the group probe fails with EPERM (H14)", async () => {
    reset();
    vendor.quarantined.add("gone-run");
    const reaperDeps = deps(new Map());
    reaperDeps.signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
      reaperDeps.signals.push([pgid, signal]);
      return signal === 0 ? "error" as const : true;
    };
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([spawnEvent(383)]), run, reason: "board_cancel", quarantineWaitMs: 0, deps: reaperDeps,
    });
    expect(outcome?.unverified).toEqual([{ role: "runnerd", processId: 382 }, { role: "provider", processId: 383 }]);
    expect(outcome?.terminationProven).toBe(false);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(reaperDeps.signals.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(vendor.released).toEqual([]);
  });

  it("keeps the quarantine and never signals when /proc is unreadable even if the group answers ESRCH (H14)", async () => {
    reset();
    vendor.quarantined.add("gone-run");
    const reaperDeps = deps(new Map());
    reaperDeps.readStat = () => "unreadable" as const;
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([]), run, reason: "board_cancel", quarantineWaitMs: 0, deps: reaperDeps,
    });
    expect(outcome?.unverified).toEqual([{ role: "runnerd", processId: 382 }]);
    expect(outcome?.terminationProven).toBe(false);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(reaperDeps.signals).toEqual([]);
    expect(vendor.released).toEqual([]);
  });

  it("keeps the quarantine when no runnerd identity was recorded", async () => {
    reset();
    vendor.quarantined.add("gone-run");
    const outcome = await terminateNativeDedicatedProcesses({
      db: db([]), run: { ...run, processPid: null, processGroupId: null, processStartedAt: null },
      reason: "board_cancel", quarantineWaitMs: 500, deps: deps(new Map()),
    });
    expect(outcome?.terminationProven).toBe(false);
    expect(outcome?.cleanupQuarantine).toBe("kept");
    expect(vendor.released).toEqual([]);
  });
});

// QA TAX-476 H12 repros (durable): identity must be re-verified before every signal.
describe("QA reaper identity lifetime", () => {
  const T = Date.parse("2026-10-15T07:00:00Z");
  it("QA revalidates the identity after settle before TERM", async () => {
    let clock = T; let replacement = false; let alive = true;
    const signals: unknown[] = [];
    const deps = {
      now: () => clock, sleep: async (ms: number) => { clock += ms; replacement = true; },
      readStat: (pid: number) => pid === 382 ? stat(382, 382, 1, replacement ? T + 10_000 : T) : null,
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) return alive;
        signals.push([pgid, signal, replacement]); alive = false; return true;
      },
    };
    const answers: unknown[][] = [[], []];
    const db: any = { select: () => ({ from: () => ({ where: async () => answers.shift() }) }) };
    await terminateNativeDedicatedProcesses({
      db, run: { id: "run", companyId: "company", agentId: "agent", runtimeMode: "native",
        processPid: 382, processGroupId: 382, processStartedAt: new Date(T) },
      reason: "board_cancel", settleMs: 15_000, deps,
    });
    expect(signals).toEqual([]);
  });

  it("QA revalidates a survivor before KILL", async () => {
    let clock = T; let replacement = false; const signals: unknown[] = []; let alive = true;
    const deps = {
      now: () => clock, sleep: async (ms: number) => { clock += ms; replacement = true; },
      readStat: (pid: number) => stat(pid, pid, 1, replacement ? T + 10_000 : T),
      signalGroup: (pgid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) return alive;
        signals.push([pgid, signal, replacement]); if (signal === "SIGKILL") alive = false; return true;
      },
    };
    const targets = selectNativeDedicatedProcessTargets({
      runner: { pid: 382, processGroupId: 382, startedAt: new Date(T) }, providerSpawns: [],
      runStartedAt: new Date(T), deps, selfPid: 100,
    });
    await signalNativeDedicatedProcessGroups(targets, { graceMs: 500, killWaitMs: 100 }, deps);
    expect(signals).toEqual([[382, "SIGTERM", false]]);
  });
});
