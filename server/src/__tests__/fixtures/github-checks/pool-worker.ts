// A disposable process isolates pool-starvation regressions, including the old hang.
import { eq } from "drizzle-orm";
import { agentWakeupRequests, createDb, issues } from "@paperclipai/db";
import { dispatchGithubChecksMonitor } from "../../../services/github-checks-monitor.js";
import { normalizeIssueExecutionPolicy } from "../../../services/issue-execution-policy.js";
const db = createDb(process.env.GITHUB_MONITOR_TEST_DB!, {
  maxConnections: Number(process.env.GITHUB_MONITOR_POOL_SIZE),
  applicationName: process.env.GITHUB_MONITOR_POOL_APP!,
});
const ids = JSON.parse(process.env.GITHUB_MONITOR_ISSUE_IDS!) as string[];
const rows = await Promise.all(ids.map(id => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!)));
process.send?.({ ready: true });
try {
  const dispatch = (row: typeof rows[number]) => dispatchGithubChecksMonitor({
    db, claim: row, policy: normalizeIssueExecutionPolicy(row.executionPolicy)!,
    now: new Date(process.env.GITHUB_MONITOR_TICK_AT!),
    dispatch: async (claimed, event) => {
      // Test delivery receipt only; production enqueue/admission is covered in the scheduler suite.
      await db.insert(agentWakeupRequests).values({ companyId: claimed.companyId, agentId: claimed.assigneeAgentId!,
        source: "automation", reason: "test-probe-event", payload: { issueId: claimed.id, githubChecks: event },
        idempotencyKey: `issue-monitor:${claimed.id}:${claimed.monitorNextCheckAt!.toISOString()}` });
      return { outcome: "triggered" as const };
    },
  });
  const result = await Promise.all(rows.flatMap(row => Array.from({ length: Number(process.env.GITHUB_MONITOR_DUPLICATES ?? "1") }, () => dispatch(row))));
  process.send?.({ result });
} catch { process.send?.({ error: "pool dispatch failed" }); }
