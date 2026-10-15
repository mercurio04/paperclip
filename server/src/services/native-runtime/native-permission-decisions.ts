import { and, eq, isNull, lt, sql } from "drizzle-orm";

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

/**
 * Crash reconciliation: a `claimed` row written by a previous server process
 * has an unknown dispatch outcome (the process may have died before, during
 * or after `request.resolve`). It becomes `dispatch_uncertain`, which is
 * terminal and never redelivered. Only rows claimed before `claimedBefore`
 * (this process' start) move, so a claim owned by a live dispatcher of the
 * current process is never touched. `stale`/`delivered` rows are unchanged.
 */
export async function reconcileCrashedNativePermissionClaims(
  db: Db,
  input: {
    readonly companyId: string;
    readonly runId: string;
    readonly claimedBefore: Date;
    readonly reason: string;
  },
): Promise<Array<{ id: string; requestId: string; turnId: string; decision: string; contractSha256: string; resolverUserId: string }>> {
  return db
    .update(nativePermissionDecisions)
    .set({
      status: "dispatch_uncertain",
      error: input.reason.slice(0, 2000),
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(nativePermissionDecisions.companyId, input.companyId),
      eq(nativePermissionDecisions.runId, input.runId),
      eq(nativePermissionDecisions.status, "claimed"),
      lt(nativePermissionDecisions.createdAt, input.claimedBefore),
    ))
    .returning({
      id: nativePermissionDecisions.id,
      requestId: nativePermissionDecisions.requestId,
      turnId: nativePermissionDecisions.turnId,
      decision: nativePermissionDecisions.decision,
      contractSha256: nativePermissionDecisions.contractSha256,
      resolverUserId: nativePermissionDecisions.resolverUserId,
    });
}

/**
 * What OpenCode actually received for a typed permission, as reported by the
 * driver (`nativeOutcome` on the settle signal). `delivered` only means the
 * decision was handed to runnerd; a `once` can still lose the race to a
 * terminal run and be answered natively with `reject`.
 */
export const NATIVE_PERMISSION_OUTCOMES = [
  "once_applied",
  "rejected_terminal",
  "rejected_drift",
  "rejected_expired",
  "unknown",
] as const;
export type NativePermissionOutcome = (typeof NATIVE_PERMISSION_OUTCOMES)[number];

export function parseNativePermissionOutcome(value: unknown): NativePermissionOutcome | null {
  return typeof value === "string" &&
    (NATIVE_PERMISSION_OUTCOMES as readonly string[]).includes(value)
    ? (value as NativePermissionOutcome)
    : null;
}

export type RecordNativePermissionOutcomeResult =
  | { readonly kind: "recorded"; readonly id: string }
  | { readonly kind: "unchanged"; readonly id: string }
  | { readonly kind: "conflict"; readonly id: string; readonly existing: string }
  | { readonly kind: "no_claim" };

/**
 * Record the native outcome on the claim for (run, request). First write
 * wins: a non-null outcome is never overwritten. A later, different outcome
 * is reported as `conflict` so the caller audits it instead of losing it.
 */
export async function recordNativePermissionOutcome(
  db: Db,
  input: {
    readonly companyId: string;
    readonly runId: string;
    readonly requestId: string;
    readonly nativeOutcome: NativePermissionOutcome;
  },
): Promise<RecordNativePermissionOutcomeResult> {
  const scope = and(
    eq(nativePermissionDecisions.companyId, input.companyId),
    eq(nativePermissionDecisions.runId, input.runId),
    eq(nativePermissionDecisions.requestId, input.requestId),
  );
  const [updated] = await db
    .update(nativePermissionDecisions)
    .set({ nativeOutcome: input.nativeOutcome, updatedAt: sql`now()` })
    .where(and(scope, isNull(nativePermissionDecisions.nativeOutcome)))
    .returning({ id: nativePermissionDecisions.id });
  if (updated) return { kind: "recorded", id: updated.id };
  const [existing] = await db
    .select({
      id: nativePermissionDecisions.id,
      nativeOutcome: nativePermissionDecisions.nativeOutcome,
    })
    .from(nativePermissionDecisions)
    .where(scope);
  if (!existing) return { kind: "no_claim" };
  return existing.nativeOutcome === input.nativeOutcome
    ? { kind: "unchanged", id: existing.id }
    : { kind: "conflict", id: existing.id, existing: existing.nativeOutcome ?? "" };
}

/**
 * Settle-signal consumer: record the outcome and audit it. A settle for a
 * request with no claim (no board decision) is ignored; a conflicting later
 * outcome is audited and never applied.
 */
export async function applyNativePermissionSettle(
  db: Db,
  input: {
    readonly companyId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly requestId: string;
    readonly nativeOutcome: unknown;
  },
  audit: (entry: {
    companyId: string;
    actorType: "system";
    actorId: string;
    action: string;
    entityType: "heartbeat_run";
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>,
): Promise<RecordNativePermissionOutcomeResult | null> {
  const nativeOutcome = parseNativePermissionOutcome(input.nativeOutcome);
  if (!nativeOutcome || !input.requestId) return null;
  const result = await recordNativePermissionOutcome(db, {
    companyId: input.companyId,
    runId: input.runId,
    requestId: input.requestId,
    nativeOutcome,
  });
  if (result.kind === "recorded" || result.kind === "conflict") {
    await audit({
      companyId: input.companyId,
      actorType: "system",
      actorId: "paperclip-runner",
      action:
        result.kind === "recorded"
          ? "heartbeat.runtime_permission_native_outcome"
          : "heartbeat.runtime_permission_native_outcome_conflict",
      entityType: "heartbeat_run",
      entityId: input.runId,
      details: {
        agentId: input.agentId,
        runId: input.runId,
        requestId: input.requestId,
        nativeOutcome,
        ...(result.kind === "conflict" ? { existingNativeOutcome: result.existing } : {}),
      },
    });
  }
  return result;
}

/**
 * runnerd relays the driver's post-delivery report of what OpenCode natively
 * received as a `harness.diagnostic` with code `permission_native_outcome`
 * (Paperclip request id + outcome). Returns null for every other event.
 */
export function nativePermissionOutcomeFromEvent(event: {
  readonly eventType: string;
  readonly payload: unknown;
}): { requestId: string; nativeOutcome: NativePermissionOutcome } | null {
  if (event.eventType !== "harness.diagnostic") return null;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
  if (payload.code !== "permission_native_outcome" || typeof payload.requestId !== "string" || !payload.requestId)
    return null;
  const nativeOutcome = parseNativePermissionOutcome(payload.nativeOutcome);
  return nativeOutcome ? { requestId: payload.requestId, nativeOutcome } : null;
}
