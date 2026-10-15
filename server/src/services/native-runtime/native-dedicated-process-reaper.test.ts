import { describe, expect, it } from "vitest";
import {
  selectNativeDedicatedProcessTargets,
  signalNativeDedicatedProcessGroups,
  type LinuxProcessStat,
} from "./native-dedicated-process-reaper.js";

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
      { role: "runnerd", processGroupId: 382 },
      { role: "provider", processGroupId: 383 },
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
    })).toEqual([{ role: "provider", processGroupId: 383 }]);
  });
});

describe("native dedicated process group signalling", () => {
  it("sends SIGTERM, then SIGKILL only to groups that outlive the grace", async () => {
    const alive = new Set([382, 383]);
    const signals: string[] = [];
    let clock = 0;
    const outcome = await signalNativeDedicatedProcessGroups(
      [{ role: "runnerd", processGroupId: 382 }, { role: "provider", processGroupId: 383 }],
      { graceMs: 1_000, killWaitMs: 500 },
      {
        readStat: () => null,
        signalGroup: (pgid, signal) => {
          if (signal === 0) return alive.has(pgid);
          signals.push(`${signal}:${pgid}`);
          if (signal === "SIGTERM" && pgid === 382) alive.delete(382);
          if (signal === "SIGKILL") alive.delete(pgid);
          return true;
        },
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
      },
    );
    expect(signals).toEqual(["SIGTERM:382", "SIGTERM:383", "SIGKILL:383"]);
    expect(outcome.killed).toEqual([{ role: "provider", processGroupId: 383 }]);
    expect(outcome.survivors).toEqual([]);
  });
});
