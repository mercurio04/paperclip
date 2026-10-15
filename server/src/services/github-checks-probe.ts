import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { IssueExecutionMonitorPolicy } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);
export type GithubChecksTarget = Required<Pick<IssueExecutionMonitorPolicy,
  "repo" | "prNumber" | "headSha" | "expectedChecks" | "intervalMinutes">>;
export type GithubCheck = { name: string; status: string; conclusion: string | null };
export type GithubProbeEvent = {
  reason: "head_changed" | "pr_closed" | "checks_failed" | "checks_completed" | "expected_checks_missing" | "probe_error";
  repo: string;
  prNumber: number;
  headSha: string;
  observedHeadSha?: string;
  merged?: boolean;
  allGreen?: boolean;
  checks?: GithubCheck[];
  missingChecks?: string[];
  probeError?: { kind: "access" | "transient"; status: number | null; consecutiveErrors: number };
};
export class GithubProbeError extends Error {
  constructor(readonly kind: "access" | "transient", readonly status: number | null = null) {
    // Never retain gh output: it may contain sensitive data or credentials.
    super("GitHub checks probe failed");
  }
}
export type GhRead = (endpoint: string, signal: AbortSignal) => Promise<unknown>;
export const ghRead: GhRead = async (endpoint, signal) => {
  try {
    const { stdout } = await execFileAsync("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--include"], {
      signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      // Inherit the service user's existing gh session. No credential extraction.
    });
    const body = stdout.startsWith("HTTP/") ? stdout.split(/\r?\n\r?\n/).slice(1).join("\n\n") : stdout;
    return JSON.parse(body);
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr : "";
    const stdout = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout : "";
    const status = Number(/HTTP\s+(\d{3})/i.exec(stderr)?.[1] ?? /^HTTP\/[^ ]+ (\d{3})/i.exec(stdout)?.[1]) || null;
    const headers = stdout.split(/\r?\n\r?\n/, 1)[0] ?? "";
    const rateLimited = status === 429 || /rate.limit|retry-after/i.test(stderr)
      || /(?:x-ratelimit-remaining:\s*0\b|retry-after:)/i.test(headers);
    throw new GithubProbeError(!rateLimited && [401, 403, 404].includes(status ?? 0) ? "access" : "transient", status);
  }
};

const prSchema = z.object({ head: z.object({ sha: z.string().regex(/^[a-fA-F0-9]{40}$/) }), state: z.enum(["open", "closed"]), merged: z.boolean() });
const runSchema = z.object({ id: z.number(), name: z.string().max(200), status: z.enum(["queued", "in_progress", "completed", "waiting", "pending", "requested"]), conclusion: z.string().nullable(), app: z.object({ id: z.number() }).nullable() });
const statusSchema = z.object({ id: z.number(), context: z.string().max(200), state: z.enum(["pending", "success", "failure", "error"]) });

/** One bounded poll of the PR and checks for the configured SHA. All endpoints are GET. */
export async function probeGithubChecks(target: GithubChecksTarget, read: GhRead = ghRead): Promise<{ checks: GithubCheck[]; event: GithubProbeEvent | null }> {
  const signal = AbortSignal.timeout(60_000);
  const base = { repo: target.repo, prNumber: target.prNumber, headSha: target.headSha };
  try {
    const pr = prSchema.parse(await read(`repos/${target.repo}/pulls/${target.prNumber}`, signal));
    if (pr.state === "closed") return { checks: [], event: { ...base, reason: "pr_closed", merged: pr.merged, observedHeadSha: pr.head.sha } };
    if (pr.head.sha.toLowerCase() !== target.headSha.toLowerCase()) return { checks: [], event: { ...base, reason: "head_changed", observedHeadSha: pr.head.sha } };
    const runs = new Map<string, z.infer<typeof runSchema>>();
    const statuses = new Map<string, z.infer<typeof statusSchema>>();
    // Explicit pagination. Never silently treat truncated or invalid data as green.
    for (const kind of ["check-runs", "statuses"] as const) {
      for (let page = 1; ; page++) {
        if (page > 20 || signal.aborted) throw new GithubProbeError("transient");
        const data = await read(`repos/${target.repo}/commits/${target.headSha}/${kind}?per_page=100&page=${page}`, signal);
        const rows = kind === "check-runs"
          ? z.object({ check_runs: z.array(runSchema) }).parse(data).check_runs
          : z.array(statusSchema).parse(data);
        if (kind === "check-runs") {
          for (const row of rows as z.infer<typeof runSchema>[]) {
            const key = `${row.app?.id ?? 0}:${row.name}`;
            if ((runs.get(key)?.id ?? -1) < row.id) runs.set(key, row);
          }
        } else {
          for (const row of rows as z.infer<typeof statusSchema>[]) {
            if ((statuses.get(row.context)?.id ?? -1) < row.id) statuses.set(row.context, row);
          }
        }
        if (rows.length < 100) break;
      }
    }
    const expected = new Set(target.expectedChecks);
    const checks: GithubCheck[] = [
      ...[...runs.values()].map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
      ...[...statuses.values()].map(s => ({ name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "success" ? "success" : s.state === "pending" ? null : "failure" })),
    ].filter(c => expected.has(c.name)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const missingChecks = target.expectedChecks.filter(name => !checks.some(c => c.name === name));
    const failed = checks.some(c => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(c.conclusion ?? ""));
    const terminal = checks.every(c => c.status === "completed" && c.conclusion !== null);
    const event: GithubProbeEvent | null = failed ? { ...base, reason: "checks_failed", checks, allGreen: false }
      : terminal && missingChecks.length > 0 ? { ...base, reason: "expected_checks_missing", checks, missingChecks, allGreen: false }
      : terminal ? { ...base, reason: "checks_completed", checks, allGreen: checks.every(c => c.conclusion === "success") }
      : null;
    return { checks, event };
  } catch (error) {
    if (error instanceof GithubProbeError) throw error;
    throw new GithubProbeError("transient");
  }
}
