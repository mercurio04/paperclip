import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningProcesses, signalRunningProcess } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

// A real child process, with the same SIGTERM exit code as Claude CLI.
const fakeCli = `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("2.1.251 (Claude Code)");
  process.exit(0);
}
const event = (value) => JSON.stringify({ session_id: "${sessionId}", ...value }) + "\\n";
const out = (value) => process.stdout.write(event(value));
const real = { type: "result", subtype: "success", is_error: false, num_turns: 7,
  result: "prompt turn finished", terminal_reason: "completed" };
const stale = { type: "result", subtype: "success", is_error: false, num_turns: 0,
  result: "", origin: { kind: "task-notification" } };
process.on("SIGTERM", () => process.exit(143));
process.stdin.resume();
const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
out({ type: "system", subtype: "init" });
if (scenario === "stale_then_real") {
  if (!process.argv.includes("--resume")) process.exit(2);
  out(stale);
  setTimeout(() => {
    out({ type: "system", subtype: "init" });
    process.stdout.write(event(real), () => process.exit(0));
  }, 600);
} else if (scenario === "multiple_results") {
  // Keep both results in one write so checking only the last result cannot pass.
  process.stdout.write(event(real) + event({ ...stale, num_turns: 21, result: "notification finished" }));
  setInterval(() => {}, 1000);
} else if (scenario === "normal") {
  process.stdout.write(event(real), () => process.exit(0));
} else {
  if (scenario === "stale_only") out(stale);
  out({ type: "system", subtype: "fixture_ready" });
  setInterval(() => {}, 1000);
}
`;

describe.skipIf(process.platform === "win32")("Claude CLI terminal result cleanup", () => {
  let root: string;
  let command: string;
  const activeRunIds = new Set<string>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(), "claude-cleanup-"));
    command = path.join(root, "fake-claude.mjs");
    await writeFile(command, fakeCli, { mode: 0o755 });
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
  });

  afterEach(async () => {
    for (const runId of activeRunIds) {
      const running = runningProcesses.get(runId);
      if (running) signalRunningProcess(running, "SIGKILL");
    }
    activeRunIds.clear();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function run(scenario: string, options: { timeoutSec?: number; stop?: "cancel" | "external" } = {}) {
    const runId = randomUUID();
    activeRunIds.add(runId);
    let stdout = "";
    let stopped = false;
    const result = await execute({
      runId,
      agent: { id: "fixture-agent", companyId: "fixture-company", name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId, sessionParams: { sessionId, cwd: root }, sessionDisplayId: sessionId, taskKey: null },
      config: {
        engine: "cli", command, cwd: root, extraArgs: ["--scenario=" + scenario],
        terminalResultCleanupGraceMs: 150, graceSec: 1, timeoutSec: options.timeoutSec ?? 3,
      },
      context: {},
      onLog: async (stream, chunk) => {
        if (stream !== "stdout") return;
        stdout += chunk;
        if (!stopped && options.stop && stdout.includes('"subtype":"fixture_ready"')) {
          stopped = true;
          const running = runningProcesses.get(runId);
          if (!running?.child.pid) throw new Error("Fixture process is not registered");
          if (options.stop === "cancel") signalRunningProcess(running, "SIGTERM");
          else process.kill(running.child.pid, "SIGTERM");
        }
      },
    });
    activeRunIds.delete(runId);
    expect(runningProcesses.has(runId)).toBe(false);
    return { result, stdout, stopped };
  }

  it("ignores a stale notification before the resumed prompt turn and lets that turn finish", async () => {
    const { result, stdout } = await run("stale_then_real");
    expect(stdout).toContain('"num_turns":0');
    expect(stdout).toContain("prompt turn finished");
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
    expect(result.summary).toBe("prompt turn finished");
  });

  it("still cleans up a live background after a real final followed by a notification result", async () => {
    const { result, stdout } = await run("multiple_results");
    expect(stdout).toContain("prompt turn finished");
    expect(stdout).toContain("notification finished");
    expect(result).toMatchObject({ exitCode: 143, signal: null, timedOut: false });
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({
      kind: "terminal_result_cleanup", stopped: true, terminalResultSeen: true, signal: "SIGTERM", forceKilled: false,
    });
  });

  it("preserves a normal exit without cleanup", async () => {
    const { result } = await run("normal");
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
  });

  it("preserves explicit cancellation through runningProcesses as exit 143 without cleanup", async () => {
    const { result, stopped } = await run("hang", { stop: "cancel" });
    expect(stopped).toBe(true);
    expect(result).toMatchObject({ exitCode: 143, signal: null, timedOut: false });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
    expect(result.errorMessage).toContain("143");
  });

  it("preserves timeout without cleanup", async () => {
    const { result } = await run("hang", { timeoutSec: 0.5 });
    expect(result).toMatchObject({ exitCode: 143, timedOut: true, errorCode: "timeout" });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
  });

  it("preserves external SIGTERM as exit 143 without cleanup", async () => {
    const { result, stopped } = await run("hang", { stop: "external" });
    expect(stopped).toBe(true);
    expect(result).toMatchObject({ exitCode: 143, signal: null, timedOut: false });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
    expect(result.errorMessage).toContain("143");
  });

  it("leaves a stale notification with no prompt result to the timeout", async () => {
    const { result, stdout } = await run("stale_only", { timeoutSec: 0.5 });
    expect(stdout).toContain('"num_turns":0');
    expect(stdout).not.toContain("prompt turn finished");
    expect(result).toMatchObject({ exitCode: 143, timedOut: true, errorCode: "timeout" });
    expect(result.resultJson?.unmanagedBackgroundTask).toBeUndefined();
  });
});
