import { createHash } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type {
  HarnessRuntimeRequestKind,
  HarnessRuntimeRequestResolution,
} from "../../vendor/paperclip-runner/index.js";

const TERMINAL_RUNTIME_REQUEST_EVENTS = [
  "runtime_request.resolved",
  "runtime_request.cancelled",
  "runtime_request.expired",
] as const;
const RUNTIME_REQUEST_EVENTS = [
  "runtime_request.created",
  ...TERMINAL_RUNTIME_REQUEST_EVENTS,
] as const;
const APPROVAL_REQUEST_KINDS = new Set<NativeRuntimeRequestKind>([
  "command_approval",
  "file_approval",
  "permission_approval",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export type NativeRuntimeRequestKind = HarnessRuntimeRequestKind | "runtime";

export const NATIVE_PERMISSION_REQUEST_SCHEMA = "paperclip.runtime_request.permission.v1";
export const NATIVE_PERMISSION_CONTRACT_SCHEMA = "paperclip.opencode_permission_contract.v1";
export const NATIVE_PERMISSION_DECISION_SCHEMA = "paperclip.permission_decision.v1";
export type NativePermissionDecision = "once" | "reject";
const PERMISSION_DECISIONS: readonly NativePermissionDecision[] = ["once", "reject"];
const CONTRACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Contract TAX-452 §1: unknown keys in the request or the permission object
// are rejected. Keep these lists in lockstep with `.e2e/notes/contract.md`.
const PERMISSION_REQUEST_KEYS = new Set([
  "schema",
  "requestKind",
  "requestId",
  "type",
  "status",
  "prompt",
  "turnId",
  "itemId",
  "origin",
  "decisions",
  "permission",
]);
const PERMISSION_CONTRACT_KEYS = new Set([
  "schema",
  "provider",
  "providerVersion",
  "providerSessionId",
  "providerRequestId",
  "permission",
  "tool",
  "patterns",
  "always",
  "metadata",
  "arguments",
  "cwd",
  "targets",
  "policy",
  "contractSha256",
]);

/**
 * Typed permission decision: the `permission_decision` member of the runner
 * contract union in packages/paperclip-runner/src/contracts/harness-driver.ts.
 */
export type NativePermissionDecisionResolution = Extract<
  HarnessRuntimeRequestResolution,
  { action: "permission_decision" }
>;

/** Every resolution the server may hand to a native runtime. */
export type NativeRuntimeResolutionPayload = HarnessRuntimeRequestResolution;

/**
 * Strictly parse a browser permission decision. Only `once`/`reject` exist;
 * `always`, session grants, submits and approvals are never valid here.
 */
export function parseNativePermissionDecisionResolution(
  value: unknown,
): NativePermissionDecisionResolution | null {
  const candidate = record(value);
  if (!candidate) return null;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "action,contractSha256,decision") return null;
  if (
    candidate.action !== "permission_decision"
    || !PERMISSION_DECISIONS.includes(candidate.decision as NativePermissionDecision)
    || typeof candidate.contractSha256 !== "string"
    || !CONTRACT_SHA256_PATTERN.test(candidate.contractSha256)
  ) return null;
  return {
    action: "permission_decision",
    decision: candidate.decision as NativePermissionDecision,
    contractSha256: candidate.contractSha256,
  };
}

export interface PendingNativePermissionRequest {
  readonly contractSha256: string;
  /** Frozen persisted permission contract, exactly as the runner emitted it. */
  readonly contract: Record<string, unknown>;
  readonly decisions: readonly NativePermissionDecision[];
}

export interface PendingNativeRuntimeRequest {
  readonly companyId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly requestKind: NativeRuntimeRequestKind;
  readonly turnId: string;
  /** Server-owned policy derived from the canonical request kind. */
  readonly resolverPolicy: "human_only" | "instance_admin";
  /** Present only for `paperclip.runtime_request.permission.v1` requests. */
  readonly permission?: PendingNativePermissionRequest;
}

export interface NativeRuntimeRequestResolver {
  readonly type: "user";
  readonly userId: string;
  readonly isInstanceAdmin: boolean;
}

export class NativeRuntimeRequestResolutionAuthorizationError extends Error {
  constructor(readonly code: "native_runtime_request_resolver_denied") {
    super(code);
    this.name = "NativeRuntimeRequestResolutionAuthorizationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalJsonValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Contract TAX-452 §1: sha256 hex of the canonical JSON (keys sorted
 * recursively with the JS default sort, compact, UTF-8) of the `permission`
 * object without `contractSha256`. The server recomputes it from storage and
 * never trusts the runner-provided value alone.
 */
export function computeNativePermissionContractSha256(
  contract: Record<string, unknown>,
): string {
  const { contractSha256: _ignored, ...unsigned } = contract;
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(unsigned)), "utf8")
    .digest("hex");
}

/**
 * Parse the persisted permission request. Any deviation from the frozen
 * contract makes the request non-actionable (fail closed): it can then only
 * be cancelled by the runner, never approved.
 */
