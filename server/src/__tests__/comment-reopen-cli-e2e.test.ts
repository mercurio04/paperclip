import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockExecute = vi.hoisted(() => vi.fn());
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: mockExecute }),
}));

const support = await getEmbeddedPostgresTestSupport();
const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

(support.supported ? describe : describe.skip)("comment reopen CLI/HTTP on a disposable Paperclip", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let app: express.Express;
  let http: ReturnType<typeof createServer>;
  let apiUrl: string;
  let releaseRun = () => {};
  const payloads: { method: string; path: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-comment-reopen-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-comment-reopen-db-");
    db = createDb(temporary.connectionString);
    const [{ createApp }, { createLocalDiskStorageProvider }, { createStorageService }] = await Promise.all([
      import("../app.js"), import("../storage/local-disk-provider.js"), import("../storage/service.js"),
    ]);
    app = await createApp(db, {
      uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: false,
      companyDeletionEnabled: false, instanceId: randomUUID(),
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    const capture = express();
    capture.use(express.json());
    capture.use((req, _res, next) => {
      payloads.push({ method: req.method, path: req.path, body: req.body });
      next();
    });
    capture.use(app);
    http = createServer(capture);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing disposable API listener");
    apiUrl = `http://127.0.0.1:${address.port}`;
  }, 90_000);

  afterEach(async () => {
    releaseRun();
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db).drainActiveRunExecutions();
    mockExecute.mockReset();
    payloads.length = 0;
  });

  afterAll(async () => {
    await app?.locals.paperclipShutdown?.();
    http?.closeAllConnections();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([
    "cli_no_reopen", "http_post_false", "http_patch_false", "human_default",
    "explicit_resume", "explicit_mention", "new_evidence_default", "cli_reopen",
  ])("captures the emitted payload and persists the intended result: %s", async (mode) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic comment fixture",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer",
      adapterType: "test_adapter", status: "idle", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic closed task",
      status: "done", assigneeAgentId: agentId, completedAt: new Date(Date.now() - 1000) });
    const running = new Promise<void>((resolve) => { releaseRun = resolve; });
    mockExecute.mockImplementation(async () => {
      await running;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Synthetic comment handled.", provider: "test", model: "test-model" };
    });
    const keepClosed = ["cli_no_reopen", "http_post_false", "http_patch_false", "explicit_mention"].includes(mode);
    const noWake = ["cli_no_reopen", "http_post_false", "http_patch_false"].includes(mode);
    const body = mode === "explicit_mention" ? `Please review [@Reviewer](agent://${agentId})` :
      mode === "new_evidence_default" ? "New evidence: the synthetic check failed." : "Acknowledged";
    let expectedPayload: Record<string, unknown>;
    if (mode.startsWith("cli_")) {
      const flag = mode === "cli_no_reopen" ? "--no-reopen" : "--reopen";
      await exec(process.execPath, [join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "cli/src/index.ts"), "issue", "comment", issueId, "--body", body, flag,
        "--api-base", apiUrl, "--context", join(root, "context.json"), "--json"], {
        cwd: repoRoot, env: { ...process.env, PAPERCLIP_HOME: root }, timeout: 45_000,
      });
      expectedPayload = { body, reopen: mode !== "cli_no_reopen" };
    } else {
      const patch = mode === "http_patch_false";
      expectedPayload = { [patch ? "comment" : "body"]: body,
        ...(keepClosed ? { reopen: false } : {}), ...(mode === "explicit_resume" ? { resume: true } : {}) };
      const response = await fetch(`${apiUrl}/api/issues/${issueId}${patch ? "" : "/comments"}`, {
        method: patch ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expectedPayload),
      });
      expect(response.status, await response.text()).toBe(patch ? 200 : 201);
    }
    expect(payloads.find((entry) => entry.path.startsWith(`/api/issues/${issueId}`))?.body).toEqual(expectedPayload);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved?.status).toBe(keepClosed ? "done" : "todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(body);
    if (!noWake) await vi.waitFor(async () =>
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(1));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(noWake ? 0 : 1);
    if (mode === "explicit_mention") expect(wakes[0]?.reason).toBe("issue_comment_mentioned");
    else if (!noWake) expect(wakes[0]?.reason).toBe("issue_reopened_via_comment");
  }, 60_000);
});
