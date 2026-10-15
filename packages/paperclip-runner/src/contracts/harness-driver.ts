import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "./types.js";
import {
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  parsePaperclipQuestionResponse,
  type PaperclipQuestionResponse,
  type PaperclipQuestionSet,
  type PaperclipRuntimeRequestOrigin,
} from "./question-set.js";

export * from "./question-set.js";

export const HARNESS_DRIVER_CONTRACT_VERSION = 1 as const;

export interface HarnessDriverConfigIssue {
  path: string;
  code: string;
  message: string;
}

export type HarnessDriverConfigValidation =
  | { ok: true; config: Record<string, unknown>; issues: [] }
  | { ok: false; config: null; issues: HarnessDriverConfigIssue[] };

export interface HarnessTranscriptSnapshot {
  schema: "paperclip-runner/harness-transcript/v1";
  complete: boolean;
  eventCount: number;
  events: PrpEvent[];
  omissionReason: string | null;
}

export interface HarnessDriverDescriptor {
  kind: string;
  displayName: string;
  version: string;
  protocolVersion?: string;
  capabilities: NativeSessionCapabilities;
  runtimeContextCapabilities?: NativeRuntimeContextCapabilities;
}

export interface NativeRuntimeContextCapabilities {
  instructions: "native" | "unsupported";
  skills: "native" | "unsupported";
  mcp: "native" | "unsupported";
}

export interface OpenHarnessSessionInput {
  runId: string;
  normalizedSessionId: string;
  workingDirectory: string;
  /** Abort provider bootstrap and release any not-yet-returned provider state. */
  signal?: AbortSignal;
}

export interface HarnessSessionRecoveryOptions {
  /** Abort provider recovery and release any not-yet-returned provider state. */
  signal: AbortSignal;
}

export class HarnessCapabilityUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`${operation} is unavailable: ${detail}`);
    this.name = "HarnessCapabilityUnavailableError";
    this.operation = operation;
  }
}

export class HarnessReconciliationError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = "HarnessReconciliationError";
  }
}

export class HarnessOperationAlreadyTerminalError extends Error {
  readonly code = "already_terminal" as const;

  constructor(operation: string) {
    super(`${operation} lost a race with the committed turn terminal`);
    this.name = "HarnessOperationAlreadyTerminalError";
  }
}

export class HarnessStaleTurnError extends Error {
  readonly code = "stale_turn" as const;

  constructor(turnId: string) {
    super(`turn ${turnId} is not the active turn`);
    this.name = "HarnessStaleTurnError";
  }
}

export type HarnessRuntimeRequestKind =
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "user_input"
  | "elicitation";

export const PAPERCLIP_RUNTIME_REQUEST_PERMISSION_SCHEMA_V1 =
  "paperclip.runtime_request.permission.v1" as const;
export const PAPERCLIP_OPENCODE_PERMISSION_CONTRACT_SCHEMA_V1 =
  "paperclip.opencode_permission_contract.v1" as const;
export const PAPERCLIP_PERMISSION_DECISION_SCHEMA_V1 =
  "paperclip.permission_decision.v1" as const;
export const PAPERCLIP_PERMISSION_DECISIONS = ["once", "reject"] as const;
export type PaperclipPermissionDecision =
  (typeof PAPERCLIP_PERMISSION_DECISIONS)[number];

/**
 * TAX-452 H9: the only (OpenCode permission, tool id) pairs restricted_v1 may
 * surface for approval. Verified against the OpenCode 1.18.29 binary: the
 * `edit`, `write` and `apply_patch` tools ask the `edit` permission; `read`,
 * `glob` and `grep` ask their own name. 1.18.29 registers no `list` tool and
 * no `multiedit`/`patch` tool, so they are absent (fail closed). Any other
 * permission, tool, or mismatched pair is rejected natively and never shown.
 * Mirrored by `RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS` in the Rust runnerd
 * and the server authority; the shared permission fixture pins all three.
 */
