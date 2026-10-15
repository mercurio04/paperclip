import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issues, issueWorkProducts } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("issue public monitor projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let root: string;
  let companyId: string;
  let issueId: string;
  let agentId: string;
  let identifier: string;
  const probeState = {
    version: 1, target: "private-probe-sentinel", probingClaim: "2026-04-11T12:30:00Z",
    checks: [{ name: "test", status: "in_progress" }],
    pendingEvent: { reason: "checks_failed", repo: "example/project", prNumber: 4, headSha: "a".repeat(40), allGreen: false },
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "issue-public-projection-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    temporary = await startEmbeddedPostgresTestDatabase("issue-public-projection-db-");
    db = createDb(temporary.connectionString);
    const [{ createApp }, { createLocalDiskStorageProvider }, { createStorageService }] = await Promise.all([
      import("../app.js"), import("../storage/local-disk-provider.js"), import("../storage/service.js"),
    ]);
    app = await createApp(db, {
      uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"],
      bindHost: "127.0.0.1", authReady: false, companyDeletionEnabled: false, instanceId: randomUUID(),
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);

  beforeEach(async () => {
    companyId = randomUUID(); issueId = randomUUID(); agentId = randomUUID();
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    identifier = `${prefix}-1`;
    await db.insert(companies).values({ id: companyId, name: "Synthetic projection company", issuePrefix: prefix, defaultResponsibleUserId: "local-board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic projection agent", role: "engineer", status: "idle", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic public projection", identifier, issueNumber: 1, status: "todo", monitorProbeState: probeState });
  });

  afterEach(async () => {
    // Reads and non-monitor mutations must not erase durable scheduler state.
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted!.monitorProbeState).toEqual(probeState);
  });
  afterAll(async () => {
    await app?.locals.paperclipShutdown?.();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function api(method: "get" | "post" | "patch" | "delete", path: string) {
    return request(app)[method](path).set("Host", "127.0.0.1");
  }

  function expectPublic(body: Record<string, unknown>) {
    expect(body).not.toHaveProperty("monitorProbeState");
    expect(JSON.stringify(body)).not.toContain("private-probe-sentinel");
  }

  it.each(["uuid", "identifier", "includes"])("GET detail by %s omits private state", async mode => {
    if (mode === "includes") await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "document", provider: "test", title: "Public metadata control", status: "active",
      metadata: { monitorProbeState: { public: true } },
    });
    const response = await api("get", `/api/issues/${mode === "identifier" ? identifier : issueId}`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.id).toBe(issueId);
    expectPublic(response.body);
    if (mode === "includes") expect(response.body.workProducts[0].metadata).toEqual({ monitorProbeState: { public: true } });
  });

  it.each(["", "?view=compact", "?includeBlockedBy=true&includeLiveDescendantSummary=true"])("GET list %s omits the key, including null projections", async query => {
    const response = await api("get", `/api/companies/${companyId}/issues${query}`);
    expect(response.status, response.text).toBe(200);
    const item = response.body.find((row: { id: string }) => row.id === issueId);
    expect(item).toBeDefined(); expectPublic(item);
  });

  it.each(["heartbeat-context", "diagnostics/blockers", "diagnostics/wakes", "diagnostics/subtree"])("GET %s keeps its curated projection private", async path => {
    const response = await api("get", `/api/issues/${issueId}/${path}`);
    expect(response.status, response.text).toBe(200);
    expect(JSON.stringify(response.body)).toContain(issueId);
    expect(JSON.stringify(response.body)).not.toContain("monitorProbeState");
    expect(JSON.stringify(response.body)).not.toContain("private-probe-sentinel");
  });

  it("PATCH returns a public issue without changing the persisted probe", async () => {
    const response = await api("patch", `/api/issues/${issueId}`).send({ title: "Updated public title" });
    expect(response.status, response.text).toBe(200);
    expect(response.body.title).toBe("Updated public title"); expectPublic(response.body);
  });

  it.each(["create", "child"])("POST %s omits even a null internal state", async mode => {
    const path = mode === "create" ? `/api/companies/${companyId}/issues` : `/api/issues/${issueId}/children`;
    const response = await api("post", path).send({ title: "Synthetic created issue", status: "todo" });
    expect(response.status, response.text).toBe(201);
    expect(response.body.title).toBe("Synthetic created issue"); expectPublic(response.body);
  });

  it.each(["get", "post"] as const)("%s existing conversation omits its private probe", async method => {
    const [conversation] = await db.insert(issues).values({
      companyId, title: "Synthetic conversation", issueNumber: 2, status: "in_review", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "waiting", monitorProbeState: probeState,
    }).returning();
    const response = await api(method, `/api/companies/${companyId}/chats/${agentId}`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.id).toBe(conversation!.id); expectPublic(response.body);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, conversation!.id));
    expect(persisted!.monitorProbeState).toEqual(probeState);
  });


  it.each(["checkout", "release", "admin/force-release"])("POST %s returns only a public issue", async action => {
    const response = await api("post", `/api/issues/${issueId}/${action}`).send(
      action === "checkout" ? { agentId, expectedStatuses: ["todo"] } : {},
    );
    expect(response.status, response.text).toBe(200);
    const returned = action === "admin/force-release" ? response.body.issue : response.body;
    expect(returned.id).toBe(issueId); expectPublic(returned);
  });

  it("DELETE returns a public issue snapshot", async () => {
    const [toDelete] = await db.insert(issues).values({companyId, title: "Synthetic delete", issueNumber: 2, monitorProbeState: probeState}).returning();
    const response = await api("delete", `/api/issues/${toDelete!.id}`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.id).toBe(toDelete!.id); expectPublic(response.body);
  });

  it("POST new conversation omits the default internal state", async () => {
    const response = await api("post", `/api/companies/${companyId}/chats/${agentId}`);
    expect(response.status, response.text).toBe(200);
    expect(response.body.conversationAgentId).toBe(agentId); expectPublic(response.body);
  });

  it("company export does not serialize scheduler state", async () => {
    const response = await api("post", `/api/companies/${companyId}/exports`).send({
      include: { company: true, agents: false, projects: false, issues: true, skills: false },
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.manifest.issues).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain("monitorProbeState");
    expect(JSON.stringify(response.body)).not.toContain("private-probe-sentinel");
  });

  it("the existing internal locked read still has the durable probe", async () => {
    await db.transaction(async tx => {
      const row = await issueService(db).getByIdForUpdate(issueId, tx);
      expect(row!.monitorProbeState).toEqual(probeState);
    });
  });
});
