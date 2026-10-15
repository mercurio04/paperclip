// QA TAX-477 H14 repro (verbatim): EACCES on /proc plus EPERM on the null
// signal is unknown state, never proof of death; the quarantine must stay.
import { describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ released: [] as unknown[] }));
vi.mock("node:fs", async (original) => {
 const fs = await original<typeof import("node:fs")>();
 return { ...fs, readFileSync: (...args: any[]) => {
  if (args[0] === "/proc/382/stat") throw Object.assign(new Error("fixture: inaccessible live process"), {code:"EACCES"});
  return (fs.readFileSync as any)(...args);
 }};
});
vi.mock("../heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: vi.fn(async () => {}) }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({
 beginLocalNativeSessionTerminationProof: () => ({settle: () => {}}),
 localNativeSessionCleanupQuarantined: () => true,
 completeTerminatedLocalNativeSessionCleanup: (binding: unknown) => {state.released.push(binding); return true;},
}));
import { terminateNativeDedicatedProcesses } from "./native-dedicated-process-reaper.js";
describe("QA termination proof on OS permission errors", () => {
 it("keeps quarantine when proc is unreadable and signal-zero returns EPERM", async () => {
  const signals: unknown[] = [];
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
   signals.push([pid,signal]);
   if (pid !== -382 || signal !== 0) throw new Error("unexpected signal blocked by QA");
   throw Object.assign(new Error("fixture: group exists but is not signalable"), {code:"EPERM"});
  });
  try {
   const answers: unknown[][] = [[], []];
   const outcome = await terminateNativeDedicatedProcesses({
    db: { select: () => ({from: () => ({where: async () => answers.shift()})}) } as any,
    run: {id:"qa-eperm",companyId:"company",agentId:"agent",runtimeMode:"native",processPid:382,processGroupId:382,processStartedAt:new Date("2026-10-15T07:00:00Z"),runnerInstanceId:"runner-1"},
    reason:"board_cancel",quarantineWaitMs:0,
   });
   console.log("QA EPERM result",JSON.stringify({terminationProven:outcome?.terminationProven,cleanupQuarantine:outcome?.cleanupQuarantine,releases:state.released.length,signals}));
   expect(outcome?.terminationProven).toBe(false);
   expect(state.released).toEqual([]);
  } finally {kill.mockRestore();}
 });
});