export const RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  edit: Object.freeze(["apply_patch", "edit", "write"]),
  glob: Object.freeze(["glob"]),
  grep: Object.freeze(["grep"]),
  read: Object.freeze(["read"]),
});

export function isRestrictedV1ApprovablePermissionTool(
  permission: unknown,
  toolName: unknown,
): boolean {
  if (typeof permission !== "string" || typeof toolName !== "string")
    return false;
  if (
    !Object.prototype.hasOwnProperty.call(
      RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS,
      permission,
    )
  )
    return false;
  return RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS[permission]!.includes(
    toolName,
  );
}

/**
 * Frozen OpenCode permission contract (TAX-452 §1). The hash covers the
 * canonical JSON of every field except `contractSha256` itself.
 */
export interface PaperclipOpenCodePermissionContract {
  schema: typeof PAPERCLIP_OPENCODE_PERMISSION_CONTRACT_SCHEMA_V1;
  provider: "opencode";
  providerVersion: string;
  providerSessionId: string;
  providerRequestId: string;
  permission: string;
  /** Frozen identity of the native tool call; `name` is the tool part's id. */
  tool: { name: string; messageId: string; callId: string };
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  /** Complete input of the tool part; always an object (TAX-452 H10). */
  arguments: Record<string, unknown>;
  cwd: string;
  targets: Array<{ pattern: string; resolvedPath: string | null }>;
  policy: { profile: "restricted_v1"; permissionDefault: "ask" };
  contractSha256: string;
}

export interface HarnessRuntimeRequest {
  requestId: string;
  requestKind: HarnessRuntimeRequestKind;
  method: string;
  turnId: string;
  itemId: string;
  status: "pending";
  prompt: string;
  details: Record<string, unknown>;
  /** Provider-neutral presentation model for structured input requests. */
  input?: PaperclipQuestionSet;
  /** Diagnostic origin only; provider response shapes never enter PRP. */
  origin?: PaperclipRuntimeRequestOrigin;
  /** Typed permission contract; present only for restricted permission requests. */
  permission?: PaperclipOpenCodePermissionContract;
  /** Decisions a typed permission request accepts. */
  decisions?: PaperclipPermissionDecision[];
}

export type HarnessRuntimeRequestResolution =
  | { action: "accept" | "accept_for_session" | "decline" | "cancel" }
  | {
      action: "submit";
      answers: Record<string, { answers: string[] }>;
    }
  | {
      action: "submit";
      content: Record<string, unknown>;
    }
  | {
      action: "submit";
      response: PaperclipQuestionResponse;
    }
  | {
      action: "permission_decision";
      decision: PaperclipPermissionDecision;
      contractSha256: string;
    };

export type HarnessRuntimeRequestAction =
  HarnessRuntimeRequestResolution["action"];

export type HarnessRuntimeRequestHandoffResult =
  "handed_off" | "already_settled";

/**
 * A runtime-input handoff commits its durable state transition before the
 * method returns. Provider interruption is cleanup only: it remains observed,
 * but cannot acquire mutation authority or reverse an already committed turn.
 */
export interface HarnessRuntimeRequestHandoff {
  result: HarnessRuntimeRequestHandoffResult;
  cleanup: Promise<void>;
}

const RUNTIME_REQUEST_ACTIONS: readonly HarnessRuntimeRequestAction[] = [
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
  "submit",
  "permission_decision",
];

export class HarnessRuntimeRequestResolutionError extends Error {
  readonly code = "invalid_resolution" as const;
  readonly requestKind: HarnessRuntimeRequestKind;

