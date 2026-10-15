import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  nativePermissionDecisions,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  claimNativePermissionDecision,
  settleNativePermissionDecision,
} from "./native-permission-decisions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("native permission decision claims (embedded Postgres)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permission-decisions-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "opencode",
      role: "general",
      status: "idle",
      adapterType: "paperclip_runner",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {},
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const claimInput = (decision: "once" | "reject") => ({
    companyId,
    agentId,
    runId,
    requestId: "perm-1",
    turnId: "turn-1",
    contractSha256: "a".repeat(64),
    decision,
    resolverUserId: "admin",
  });

  it("claims a request exactly once, even under concurrent decisions", async () => {
    const results = await Promise.all([
      claimNativePermissionDecision(db, claimInput("once")),
      claimNativePermissionDecision(db, claimInput("reject")),
      claimNativePermissionDecision(db, claimInput("once")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "claimed", requestId: "perm-1", error: null });
  });

  it("settles only claimed rows and never reopens an uncertain claim", async () => {
    const [row] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.runId, runId));
    await settleNativePermissionDecision(db, {
      id: row!.id,
      status: "dispatch_uncertain",
      error: "timeout",
    });
    await settleNativePermissionDecision(db, { id: row!.id, status: "delivered" });
    const [after] = await db.select().from(nativePermissionDecisions)
      .where(eq(nativePermissionDecisions.id, row!.id));
    expect(after).toMatchObject({ status: "dispatch_uncertain", error: "timeout" });
    await expect(claimNativePermissionDecision(db, claimInput("once"))).resolves.toBeNull();
  });
});