function canonicalPermissionRequest(
  request: Record<string, unknown>,
): PendingNativePermissionRequest | null {
  if (
    request.schema !== NATIVE_PERMISSION_REQUEST_SCHEMA
    || request.requestKind !== "runtime"
    || Object.keys(request).some((key) => !PERMISSION_REQUEST_KEYS.has(key))
  ) return null;
  const decisions = request.decisions;
  if (
    !Array.isArray(decisions)
    || decisions.length !== PERMISSION_DECISIONS.length
    || !PERMISSION_DECISIONS.every((decision) => decisions.includes(decision))
  ) return null;
  const contract = record(request.permission);
  if (
    !contract
    || contract.schema !== NATIVE_PERMISSION_CONTRACT_SCHEMA
    || Object.keys(contract).some((key) => !PERMISSION_CONTRACT_KEYS.has(key))
    || typeof contract.contractSha256 !== "string"
    || !CONTRACT_SHA256_PATTERN.test(contract.contractSha256)
    || typeof contract.permission !== "string"
  ) return null;
  // A stored contract that no longer hashes to its own contractSha256 was
  // altered after the runner froze it (redaction, truncation, tampering): the
  // human would be approving something other than what the driver verifies.
  if (computeNativePermissionContractSha256(contract) !== contract.contractSha256) {
    return null;
  }
  return {
    contractSha256: contract.contractSha256,
    contract,
    decisions: [...PERMISSION_DECISIONS],
  };
}

function canonicalPendingRequest(input: {
  companyId: string;
  runId: string;
  requestId: string;
  payload: unknown;
}): PendingNativeRuntimeRequest | null {
  const event = record(record(input.payload)?.prpEvent);
  const eventPayload = record(event?.payload);
  const request = record(eventPayload?.request);
  if (
    !event
    || event.schema !== "paperclip.prp.event.v1"
    || event.eventType !== "runtime_request.created"
    || event.sourceKind !== "runner"
    || event.runId !== input.runId
    || !request
    || request.status !== "pending"
  ) return null;

  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  const requestKind = typeof request.requestKind === "string" ? request.requestKind : "";
  const turnId = typeof request.turnId === "string"
    ? request.turnId
    : typeof event.turnId === "string"
      ? event.turnId
      : "";
  const supportedKinds: readonly NativeRuntimeRequestKind[] = [
    "command_approval",
    "file_approval",
    "permission_approval",
    "user_input",
    "elicitation",
    "runtime",
  ];
  if (
    requestId !== input.requestId
    || !REQUEST_ID_PATTERN.test(requestId)
    || !supportedKinds.includes(requestKind as NativeRuntimeRequestKind)
    || !REQUEST_ID_PATTERN.test(turnId)
  ) {
    return null;
  }
  const kind = requestKind as NativeRuntimeRequestKind;
  if (request.type === "permission" || request.schema === NATIVE_PERMISSION_REQUEST_SCHEMA) {
    const permission = canonicalPermissionRequest(request);
    if (!permission) return null;
    return {
      companyId: input.companyId,
      runId: input.runId,
      requestId,
      requestKind: kind,
      turnId,
      // Tool permissions mutate the workspace on the operator's behalf: they
      // are privileged approvals regardless of the transport request kind.
      resolverPolicy: "instance_admin",
      permission,
    };
  }
  return {
    companyId: input.companyId,
    runId: input.runId,
    requestId,
    requestKind: kind,
    turnId,
    resolverPolicy: APPROVAL_REQUEST_KINDS.has(kind)
      ? "instance_admin"
      : "human_only",
  };
}

/**
 * Load the latest durable lifecycle event for one request. A request is
 * actionable only when that exact latest event is its canonical creation.
 * Client-supplied kind/turn fields never participate in this lookup.
 */
export async function readPendingNativeRuntimeRequest(
  db: Db,
  input: {
    readonly companyId: string;
    readonly runId: string;
    readonly requestId: string;
  },
): Promise<PendingNativeRuntimeRequest | null> {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) return null;
  const [latest] = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      payload: heartbeatRunEvents.payload,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId),
      inArray(heartbeatRunEvents.eventType, [...RUNTIME_REQUEST_EVENTS]),
      sql`coalesce(
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,request,requestId}',
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,requestId}'
      ) = ${input.requestId}`,
    ))
    .orderBy(desc(heartbeatRunEvents.seq))
    .limit(1);
  if (!latest || latest.eventType !== "runtime_request.created") return null;
  return canonicalPendingRequest({ ...input, payload: latest.payload });
}

/** Revalidate the server-owned resolver policy at the command-consumption edge. */
export function assertNativeRuntimeRequestResolverAuthorized(
  request: PendingNativeRuntimeRequest,
  actor: NativeRuntimeRequestResolver,
): void {
  if (!actor.userId.trim()) {
    throw new NativeRuntimeRequestResolutionAuthorizationError(
      "native_runtime_request_resolver_denied",
    );
  }
  if (request.resolverPolicy === "instance_admin" && !actor.isInstanceAdmin) {
    throw new NativeRuntimeRequestResolutionAuthorizationError(
      "native_runtime_request_resolver_denied",
    );
  }
}