  constructor(requestKind: HarnessRuntimeRequestKind, detail: string) {
    super(`${requestKind} rejected its resolution: ${detail}`);
    this.name = "HarnessRuntimeRequestResolutionError";
    this.requestKind = requestKind;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAnswers(
  value: unknown,
): Record<string, { answers: string[] }> | null {
  const fields = plainRecord(value);
  if (fields === null || Object.keys(fields).length === 0) return null;
  const parsed: Record<string, { answers: string[] }> = {};
  for (const [field, entry] of Object.entries(fields)) {
    const answer = plainRecord(entry);
    if (answer === null || !Array.isArray(answer.answers)) return null;
    if (answer.answers.some((value) => typeof value !== "string")) return null;
    parsed[field] = { answers: [...(answer.answers as string[])] };
  }
  return parsed;
}

/**
 * Validates a resolution against the kind of request it answers, so a
 * mismatched submit fails closed instead of degrading into an accepted empty
 * response. Every driver runs this before it touches its provider, and the
 * browser transport runs it again at its own untrusted edge.
 */
export function parseHarnessRuntimeRequestResolution(
  requestKind: HarnessRuntimeRequestKind,
  value: unknown,
  questionSet?: PaperclipQuestionSet,
  permission?: Pick<PaperclipOpenCodePermissionContract, "contractSha256">,
): HarnessRuntimeRequestResolution {
  const candidate = plainRecord(value) ?? {};
  const rawAction = candidate.action;
  if (
    typeof rawAction !== "string" ||
    !RUNTIME_REQUEST_ACTIONS.includes(rawAction as HarnessRuntimeRequestAction)
  ) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      `unsupported action ${JSON.stringify(rawAction) ?? "undefined"}`,
    );
  }
  const action = rawAction as HarnessRuntimeRequestAction;
  if (permission !== undefined || action === "permission_decision") {
    return parsePermissionDecisionResolution(
      requestKind,
      candidate,
      permission,
    );
  }
  if (
    action !== "submit" &&
    ("answers" in candidate ||
      "content" in candidate ||
      "response" in candidate)
  ) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      `${action} does not carry submitted form data`,
    );
  }

  if (action === "submit" && "response" in candidate) {
    if (requestKind !== "user_input" && requestKind !== "elicitation") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "approval requests do not accept submitted question responses",
      );
    }
    if ("answers" in candidate || "content" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "canonical submissions cannot also carry provider-specific answers or content",
      );
    }
    if (questionSet === undefined) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "canonical submission requires the persisted question set",
      );
    }
    try {
      return {
        action,
        response: parsePaperclipQuestionResponse(
          questionSet,
          candidate.response,
        ),
      };
    } catch (error) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        error instanceof Error ? error.message : "invalid question response",
      );
    }
  }

  if (requestKind === "user_input") {
    if (action === "accept" || action === "accept_for_session") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "user input requires submit, decline, or cancel",
      );
    }
    if (action !== "submit") return { action };
    if ("content" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "user input submissions carry answers, not content",
      );
    }
    const answers = parseAnswers(candidate.answers);
    if (answers === null) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "submit requires answers shaped as { field: { answers: [string] } }",
      );
    }
    return { action, answers };
  }

  if (requestKind === "elicitation") {
    if (action === "accept_for_session") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "elicitation does not support session acceptance",
      );
    }
    if (action !== "submit") return { action };
    if ("answers" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "elicitation submissions carry content, not answers",
      );
    }
    const content = plainRecord(candidate.content);
    if (content === null || Object.keys(content).length === 0) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "submit requires a non-empty content object",
      );
    }
    return { action, content: structuredClone(content) };
  }

  if (action === "submit") {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "approval requests do not accept submitted form data",
    );
  }
  return { action };
}

const PERMISSION_DECISION_KEYS = new Set([
  "action",
  "decision",
  "contractSha256",
]);

/**
 * A typed permission request accepts only `permission_decision` (once or
 * reject, bound to a contract hash) or `cancel`. Session-wide acceptance and
 * legacy accept/decline actions are rejected so nothing can widen a grant.
 * The hash is only checked for shape here; the driver compares it with the
 * pending contract and replies `reject` on mismatch.
 */
