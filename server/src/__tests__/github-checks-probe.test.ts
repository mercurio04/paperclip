import { describe, expect, it, vi } from "vitest";
import { issueExecutionMonitorPolicySchema, updateIssueSchema } from "@paperclipai/shared";
import { probeGithubChecks } from "../services/github-checks-probe.js";
const headSha = "a".repeat(40);
const target = { repo: "example/project", prNumber: 4, headSha, expectedChecks: ["build", "test"], intervalMinutes: 5 };
const pr = { state: "open", merged: false, head: { sha: headSha } };
const run = (name = "test", conclusion: string | null = null) => ({ id: 1, app: { id: 1 }, name, status: conclusion ? "completed" : "in_progress", conclusion });
function reader(runs: unknown[], statuses: unknown[] = [], pull = pr) {
  return vi.fn(async (endpoint: string) => endpoint.includes("/pulls/") ? pull : endpoint.includes("/check-runs?") ? { check_runs: runs } : statuses);
}
describe("GitHub checks probe", () => {
  it("requires the typed target and existing bounds; strips server-owned state", () => {
    const valid = { ...target, kind: "github_checks", nextCheckAt: "2026-10-15T12:00:00Z", timeoutAt: "2026-10-15T14:00:00Z", maxAttempts: 5 };
    expect(issueExecutionMonitorPolicySchema.parse({ ...valid, monitorProbeState: { allGreen: true } })).not.toHaveProperty("monitorProbeState");
    for (const key of ["repo", "prNumber", "headSha", "expectedChecks", "intervalMinutes", "timeoutAt", "maxAttempts"]) {
      const bad: Record<string, unknown> = { ...valid }; delete bad[key];
      expect(issueExecutionMonitorPolicySchema.safeParse(bad).success).toBe(false);
    }
    for (const repo of ["../repo", "owner/..", "owner/.", "https://github.com/owner/repo", "owner/repo?write=true"]) {
      expect(issueExecutionMonitorPolicySchema.safeParse({ ...valid, repo }).success).toBe(false);
    }
  });
  it("does not accept a caller-owned top-level probe state", () => {
    expect(updateIssueSchema.parse({ title: "Example", monitorProbeState: { allGreen: true } })).not.toHaveProperty("monitorProbeState");
  });
  it("requests only the exact SHA and waits for running expected checks", async () => {
    const read = reader([run("build", "success"), run()]);
    expect((await probeGithubChecks(target, read)).event).toBeNull();
    expect(read.mock.calls.map(c => c[0])).toEqual([
      "repos/example/project/pulls/4", `repos/example/project/commits/${headSha}/check-runs?per_page=100&page=1`,
      `repos/example/project/commits/${headSha}/statuses?per_page=100&page=1`,
    ]);
  });
  it.each(["failure", "cancelled", "timed_out", "action_required"])("reports %s immediately", async conclusion => {
    expect((await probeGithubChecks(target, reader([run("test", conclusion)]))).event).toMatchObject({ reason: "checks_failed", allGreen: false });
  });
  it("reports green only when every expected check succeeds", async () => {
    expect((await probeGithubChecks(target, reader([run("build", "success"), run("test", "success")]))).event).toMatchObject({ reason: "checks_completed", allGreen: true });
    expect((await probeGithubChecks(target, reader([run("build", "skipped"), run("test", "success")]))).event).toMatchObject({ reason: "checks_completed", allGreen: false });
  });
  it("reports missing checks, including an empty check suite", async () => {
    expect((await probeGithubChecks(target, reader([run("build", "success")]))).event).toMatchObject({ reason: "expected_checks_missing", missingChecks: ["test"] });
    expect((await probeGithubChecks(target, reader([]))).event?.reason).toBe("expected_checks_missing");
  });
  it("does not use an older green retry or an unrelated check", async () => {
    const runs = [run("build", "success"), run("test", "success"), { ...run("test"), id: 2 }, run("unrelated", "failure")];
    expect((await probeGithubChecks(target, reader(runs))).event).toBeNull();
  });
  it("supports status contexts and retains failures from a second app", async () => {
    expect((await probeGithubChecks(target, reader([run("build", "success")], [{ id: 1, context: "test", state: "success" }]))).event?.allGreen).toBe(true);
    expect((await probeGithubChecks(target, reader([run("build", "success"), run("test", "success"), { ...run("test", "failure"), app: { id: 2 } }]))).event?.reason).toBe("checks_failed");
  });
  it("stops immediately when HEAD changes or PR closes", async () => {
    for (const pull of [{ ...pr, head: { sha: "b".repeat(40) } }, { ...pr, state: "closed", merged: true }]) {
      const read = reader([], [], pull);
      expect((await probeGithubChecks(target, read)).event?.reason).toBe(pull.state === "closed" ? "pr_closed" : "head_changed");
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
  it("does not turn malformed data or a rejected query into green", async () => {
    for (const read of [vi.fn(async () => ({})), vi.fn(async () => { throw new Error("sensitive raw output"); })]) {
      await expect(probeGithubChecks(target, read)).rejects.toMatchObject({ kind: "transient", message: "GitHub checks probe failed" });
    }
  });
  it("reads all pages before deciding and refuses excessive pagination", async () => {
    const read = vi.fn(async (endpoint: string) => {
      if (endpoint.includes("/pulls/")) return pr;
      if (endpoint.includes("/statuses?")) return [];
      return { check_runs: endpoint.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => ({ ...run("build", "success"), id })) : [run("test", "failure")] };
    });
    expect((await probeGithubChecks(target, read)).event?.reason).toBe("checks_failed");
    const infinite = vi.fn(async (endpoint: string) => endpoint.includes("/pulls/") ? pr : { check_runs: Array.from({ length: 100 }, () => run()) });
    await expect(probeGithubChecks(target, infinite)).rejects.toMatchObject({ kind: "transient" });
  });
});
