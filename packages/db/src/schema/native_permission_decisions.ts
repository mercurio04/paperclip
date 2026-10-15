import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Durable, single-use claim for a human decision on a typed OpenCode
 * permission request. The row is inserted (ON CONFLICT DO NOTHING) before the
 * decision is dispatched to the runner, so a request can be answered at most
 * once and an uncertain dispatch is never retried.
 *
 * status: claimed -> delivered | dispatch_uncertain | stale
 */
export const nativePermissionDecisions = pgTable(
  "native_permission_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    turnId: text("turn_id").notNull(),
    contractSha256: text("contract_sha256").notNull(),
    decision: text("decision").notNull(),
    resolverUserId: text("resolver_user_id").notNull(),
    status: text("status").notNull().default("claimed"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runRequestUq: uniqueIndex("native_permission_decisions_run_request_uq").on(
      table.runId,
      table.requestId,
    ),
    companyRunIdx: index("native_permission_decisions_company_run_idx").on(
      table.companyId,
      table.runId,
    ),
  }),
);