function parsePermissionDecisionResolution(
  requestKind: HarnessRuntimeRequestKind,
  candidate: Record<string, unknown>,
  permission:
    | Pick<PaperclipOpenCodePermissionContract, "contractSha256">
    | undefined,
): HarnessRuntimeRequestResolution {
  if (requestKind !== "permission_approval" || permission === undefined) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "permission_decision answers only typed permission requests",
    );
  }
  if (candidate.action === "cancel") {
    if (Object.keys(candidate).some((key) => key !== "action")) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "cancel does not carry a permission decision",
      );
    }
    return { action: "cancel" };
  }
  if (candidate.action !== "permission_decision") {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "typed permission requests accept only permission_decision or cancel",
    );
  }
  if (Object.keys(candidate).some((key) => !PERMISSION_DECISION_KEYS.has(key))) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "permission_decision carries unknown keys",
    );
  }
  const decision = candidate.decision;
  if (
    !PAPERCLIP_PERMISSION_DECISIONS.includes(
      decision as PaperclipPermissionDecision,
    )
  ) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "permission_decision requires decision once or reject",
    );
  }
  const contractSha256 = candidate.contractSha256;
  if (
    typeof contractSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(contractSha256)
  ) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "permission_decision requires a lowercase hex sha256 contract hash",
    );
  }
  return {
    action: "permission_decision",
    decision: decision as PaperclipPermissionDecision,
    contractSha256,
  };
}

/**
 * The single payload shape every driver emits for a terminal
 * `runtime_request.*` fact. Request identity travels in the payload as well as
 * the event binding, so a consumer that only reads payloads still settles the
 * request it belongs to.
 */
export type HarnessRuntimeRequestOutcome = {
  requestId: string;
  requestKind: HarnessRuntimeRequestKind;
  turnId: string;
  itemId: string;
  action?: HarnessRuntimeRequestAction;
  reason?: string;
  /** Enables content-free lifecycle counters partitioned by adapter. */
  adapter?: string;
  requestType?: "input" | "permission";
  /** Canonical submitted answers retained for durable replay and audit UI. */
  response?: PaperclipQuestionResponse;
};

export function harnessRuntimeRequestOutcome(
  request: Pick<
    HarnessRuntimeRequest,
    "requestId" | "requestKind" | "turnId" | "itemId" | "origin" | "input"
  > &
    Partial<Pick<HarnessRuntimeRequest, "permission">>,
  outcome: {
    action?: HarnessRuntimeRequestAction | null;
    reason?: string | null;
    response?: PaperclipQuestionResponse | null;
  } = {},
): HarnessRuntimeRequestOutcome {
  return {
    requestId: request.requestId,
    requestKind: request.requestKind,
    turnId: request.turnId,
    itemId: request.itemId,
    ...(outcome.action ? { action: outcome.action } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.response
      ? { response: structuredClone(outcome.response) }
      : {}),
    ...(request.input
      ? {
          ...(request.origin?.adapter
            ? { adapter: request.origin.adapter }
            : {}),
          requestType: "input" as const,
        }
      : request.permission
        ? {
            ...(request.origin?.adapter
              ? { adapter: request.origin.adapter }
              : {}),
            requestType: "permission" as const,
          }
        : {}),
  };
}

/** Canonical non-replayable expiration used when a live input moves to a durable wait. */
export function harnessRuntimeInputExpiredOutcome(
  request: HarnessRuntimeRequest,
  reason: "durable_handoff" | "provider_process_lost",
): Omit<HarnessRuntimeRequestOutcome, "requestKind"> & {
  requestKind: "runtime";
  replayAllowed: false;
  request: Record<string, unknown>;
} {
  return {
    ...harnessRuntimeRequestOutcome(request, { reason }),
    requestKind: "runtime",
    replayAllowed: false,
    request: {
      schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
      requestKind: "runtime",
      requestId: request.requestId,
      type: "input",
      status: request.status,
      prompt: request.prompt,
      input: structuredClone(request.input),
      origin: structuredClone(request.origin),
      turnId: request.turnId,
      itemId: request.itemId,
    },
  };
}

export interface HarnessThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "limited" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export type HarnessGoalOperation =
  | { action: "get"; requestId?: string }
  | {
      action: "set";
      objective: string;
      tokenBudget?: number | null;
      status?: HarnessThreadGoal["status"];
      requestId?: string;
    }
  | { action: "pause" | "resume" | "clear"; requestId?: string };

