import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const tickAt = new Date("2026-04-11T12:31:00Z");
(support.supported ? describe : describe.skip)("github monitor O1 pool isolation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const children = new Set<ChildProcess>();
  const dirs: string[] = [];
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("github-monitor-pool-"); db = createDb(tempDb.connectionString); }, 20000);
  const stop = async (child: ChildProcess) => {
    if (!children.delete(child)) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    process.kill(-child.pid!, "SIGKILL");
    await exited;
  };
  afterEach(async () => { await Promise.all([...children].map(stop)); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
  afterAll(async () => { await tempDb?.cleanup(); });
  async function seed(count: number, maxAttempts = 10) {
    const companyId = randomUUID(); const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer" });
    const rows = await db.insert(issues).values(Array.from({ length: count }, (_, i) => ({
      id: randomUUID(), companyId, title: "Pool test", status: "in_progress", assigneeAgentId: agentId,
      issueNumber: i + 1, monitorNextCheckAt: tickAt, monitorWakeRequestedAt: tickAt,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: {
        kind: "github_checks", repo: "example/project", prNumber: 4, headSha: "a".repeat(40), expectedChecks: ["test"],
        intervalMinutes: 5, nextCheckAt: tickAt.toISOString(), timeoutAt: "2026-04-11T15:00:00Z", maxAttempts,
        notes: null, scheduledBy: "assignee",
      } },
    }))).returning();
    return rows;
  }
  async function start(rows: Awaited<ReturnType<typeof seed>>, pool: number, duplicates = 1) {
    const dir = mkdtempSync(join(tmpdir(), "github-pool-fixture-")); dirs.push(dir);
    const fixture = join(dir, "fixture.json"); const app = `pool-${randomUUID()}`;
    writeFileSync(fixture, JSON.stringify({ delay: 300, pr: { head: { sha: "a".repeat(40) }, state: "open", merged: false },
      runs: [{ id: 1, name: "test", app: { id: 1 }, status: "in_progress", conclusion: null }] }));
    const env = { ...process.env, GITHUB_MONITOR_TEST_DB: tempDb.connectionString, GITHUB_MONITOR_FIXTURE: fixture,
      GITHUB_MONITOR_POOL_SIZE: String(pool), GITHUB_MONITOR_POOL_APP: app, GITHUB_MONITOR_ISSUE_IDS: JSON.stringify(rows.map(row => row.id)),
      GITHUB_MONITOR_TICK_AT: tickAt.toISOString(), GITHUB_MONITOR_DUPLICATES: String(duplicates),
      PATH: fileURLToPath(new URL("./fixtures/github-checks", import.meta.url)) + ":" + process.env.PATH };
    delete env.PAPERCLIP_API_KEY; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    const child = fork(fileURLToPath(new URL("./fixtures/github-checks/pool-worker.ts", import.meta.url)), [], {
      execArgv: ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url))],
      cwd: fileURLToPath(new URL("../../..", import.meta.url)), env, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.add(child);
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pool dispatch did not complete within 5 seconds after ready")), 15000);
      child.on("message", (message: { ready?: boolean; result?: unknown; error?: string }) => {
        if (message.ready) { clearTimeout(timer); setTimeout(() => reject(new Error("pool dispatch hung")), 5000).unref(); }
        else { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("worker exited before result")); });
    });
    // Attach immediately so an observation failure cannot leave an unhandled rejection.
    void result.catch(() => {});
    return { child, fixture, app, result };
  }
  it.each([1, 2, 3])("O1 pool=%i with N concurrent slow polls completes without holding a connection", async pool => {
    const rows = await seed(pool); const worker = await start(rows, pool);
    await worker.result;
    const activity = await db.execute(sql`select state, xact_start from pg_stat_activity where application_name = ${worker.app}`);
    expect([...activity].every(row => row.state === "idle" && row.xact_start === null)).toBe(true);
    for (const row of rows) {
      const [saved] = await db.select().from(issues).where(eq(issues.id, row.id));
      expect(saved!.monitorAttemptCount).toBe(1); expect(saved!.monitorWakeRequestedAt).toBeNull();
      expect(saved!.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
    }
    expect(readFileSync(worker.fixture + ".calls", "utf8").trim().split("\n")).toHaveLength(pool * 3);
  });
  it("O1 a slow in-flight request leaves the only pool connection available and no transaction open", async () => {
    const rows = await seed(1); const worker = await start(rows, 1);
    const deadline = Date.now() + 10000;
    while (!existsSync(worker.fixture + ".calls") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(worker.fixture + ".calls")).toBe(true);
    const activity = await db.execute(sql`select state, xact_start from pg_stat_activity where application_name = ${worker.app}`);
    expect([...activity]).toHaveLength(1);
    expect(activity[0]).toMatchObject({ state: "idle", xact_start: null });
    await worker.result;
  });
  it.each([1, 10])("O1 overlapping dispatches of the same claim (limit=%i) count one attempt and perform one poll", async maxAttempts => {
    const rows = await seed(1, maxAttempts); const worker = await start(rows, 2, 3);
    await worker.result;
    const [saved] = await db.select().from(issues).where(eq(issues.id, rows[0]!.id));
    expect(saved!.monitorAttemptCount).toBe(1);
    expect(readFileSync(worker.fixture + ".calls", "utf8").trim().split("\n")).toHaveLength(3);
  });
  it("O1 a crash after reservation releases the pool but preserves the durable claim and attempt", async () => {
    const rows = await seed(1); const worker = await start(rows, 1);
    const deadline = Date.now() + 10000;
    while (!existsSync(worker.fixture + ".calls") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(worker.fixture + ".calls")).toBe(true);
    await stop(worker.child);
    const [saved] = await db.select().from(issues).where(eq(issues.id, rows[0]!.id));
    expect(saved!.monitorAttemptCount).toBe(1); expect(saved!.monitorWakeRequestedAt).toEqual(tickAt);
    expect(saved!.monitorProbeState?.probingClaim).toBe(tickAt.toISOString());
  });
});
