import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { nativePermissionDecisions } from "@paperclipai/db";

import type { NativePermissionDecision } from "./runtime-request-resolution-authority.js";

export type NativePermissionDecisionStatus =
  | "claimed"
  | "delivered"
  | "dispatch_uncertain"
  | "stale";

export interface NativePermissionDecisionClaim {
  readonly id: string;
}

/**
 * Atomically claim the single decision allowed for one permission request.
 * Returns null when any decision (in any state) already exists: the caller
 * must answer 409 and must not dispatch. A claim is never released, so an
 * uncertain dispatch can never be retried.
 */
export async function claimNativePermissionDecision(
  db: Db,
  input: {
    readonly companyId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly requestId: string;
    readonly turnId: string;
    readonly contractSha256: string;
    readonly decision: NativePermissionDecision;
    readonly resolverUserId: string;
  },
): Promise<NativePermissionDecisionClaim | null> {
  const [row] = await db
    .insert(nativePermissionDecisions)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      requestId: input.requestId,
      turnId: input.turnId,
      contractSha256: input.contractSha256,
      decision: input.decision,
      resolverUserId: input.resolverUserId,
      status: "claimed",
    })
    .onConflictDoNothing({
      target: [nativePermissionDecisions.runId, nativePermissionDecisions.requestId],
    })
    .returning({ id: nativePermissionDecisions.id });
  return row ? { id: row.id } : null;
}

/** Move a claimed decision to its terminal state. Only `claimed` rows move. */
export async function settleNativePermissionDecision(
  db: Db,
  input: {
    readonly id: string;
    readonly status: Exclude<NativePermissionDecisionStatus, "claimed">;
    readonly error?: string | null;
  },
): Promise<void> {
  await db
    .update(nativePermissionDecisions)
    .set({
      status: input.status,
      error: input.error ? input.error.slice(0, 2000) : null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(nativePermissionDecisions.id, input.id),
      eq(nativePermissionDecisions.status, "claimed"),
    ));
}