export interface HarnessThreadLineageEntry {
  threadId: string;
  providerSessionId: string | null;
  parentThreadId: string | null;
  depth: number;
  nickname: string | null;
  role: string | null;
  status: string;
}

export interface PersistedHarnessSemanticResult {
  result: PrpStructuredRunResult;
  fingerprint: string;
  callId?: string | null;
  turnId: string;
}

export interface PersistedHarnessTurnTerminal {
  turnId: string;
  fingerprint: string;
}

export interface AcpxSessionIdentity {
  kind: "acpx";
  normalizedSessionId: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  profileDigest: string;
  workspaceDigest: string;
  requestedModel: string;
  effectiveModel: string;
  /** Missing on legacy snapshots; those used the historical approve-reads behavior. */
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  providerLifetimeFenceCandidates: readonly [number, number, number];
}

export type PersistedHarnessProviderIdentity = AcpxSessionIdentity;

export interface PersistedHarnessSession {
  driverKind: string;
  /** Execution-host startup root, revalidated before a cold provider launch. */
  workingDirectory?: string;
  driverSessionId: string;
  providerSessionId?: string | null;
  runId?: string;
  normalizedSessionId?: string;
  activeTurnId?: string | null;
  semanticResult?: PersistedHarnessSemanticResult | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  codexUsageBaseline?: { baseline: Record<string, number>; latest: Record<string, number> };
  /** A result-less terminal task may spend this fail-closed one-shot recovery allowance. */
  dispositionOnlyRecoveryConsumed?: boolean;
  /** Exact accepted provider turn that spent the disposition-only allowance. */
  dispositionOnlyRecoveryTurnId?: string | null;
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  goal?: HarnessThreadGoal | null;
  lineage?: HarnessThreadLineageEntry[];
  lastSourceSequence?: number;
  /** Tagged provider identity used to reject cross-profile recovery. */
  providerIdentity?: PersistedHarnessProviderIdentity;
  /** Narrow escape hatch for a durable response-wake when a provider cannot reload its prior native session. */
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_governed_wait"
    | "allow_replacement_after_resume_failure";
}

export interface HarnessSessionRecoveryResult {
  recovered: boolean;
  session?: HarnessSession;
  reason?: string;
}

export interface HarnessSession {
  ids(): {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };
  events(): AsyncIterable<PrpEvent>;
  attachRun?(input: { runId: string }): Promise<void> | void;
  startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{
    turnId: string;
    effectiveCollaborationMode?: "default" | "plan";
  }>;
  steer?(input: {
    turnId: string;
    message: NativeUserMessage;
    correlationId?: string;
  }): Promise<void>;
  interrupt?(input: {
    turnId?: string;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  pendingRuntimeRequests?(): HarnessRuntimeRequest[];
  resolveRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void>;
  handoffRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    /** Do not synchronously commit if runtime ownership is already revoked. */
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff;
  goal?(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null>;
  lineage?(): HarnessThreadLineageEntry[];
  read?(): Promise<Record<string, unknown>>;
  reconcile?(): Promise<Record<string, unknown>>;
  usage?(): Promise<Record<string, unknown> | null>;
  transcript?(): Promise<HarnessTranscriptSnapshot>;
  snapshot(): Promise<PersistedHarnessSession>;
  /** Relinquish controller authority without semantically closing the session. */
  detachControllerForRestart?(): Promise<void>;
  close(input: { reason: string; force?: boolean }): Promise<void>;
}

/** A local harness implementation hidden behind the runner daemon boundary. */
export interface HarnessDriver {
  descriptor(): Promise<HarnessDriverDescriptor>;
  validateConfig?(config: unknown): Promise<HarnessDriverConfigValidation>;
  openSession(input: OpenHarnessSessionInput): Promise<HarnessSession>;
  recoverSession?(
    snapshot: PersistedHarnessSession,
    options: HarnessSessionRecoveryOptions,
  ): Promise<HarnessSessionRecoveryResult>;
}
