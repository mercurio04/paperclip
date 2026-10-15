import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, parse as parsePath, resolve, sep } from "node:path";

import {
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
  type CodexTaskEnvelope,
} from "../../contracts/codex.js";
import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import type {
  HarnessDriver,
  HarnessDriverConfigValidation,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  HarnessTranscriptSnapshot,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestHandoff,
  HarnessRuntimeRequestResolution,
  PaperclipOpenCodePermissionContract,
  PaperclipPermissionDecision,
  PaperclipQuestion,
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import {
  PAPERCLIP_OPENCODE_PERMISSION_CONTRACT_SCHEMA_V1,
  PAPERCLIP_PERMISSION_DECISIONS,
  PAPERCLIP_RUNTIME_REQUEST_PERMISSION_SCHEMA_V1,
  PAPERCLIP_QUESTION_SET_SCHEMA,
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  isRestrictedV1ApprovablePermissionTool,
  parseHarnessRuntimeRequestResolution,
  RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS,
  parsePaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import type {
  NativeSessionCapabilities,
  NativeUserMessage,
} from "../../contracts/types.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import {
  createProviderTraceFileSink,
  type ProviderTraceFileSink,
} from "../../contracts/provider-trace-file-sink.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import {
  canonicalOpenCodeDisplayToolName,
  canonicalProviderEventsFromOpenCodePart,
  providerFamilyCapabilities,
} from "../../provider-events.js";
import {
  canonicalOpenCodeMcpToolName,
  startOpenCodeMcpBridge,
  type OpenCodeMcpBridge,
} from "./mcp-bridge.js";
import { nativeMcpLaunchBinding } from "../native-mcp.js";
import { materializeNativeRuntimeSkills } from "../runtime-context-materializer.js";

export const OPENCODE_SERVER_DRIVER_KIND = "opencode_server" as const;
export const QUALIFIED_OPENCODE_VERSION = "1.18.29" as const;
export const QUALIFIED_OPENCODE_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  threadId: string;
  turnId: string;
  arguments: unknown;
}) => Promise<unknown>;

export type OpenCodePermissionProfile = "restricted_v1";

export interface OpenCodeServerDriverOptions {
  model: string;
  permissionMode?: "allow" | "ask" | "deny";
  /**
   * Opt-in TAX-452 profile. When set, every native permission becomes a typed,
   * hash-bound Paperclip request, the provider is pinned to a loopback
   * llama.cpp endpoint, and the child environment is reduced to an allowlist.
   * Absent, the legacy behavior is unchanged.
   */
  permissionProfile?: OpenCodePermissionProfile;
  /** Required with `restricted_v1`: http URL on 127.0.0.1, localhost, or ::1. */
  llamaCppBaseUrl?: string;
  taskEnvelope?: CodexTaskEnvelope;
  runnerInstanceId?: string;
  command?: string;
  /** Inherited runner-owned executable descriptor duplicated into the child. */
  commandFd?: number;
  /** Runner-owned executable path lifecycle used only by the macOS proxy. */
  commandLifecycle?: {
    beforeSpawn(): void;
    afterSpawn(): void;
  };
  runtimeDirectory: string;
  systemInstructions?: string;
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: DynamicToolHandler;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Keep false when an outer supervisor already owns the process group. */
  isolateProcessGroup?: boolean;
  onDiagnostic?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface OpenCodeRuntime {
  baseUrl: string;
  authHeader: string;
  version: string;
  permissionMode: "allow" | "ask" | "deny";
  permissionProfile: OpenCodePermissionProfile | null;
  process: ChildProcess;
  bridge: OpenCodeMcpBridge;
  trace: ProviderTraceFileSink | null;
  sensitiveValues: readonly string[];
  close(input?: {
    finalizeTrace?: boolean;
    reason?: string | null;
  }): Promise<void>;
}

const CAPABILITIES: NativeSessionCapabilities = {
  resume: true,
  typedEvents: true,
  typedEventFamilies: providerFamilyCapabilities({
    tool_execution: "available",
    research: "available",
    delegation: "available",
    context: "available",
    artifact: "policy_disabled",
    provider_notice: "available",
  }),
  steering: false,
  interruption: true,
  structuredResult: true,
  read: true,
  reconciliation: true,
  usage: true,
  dynamicTools: true,
  runtimeRequestResolution: true,
  runtimeRequestHandoff: true,
  goals: false,
  threadLineage: false,
  unsupported: ["steering", "goals", "threadLineage"],
};

export class OpenCodeServerDriver implements HarnessDriver {
  readonly #options: OpenCodeServerDriverOptions;

  constructor(options: OpenCodeServerDriverOptions) {
    if (options.permissionProfile !== undefined) {
      if (options.permissionProfile !== "restricted_v1")
        throw new Error("OpenCode permission profile is invalid");
      restrictedLlamaCppModelId(options.model);
      validateLoopbackLlamaCppBaseUrl(options.llamaCppBaseUrl);
    }
    this.#options = options;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: OPENCODE_SERVER_DRIVER_KIND,
      displayName: "OpenCode server",
      version: QUALIFIED_OPENCODE_VERSION,
      protocolVersion: "http+sse/v1",
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "native",
        mcp: "native",
      },
      capabilities: structuredClone(CAPABILITIES),
    };
  }

  async validateConfig(
    config: unknown,
  ): Promise<HarnessDriverConfigValidation> {
    const candidate = isRecord(config) ? config : {};
    const issues = [];
    const model =
      typeof candidate.model === "string" ? candidate.model.trim() : "";
    if (!validModel(model))
      issues.push({
        path: "model",
        code: "invalid_model",
        message: "OpenCode model must use provider/model form.",
      });
    const command =
      typeof candidate.command === "string"
        ? candidate.command.trim()
        : "opencode";
    if (!command)
      issues.push({
        path: "command",
        code: "invalid_command",
        message: "OpenCode command cannot be empty.",
      });
    const permissionMode = candidate.permissionMode ?? "allow";
    if (
      permissionMode !== "allow" &&
      permissionMode !== "ask" &&
      permissionMode !== "deny"
    ) {
      issues.push({
        path: "permissionMode",
        code: "invalid_permission_mode",
        message: "OpenCode permission mode must be allow, ask, or deny.",
      });
    }
    return issues.length === 0
      ? { ok: true, config: { model, command, permissionMode }, issues: [] }
      : { ok: false, config: null, issues };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return this.#open(input, null);
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (
      snapshot.driverKind !== OPENCODE_SERVER_DRIVER_KIND ||
      !snapshot.runId ||
      !snapshot.normalizedSessionId ||
      !snapshot.driverSessionId
    )
      return {
        recovered: false,
        reason: "persisted OpenCode session identity is incomplete",
      };
    try {
      const session = await this.#open(
        {
          runId: snapshot.runId,
          normalizedSessionId: snapshot.normalizedSessionId,
          workingDirectory: await this.#readWorkspace(
            snapshot.normalizedSessionId,
          ),
        },
        snapshot,
      );
      return { recovered: true, session };
    } catch (error) {
      return {
        recovered: false,
        reason: redact(String(error), [
          this.#options.environment?.OPENROUTER_API_KEY,
        ]),
      };
    }
  }

  async #readWorkspace(normalizedSessionId: string): Promise<string> {
    const raw = await readFile(
      join(
        sessionRoot(this.#options.runtimeDirectory, normalizedSessionId),
        "workspace",
      ),
      "utf8",
    );
    return raw.trim();
  }

  async #open(
    input: OpenHarnessSessionInput,
    snapshot: PersistedHarnessSession | null,
  ): Promise<HarnessSession> {
    const cwd = validateWorkspace(input.workingDirectory);
    const root = sessionRoot(
      this.#options.runtimeDirectory,
      input.normalizedSessionId,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "workspace"), `${cwd}\n`, { mode: 0o600 });
    // restricted_v1: frozen once per session; permission targets and cwd must
    // stay inside the workspace and never reach the private runtime root.
    const workspaceRealpath = await realpath(cwd);
    const privateRootRealpath = await realpath(root);
    const trace = await createProviderTraceFileSink({
      path: this.#options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH,
      provider: "opencode",
      channel: "typescript_opencode_native",
      maxBytes: this.#options.environment?.PAPERCLIP_PROVIDER_TRACE_MAX_BYTES,
    });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let session: OpenCodeHarnessSession | null = null;
      let runtime: OpenCodeRuntime | null = null;
      try {
        runtime = await startRuntime({
          options: this.#options,
          root,
          cwd,
          trace,
          dispatch: (call) => {
            if (session === null)
              throw new Error("OpenCode session is not ready for tool calls");
            return session.dispatchTool(call);
          },
        });
        const fetcher = this.#options.fetch ?? globalThis.fetch;
        let providerSessionId =
          snapshot?.providerSessionId ?? snapshot?.driverSessionId ?? null;
        if (providerSessionId !== null) {
          const existing = await api(
            fetcher,
            runtime,
            `/session/${encodeURIComponent(providerSessionId)}`,
          );
          if (!isRecord(existing) || text(existing.id) !== providerSessionId)
            throw new Error("OpenCode resumed a different session");
        } else {
          const created = await api(fetcher, runtime, "/session", {
            method: "POST",
            body: JSON.stringify({ title: `Paperclip ${input.runId}` }),
          });
          providerSessionId = text(record(created).id);
          if (!providerSessionId)
            throw new Error("OpenCode session creation omitted its id");
        }
        session = new OpenCodeHarnessSession({
          runtime,
          fetcher,
          runId: input.runId,
          normalizedSessionId: input.normalizedSessionId,
          providerSessionId,
          workingDirectory: cwd,
          workspaceRealpath,
          privateRootRealpath,
          runnerInstanceId:
            this.#options.runnerInstanceId ??
            `paperclip-opencode-${input.runId}`,
          model: this.#options.model,
          taskEnvelope:
            this.#options.taskEnvelope ??
            createCodexTaskEnvelope({
              objective: "Complete the supplied task.",
            }),
          systemInstructions:
            this.#options.systemInstructions ??
            CODEX_SKILLLESS_BASE_INSTRUCTIONS,
          dynamicToolHandler: this.#options.dynamicToolHandler,
          snapshot,
          now: this.#options.now ?? (() => new Date()),
        });
        session.startEventPump();
        return session;
      } catch (error) {
        lastError = error;
        await runtime?.close({ finalizeTrace: false });
        if (attempt === 3 || !retryableOpenCodeStartupError(error)) {
          await trace?.finish({ reason: "opencode_session_start_failed" });
          throw error;
        }
        this.#options.onDiagnostic?.(
          `OpenCode session startup attempt ${attempt} failed; retrying.`,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, 100 * attempt),
        );
      }
    }
    throw lastError;
  }
}

class OpenCodeHarnessSession implements HarnessSession {
  readonly #runtime: OpenCodeRuntime;
  readonly #fetch: typeof globalThis.fetch;
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #providerSessionId: string;
  readonly #workingDirectory: string;
  readonly #workspaceRealpath: string;
  readonly #privateRootRealpath: string;
  readonly #runnerInstanceId: string;
  readonly #model: string;
  readonly #taskEnvelope: CodexTaskEnvelope;
  readonly #systemInstructions: string;
  readonly #dynamicToolHandler?: DynamicToolHandler;
  readonly #now: () => Date;
  readonly #events = new AsyncQueue<PrpEvent>();
  readonly #transcript: PrpEvent[] = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #seenProviderEvents = new Set<string>();
  readonly #messageRoles = new Map<string, string>();
  readonly #pendingMessageParts = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  readonly #partText = new Map<string, string>();
  readonly #completedTextPartIds = new Set<string>();
  readonly #completedReasoningPartIds = new Set<string>();
  readonly #completedTextParts: Array<{
    partId: string;
    messageId: string | null;
    text: string;
    item: Record<string, unknown>;
    observedSourceSeq: number;
  }> = [];
  readonly #messageUsageFingerprints = new Map<string, string>();
  readonly #workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  readonly #emittedFileReferences = new Set<string>();
  readonly #pendingRuntimeRequests = new Map<
    string,
    {
      request: HarnessRuntimeRequest;
      nativeQuestions: Record<string, unknown>[];
      submittedResponse?: PaperclipQuestionResponse;
      submittedAction?: "accept" | "accept_for_session" | "decline" | "cancel";
      settling?: boolean;
    }
  >();
  /** restricted_v1: native permission ids whose contract is being frozen. */
  readonly #typedPermissionsInFlight = new Set<string>();
  /** restricted_v1: every native permission reply Paperclip itself sent. */
  readonly #paperclipPermissionReplies = new Map<
    string,
    PaperclipPermissionDecision
  >();
  /** restricted_v1: native permissions OpenCode itself settled as rejected. */
  readonly #providerRejectedPermissions = new Set<string>();
  /**
   * restricted_v1: permissions invalidated by a terminal turn, SSE loss, or
   * session close. A decision for any of these may never dispatch `once`.
   */
  readonly #invalidatedPermissions = new Set<string>();
  /** restricted_v1: frozen resolution of tool-argument paths (not hashed). */
  readonly #frozenArgumentTargets = new Map<string, string>();
  #activeTraceFrameId: number | null = null;
  #activeTraceEmittedEventIds: string[] = [];
  #sourceSequence: number;
  #activeTurnId: string | null;
  #result: PrpStructuredRunResult | null;
  #resultFingerprint: string | null;
  #resultCallId: string | null;
  #resultTurnId: string | null;
  #semanticResultTextBoundary: number | null = null;
  #semanticResultProviderMessageId: string | null = null;
  #lastNonTerminalToolSourceSeq = 0;
  #usage: Record<string, unknown> | null = null;
  #sendFullContext: boolean;
  #closed = false;
  #abort = new AbortController();

  constructor(input: {
    runtime: OpenCodeRuntime;
    fetcher: typeof globalThis.fetch;
    runId: string;
    normalizedSessionId: string;
    providerSessionId: string;
    workingDirectory: string;
    workspaceRealpath: string;
    privateRootRealpath: string;
    runnerInstanceId: string;
    model: string;
    taskEnvelope: CodexTaskEnvelope;
    systemInstructions: string;
    dynamicToolHandler?: DynamicToolHandler;
    snapshot: PersistedHarnessSession | null;
    now: () => Date;
  }) {
    this.#runtime = input.runtime;
    this.#fetch = input.fetcher;
    this.#runId = input.runId;
    this.#sourceSequence = 0;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#providerSessionId = input.providerSessionId;
    this.#workingDirectory = input.workingDirectory;
    this.#workspaceRealpath = input.workspaceRealpath;
    this.#privateRootRealpath = input.privateRootRealpath;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#model = input.model;
    this.#taskEnvelope = input.taskEnvelope;
    this.#systemInstructions = input.systemInstructions;
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#now = input.now;
    this.#sendFullContext = input.snapshot === null;
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    const restored = input.snapshot?.semanticResult ?? null;
    this.#result = restored?.result ?? null;
    this.#resultFingerprint = restored?.fingerprint ?? null;
    this.#resultCallId = restored?.callId ?? null;
    this.#resultTurnId = restored?.turnId ?? null;
    for (const terminal of input.snapshot?.terminalTurns ?? [])
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
    this.#emit(input.snapshot ? "session.resumed" : "session.started", {
      driverSessionId: input.providerSessionId,
      providerSessionId: input.providerSessionId,
      context: {
        protocolVersion: "http+sse/v1",
        opencodeVersion: input.runtime.version,
        model: input.model,
        modelProvider: input.model.split("/", 1)[0],
        workingDirectory: input.workingDirectory,
        environmentKeys: input.runtime.permissionProfile
          ? [...RESTRICTED_ENVIRONMENT_KEYS]
          : sanitizedEnvironmentKeys(),
        permissionMode: input.runtime.permissionMode,
        ...(input.runtime.permissionProfile
          ? { permissionProfile: input.runtime.permissionProfile }
          : {}),
      },
    });
    this.#emit(
      "item.completed",
      {
        kind: "model",
        text: `${input.model} (OpenCode ${input.runtime.version})`,
        model: {
          name: input.model,
          provider: input.model.split("/", 1)[0],
          opencodeVersion: input.runtime.version,
        },
      },
      { itemId: `${input.providerSessionId}:model` },
    );
  }

  ids() {
    return {
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      displayId: this.#providerSessionId,
    };
  }

  attachRun(input: { runId: string }): void {
    if (this.#activeTurnId !== null)
      throw new Error("opencode_run_attach_busy");
    if (!input.runId) throw new Error("opencode_run_attach_invalid");
    this.#runId = input.runId;
    this.#result = null;
    this.#resultFingerprint = null;
    this.#resultCallId = null;
    this.#resultTurnId = null;
    this.#semanticResultTextBoundary = null;
    this.#semanticResultProviderMessageId = null;
    this.#lastNonTerminalToolSourceSeq = 0;
    this.#completedTextPartIds.clear();
    this.#completedReasoningPartIds.clear();
    this.#completedTextParts.length = 0;
    this.#terminalTurns.clear();
    this.#sendFullContext = false;
    this.#emit("run.attached", { runId: input.runId, sameSession: true });
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  startEventPump(): void {
    void this.#recoverPendingRuntimeRequests()
      .catch((error) =>
        this.#emit("harness.diagnostic", {
          code: "opencode_runtime_request_recovery_failed",
          message: redact(String(error), this.#runtime.sensitiveValues),
        }),
      )
      .finally(() => this.#pumpEvents());
  }

  async startTurn(input: {
    message: NativeUserMessage;
  }): Promise<{ turnId: string }> {
    if (this.#activeTurnId !== null)
      throw new Error("OpenCode session already has an active turn");
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#activeTurnId = turnId;
    this.#emit("turn.submitted", {
      envelopeSchema: this.#taskEnvelope.schema,
      text: input.message.text,
    });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    const [providerID, ...modelParts] = this.#model.split("/");
    const modelID = modelParts.join("/");
    // A resumed OpenCode provider session already retains the original system
    // instructions and task envelope in its conversation. Repeating both on
    // every Paperclip continuation can overflow smaller context windows and
    // OpenCode then completes with `finish: unknown` and zero tokens. The
    // native model envelope still carries the authoritative wake delta,
    // interaction responses, completion contract, and current issue context.
    const prompt = this.#sendFullContext
      ? JSON.stringify({
          task: this.#taskEnvelope,
          message: input.message.text,
        })
      : input.message.text;
    await api(
      this.#fetch,
      this.#runtime,
      `/session/${encodeURIComponent(this.#providerSessionId)}/prompt_async`,
      {
        method: "POST",
        body: JSON.stringify({
          // OpenCode 1.18's PromptPayload carries the provider and model at the
          // top level.  Older examples used a nested `model` object; 1.18
          // silently ignores that shape and falls back to the configured model,
          // which can turn `openrouter/deepseek/...` into a duplicated provider
          // lookup. Keep Paperclip's persisted provider/model form, but adapt it
          // at this HTTP boundary.
          providerID,
          modelID,
          // This exact OpenCode version passed the native-question conformance
          // suite. question.asked is adapted into PRP v2 and its reply/reject API
          // remains private to this driver.
          tools: { question: true },
          ...(this.#sendFullContext
            ? { system: this.#systemInstructions }
            : {}),
          parts: [{ type: "text", text: prompt }],
        }),
      },
    );
    this.#sendFullContext = false;
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    if (
      input.turnId &&
      this.#activeTurnId &&
      input.turnId !== this.#activeTurnId
    )
      throw new Error("stale OpenCode turn");
    // restricted_v1: OpenCode 1.18 blocks the turn inside a pending
    // permission and never acknowledges /abort while it waits, so a cancelled
    // run kept its OpenCode (and runnerd) alive. Reject every pending typed
    // permission natively first (exactly once, never `once`); the tool call
    // then fails and the abort settles as a normal cancelled turn.
    this.#invalidateTypedPermissions("turn_interrupted", null);
    await api(
      this.#fetch,
      this.#runtime,
      `/session/${encodeURIComponent(this.#providerSessionId)}/abort`,
      { method: "POST" },
    );
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pendingRuntimeRequests.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (!pending) {
      if (this.#invalidatedPermissions.has(input.requestId))
        this.#emitDecisionAfterTerminal(input.requestId, input.turnId);
      throw new Error(
        `OpenCode request ${input.requestId} is no longer pending`,
      );
    }
    if (
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId
    ) {
      throw new Error(
        `OpenCode request ${input.requestId} belongs to a stale turn`,
      );
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      pending.request.requestKind,
      input.resolution,
      pending.request.input,
      pending.request.permission,
    );
    if (pending.settling)
      throw new Error(
        `OpenCode request ${input.requestId} is already settling`,
      );
    pending.settling = true;
    if (pending.request.permission !== undefined) {
      await this.#resolveTypedPermission(
        input.requestId,
        input.turnId,
        pending,
        resolution,
      );
      return;
    }
    const submit = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        if (this.#pendingRuntimeRequests.get(input.requestId) === pending)
          pending.settling = false;
        throw error;
      }
    };
    const workspace = `directory=${encodeURIComponent(this.#workingDirectory)}`;
    if (pending.request.requestKind === "permission_approval") {
      const action =
        resolution.action === "accept" ||
        resolution.action === "accept_for_session"
          ? resolution.action
          : resolution.action === "decline" || resolution.action === "cancel"
            ? resolution.action
            : "decline";
      pending.submittedAction = action;
      await submit(
        api(
          this.#fetch,
          this.#runtime,
          `/permission/${encodeURIComponent(input.requestId)}/reply?${workspace}`,
          {
            method: "POST",
            body: JSON.stringify({
              reply:
                action === "accept"
                  ? "once"
                  : action === "accept_for_session"
                    ? "always"
                    : "reject",
            }),
          },
        ),
      );
      if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
      this.#emit(
        "runtime_request.resolved",
        harnessRuntimeRequestOutcome(pending.request, { action }),
        {
          turnId: input.turnId,
          itemId: pending.request.itemId,
        },
      );
      return;
    }
    const base = `/question/${encodeURIComponent(input.requestId)}`;
    if (resolution.action === "submit" && "response" in resolution) {
      // OpenCode can broadcast question.replied before the reply HTTP request
      // returns. Retain the canonical response before crossing that boundary
      // so the racing terminal event carries the same durable answer record.
      pending.submittedResponse = structuredClone(resolution.response);
      await submit(
        api(this.#fetch, this.#runtime, `${base}/reply?${workspace}`, {
          method: "POST",
          body: JSON.stringify({
            answers: openCodeAnswers(pending, resolution.response),
          }),
        }),
      );
    } else if (resolution.action === "submit" && "answers" in resolution) {
      await submit(
        api(this.#fetch, this.#runtime, `${base}/reply?${workspace}`, {
          method: "POST",
          body: JSON.stringify({
            answers: pending.nativeQuestions.map(
              (question, index) =>
                resolution.answers[openCodeQuestionId(question, index)]
                  ?.answers ?? [],
            ),
          }),
        }),
      );
    } else {
      await submit(
        api(this.#fetch, this.#runtime, `${base}/reject?${workspace}`, {
          method: "POST",
        }),
      );
    }
    // question.replied/question.rejected can race the HTTP response on the SSE
    // stream. The first terminal fact wins; the echo must not emit a duplicate.
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
    this.#emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        ...(resolution.action === "submit" && "response" in resolution
          ? { response: resolution.response }
          : {}),
      }),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
  }

  handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff {
    if (input.signal.aborted) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (
      !pending ||
      pending.request.input === undefined ||
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId ||
      pending.settling ||
      pending.submittedResponse !== undefined ||
      pending.submittedAction !== undefined
    )
      return { result: "already_settled", cleanup: Promise.resolve() };
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    this.#emit(
      "runtime_request.expired",
      harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    const workspace = `directory=${encodeURIComponent(this.#workingDirectory)}`;
    const cleanup = Promise.allSettled([
      api(
        this.#fetch,
        this.#runtime,
        `/question/${encodeURIComponent(input.requestId)}/reject?${workspace}`,
        { method: "POST" },
      ),
      api(
        this.#fetch,
        this.#runtime,
        `/session/${encodeURIComponent(this.#providerSessionId)}/abort`,
        { method: "POST" },
      ),
    ]).then(() => undefined);
    return { result: "handed_off", cleanup };
  }

  async read(): Promise<Record<string, unknown>> {
    const messages = await api(
      this.#fetch,
      this.#runtime,
      `/session/${encodeURIComponent(this.#providerSessionId)}/message`,
    );
    return { sessionId: this.#providerSessionId, messages };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const status = await api(this.#fetch, this.#runtime, "/session/status");
    return {
      sessionId: this.#providerSessionId,
      status: record(status)[this.#providerSessionId] ?? null,
    };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: true,
      eventCount: this.#transcript.length,
      events: structuredClone(this.#transcript),
      omissionReason: null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: OPENCODE_SERVER_DRIVER_KIND,
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      semanticResult:
        this.#result && this.#resultFingerprint && this.#resultTurnId
          ? {
              result: structuredClone(this.#result),
              fingerprint: this.#resultFingerprint,
              callId: this.#resultCallId,
              turnId: this.#resultTurnId,
            }
          : null,
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({
        turnId,
        fingerprint,
      })),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    for (const id of this.#typedPermissionsInFlight)
      this.#invalidatedPermissions.add(id);
    for (const [id, { request }] of this.#pendingRuntimeRequests)
      if (request.permission !== undefined) this.#invalidatedPermissions.add(id);
    for (const { request } of this.#pendingRuntimeRequests.values()) {
      this.#emit(
        request.input === undefined
          ? "runtime_request.cancelled"
          : "runtime_request.expired",
        request.input === undefined
          ? harnessRuntimeRequestOutcome(request, { reason: "session_closed" })
          : harnessRuntimeInputExpiredOutcome(request, "provider_process_lost"),
        { turnId: request.turnId, itemId: request.itemId },
      );
    }
    this.#pendingRuntimeRequests.clear();
    this.#events.close();
    await this.#runtime.close();
  }

  async dispatchTool(call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }): Promise<unknown> {
    const tool = canonicalOpenCodeMcpToolName(call.tool);
    const turnId = this.#activeTurnId;
    if (turnId === null)
      throw new Error("OpenCode tool call is not bound to an active turn");
    this.#emit(
      "item.started",
      {
        kind: "dynamicToolCall",
        item: {
          type: "tool_call",
          id: call.callId,
          name: tool,
          arguments: call.arguments,
        },
      },
      { turnId, itemId: call.callId },
    );
    if (tool === PRP_COMPLETION_TOOL_NAME || tool === PRP_BLOCK_TOOL_NAME) {
      const validation = validatePrpStructuredRunResult(call.arguments);
      if (!validation.ok) throw new Error("Invalid semantic result");
      if (
        (tool === PRP_BLOCK_TOOL_NAME &&
          validation.result.reportedWorkDisposition !== "blocked") ||
        (tool === PRP_COMPLETION_TOOL_NAME &&
          validation.result.reportedWorkDisposition === "blocked")
      )
        throw new Error(
          "Semantic result disposition does not match the terminal tool",
        );
      if (
        validation.result.completionClaim.contractRevision !==
        this.#taskEnvelope.completionContract.revision
      ) {
        throw new Error(
          "Semantic result completion contract revision does not match",
        );
      }
      const fingerprint = canonicalJson(validation.result);
      if (this.#resultFingerprint && this.#resultFingerprint !== fingerprint)
        throw new Error("A different semantic result was already committed");
      if (!this.#resultFingerprint) {
        this.#result = structuredClone(validation.result);
        this.#resultFingerprint = fingerprint;
        this.#resultCallId = call.callId;
        this.#resultTurnId = turnId;
        this.#semanticResultTextBoundary = this.#completedTextParts.length;
        this.#emit("run.result.proposed", validation.result, {
          turnId,
          itemId: call.callId,
        });
      }
      this.#emit(
        "item.completed",
        {
          kind: "dynamicToolCall",
          item: {
            type: "tool_result",
            id: call.callId,
            tool_use_id: call.callId,
            result: "Semantic completion accepted.",
          },
        },
        { turnId, itemId: call.callId },
      );
      return { accepted: true };
    }
    if (!this.#dynamicToolHandler)
      throw new Error("Unsupported Paperclip operation");
    try {
      const result = await this.#dynamicToolHandler({
        tool,
        callId: call.callId,
        threadId: this.#providerSessionId,
        turnId,
        arguments: call.arguments,
      });
      this.#emit(
        "item.completed",
        {
          kind: "dynamicToolCall",
          item: {
            type: "tool_result",
            id: call.callId,
            tool_use_id: call.callId,
            result,
          },
        },
        { turnId, itemId: call.callId },
      );
      return result;
    } catch (error) {
      this.#emit(
        "item.completed",
        {
          kind: "dynamicToolCall",
          item: {
            type: "tool_result",
            id: call.callId,
            tool_use_id: call.callId,
            error: redact(String(error)),
            is_error: true,
          },
        },
        { turnId, itemId: call.callId },
      );
      throw error;
    }
  }

  async #recoverPendingRuntimeRequests(): Promise<void> {
    await this.#recoverPendingQuestions();
    const value = await api(
      this.#fetch,
      this.#runtime,
      `/permission?directory=${encodeURIComponent(this.#workingDirectory)}`,
    );
    const pending = Array.isArray(value)
      ? value
      : Array.isArray(record(value).permissions)
        ? (record(value).permissions as unknown[])
        : [];
    for (const entry of pending) {
      const permission = record(entry);
      const sessionId = text(permission.sessionID, text(permission.sessionId));
      if (sessionId && sessionId !== this.#providerSessionId) continue;
      this.#acceptPermission(permission, "permission.recovered");
    }
  }

  async #recoverPendingQuestions(): Promise<void> {
    const value = await api(
      this.#fetch,
      this.#runtime,
      `/question?directory=${encodeURIComponent(this.#workingDirectory)}`,
    );
    const pending = Array.isArray(value)
      ? value
      : Array.isArray(record(value).questions)
        ? (record(value).questions as unknown[])
        : [];
    for (const entry of pending) {
      const question = record(entry);
      const sessionId = text(question.sessionID, text(question.sessionId));
      if (sessionId && sessionId !== this.#providerSessionId) continue;
      this.#acceptQuestion(question);
    }
  }

  #acceptQuestion(properties: Record<string, unknown>): void {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    const requestId = text(
      properties.id,
      text(properties.requestID, text(properties.requestId)),
    );
    const nativeQuestions = Array.isArray(properties.questions)
      ? properties.questions.map(record).slice(0, 64)
      : [];
    if (!requestId || nativeQuestions.length === 0) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_rejected",
          adapter: "opencode-server",
          reason:
            "OpenCode emitted a question event without a request id or supported questions.",
        },
        { turnId, ...(requestId ? { itemId: requestId } : {}) },
      );
      return;
    }
    if (this.#pendingRuntimeRequests.has(requestId)) return;
    let input: PaperclipQuestionSet;
    try {
      input = normalizeOpenCodeQuestionSet(nativeQuestions, properties);
    } catch {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_rejected",
          adapter: "opencode-server",
          reason: "OpenCode emitted a malformed or ambiguous question set.",
        },
        { turnId, itemId: requestId },
      );
      return;
    }
    const request: HarnessRuntimeRequest = {
      requestId,
      requestKind: "user_input",
      method: "question.asked",
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: "OpenCode requests user input.",
      details: {},
      input,
      origin: {
        adapter: "opencode-server",
        provider: "opencode",
        method: "question.asked",
      },
    };
    this.#pendingRuntimeRequests.set(requestId, { request, nativeQuestions });
    this.#emit(
      "runtime_request.created",
      {
        request: {
          schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
          requestKind: "runtime",
          requestId,
          type: "input",
          status: "pending",
          prompt: request.prompt,
          input,
          origin: request.origin,
          turnId,
          itemId: request.itemId,
        },
      },
      { turnId, itemId: request.itemId },
    );
  }

  #acceptPermission(properties: Record<string, unknown>, method: string): void {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    if (this.#runtime.permissionProfile === "restricted_v1") {
      void this.#acceptTypedPermission(properties, turnId);
      return;
    }
    const permission = isRecord(properties.permission)
      ? properties.permission
      : isRecord(properties.request)
        ? properties.request
        : properties;
    const requestId = text(
      permission.id,
      text(
        permission.requestID,
        text(permission.requestId, text(permission.permissionID)),
      ),
    );
    if (!requestId || this.#pendingRuntimeRequests.has(requestId)) return;
    const title = text(
      permission.title,
      text(permission.permission, text(permission.tool, "requested operation")),
    );
    const request: HarnessRuntimeRequest = {
      requestId,
      requestKind: "permission_approval",
      method,
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: `OpenCode requests permission for ${title}.`.slice(0, 4000),
      details: bounded(permission),
      origin: { adapter: "opencode-server", provider: "opencode", method },
    };
    this.#pendingRuntimeRequests.set(requestId, {
      request,
      nativeQuestions: [],
    });
    this.#emit(
      "runtime_request.created",
      {
        request: {
          schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
          requestKind: "runtime",
          requestId,
          type: "permission",
          status: "pending",
          prompt: request.prompt,
          actions: ["accept", "accept_for_session", "decline", "cancel"],
          details: request.details,
          origin: request.origin,
          turnId,
          itemId: request.itemId,
        },
      },
      { turnId, itemId: request.itemId },
    );
  }

  /**
   * restricted_v1 (TAX-452 §1): freeze the exact native request into a
   * hash-bound contract before anyone can approve it. Anything that cannot be
   * represented losslessly is rejected natively instead of being shown.
   */
  async #acceptTypedPermission(
    properties: Record<string, unknown>,
    turnId: string,
  ): Promise<void> {
    const requestId = text(properties.id);
    if (
      !requestId ||
      this.#pendingRuntimeRequests.has(requestId) ||
      this.#typedPermissionsInFlight.has(requestId) ||
      this.#paperclipPermissionReplies.has(requestId)
    )
      return;
    this.#typedPermissionsInFlight.add(requestId);
    try {
      let contract: PaperclipOpenCodePermissionContract;
      let argumentTargets: string[];
      try {
        ({ contract, argumentTargets } =
          await this.#freezePermissionContract(properties));
      } catch (error) {
        this.#emit(
          "harness.diagnostic",
          {
            code:
              error instanceof PermissionUnknownToolError
                ? "permission_unknown_tool"
                : "permission_contract_unrepresentable",
            adapter: "opencode-server",
            providerRequestId: requestId,
            reason: redact(
              error instanceof Error ? error.message : String(error),
              this.#runtime.sensitiveValues,
            ).slice(0, 1_000),
          },
          { turnId, itemId: requestId },
        );
        if (!this.#providerRejectedPermissions.has(requestId)) {
          const delivered = await this.#replyPermissionOnce(
            requestId,
            "reject",
            turnId,
          );
          if (!delivered)
            await this.#failTurnClosed(turnId, "permission_reply_uncertain");
        }
        return;
      }
      const escaped = this.#escapesWorkspace(contract, argumentTargets);
      if (escaped !== null) {
        // TAX-470 H1: a target (after symlink resolution of the deepest
        // existing ancestor) or the cwd leaves the workspace, or reaches the
        // private runtime root. Never ask a human to approve that.
        this.#emit(
          "harness.diagnostic",
          {
            code: "permission_target_outside_workspace",
            adapter: "opencode-server",
            providerRequestId: requestId,
            permission: contract.permission,
            reason: escaped,
          },
          { turnId, itemId: requestId },
        );
        if (
          !this.#closed &&
          !this.#paperclipPermissionReplies.has(requestId) &&
          !this.#providerRejectedPermissions.has(requestId)
        ) {
          const delivered = await this.#replyPermissionOnce(
            requestId,
            "reject",
            turnId,
          );
          if (!delivered)
            await this.#failTurnClosed(turnId, "permission_reply_uncertain");
        }
        return;
      }
      if (
        this.#closed ||
        this.#activeTurnId !== turnId ||
        !this.#typedPermissionsInFlight.has(requestId) ||
        this.#invalidatedPermissions.has(requestId)
      ) {
        // The turn ended or a reply raced the freeze; never surface a request
        // nobody can answer. A still-pending native request fails closed.
        if (
          !this.#closed &&
          !this.#paperclipPermissionReplies.has(requestId) &&
          !this.#providerRejectedPermissions.has(requestId)
        )
          await this.#replyPermissionOnce(requestId, "reject", turnId);
        return;
      }
      const request: HarnessRuntimeRequest = {
        requestId,
        requestKind: "permission_approval",
        method: "permission.asked",
        turnId,
        itemId: requestId,
        status: "pending",
        prompt: permissionPrompt(contract),
        details: {},
        origin: {
          adapter: "opencode-server",
          provider: "opencode",
          method: "permission.asked",
        },
        permission: contract,
        decisions: [...PAPERCLIP_PERMISSION_DECISIONS],
      };
      this.#pendingRuntimeRequests.set(requestId, {
        request,
        nativeQuestions: [],
      });
      this.#frozenArgumentTargets.set(requestId, canonicalJson(argumentTargets));
      this.#emit(
        "runtime_request.created",
        {
          request: {
            schema: PAPERCLIP_RUNTIME_REQUEST_PERMISSION_SCHEMA_V1,
            requestKind: "runtime",
            requestId,
            type: "permission",
            status: "pending",
            prompt: request.prompt,
            turnId,
            itemId: requestId,
            origin: structuredClone(request.origin),
            decisions: [...PAPERCLIP_PERMISSION_DECISIONS],
            permission: structuredClone(contract),
          },
        },
        { turnId, itemId: requestId },
      );
    } finally {
      this.#typedPermissionsInFlight.delete(requestId);
    }
  }

  async #freezePermissionContract(properties: Record<string, unknown>): Promise<{
    contract: PaperclipOpenCodePermissionContract;
    argumentTargets: string[];
  }> {
    const providerRequestId = text(properties.id);
    const sessionId = text(properties.sessionID);
    const permission = text(properties.permission);
    if (!providerRequestId) throw new Error("permission id is missing");
    if (sessionId !== this.#providerSessionId)
      throw new Error("permission sessionID does not match the session");
    if (!permission) throw new Error("permission name is missing");
    // TAX-452 H9: only the documented (permission, tool) pairs are approvable.
    if (
      !Object.prototype.hasOwnProperty.call(
        RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS,
        permission,
      )
    )
      throw new PermissionUnknownToolError(
        `permission ${JSON.stringify(permission.slice(0, 160))} is not approvable in restricted_v1`,
      );
    const patterns = stringArray(properties.patterns);
    const always = stringArray(properties.always);
    if (patterns === null) throw new Error("permission patterns are invalid");
    if (always === null) throw new Error("permission always list is invalid");
    if (!isRecord(properties.metadata))
      throw new Error("permission metadata is missing");
    // TAX-452 H10: without the exact tool call and its complete arguments
    // there is nothing a human could approve. Never freeze a partial contract.
    if (!isRecord(properties.tool))
      throw new Error("permission tool reference is missing");
    const messageId = text(properties.tool.messageID);
    const callId = text(properties.tool.callID);
    if (!messageId || !callId)
      throw new Error("permission tool reference is incomplete");
    const toolPart = await this.#fetchToolPart({ messageId, callId });
    if (!isRestrictedV1ApprovablePermissionTool(permission, toolPart.name))
      throw new PermissionUnknownToolError(
        `tool ${JSON.stringify(toolPart.name.slice(0, 160))} is not approvable for permission ${JSON.stringify(permission.slice(0, 160))}`,
      );
    const tool: PaperclipOpenCodePermissionContract["tool"] = {
      name: toolPart.name,
      messageId,
      callId,
    };
    const toolArguments = toolPart.arguments;
    const cwd = await realpath(this.#workingDirectory);
    const targets = await resolvePermissionTargets(cwd, patterns);
    const unsigned = jsonClean({
      schema: PAPERCLIP_OPENCODE_PERMISSION_CONTRACT_SCHEMA_V1,
      provider: "opencode",
      providerVersion: this.#runtime.version,
      providerSessionId: sessionId,
      providerRequestId,
      permission,
      tool,
      patterns,
      always,
      metadata: properties.metadata,
      arguments: toolArguments,
      cwd,
      targets,
      policy: { profile: "restricted_v1", permissionDefault: "ask" },
    });
    const contract = {
      ...unsigned,
      contractSha256: permissionContractSha256(unsigned),
    } as unknown as PaperclipOpenCodePermissionContract;
    if (
      Buffer.byteLength(canonicalJson(contract), "utf8") >
      PERMISSION_CONTRACT_MAX_BYTES
    )
      throw new Error("permission contract exceeds 64 KiB");
    return {
      contract,
      argumentTargets: await resolveArgumentTargets(cwd, toolArguments),
    };
  }

  /** Returns why a frozen permission escapes the workspace, or null. */
  #escapesWorkspace(
    contract: PaperclipOpenCodePermissionContract,
    argumentTargets: readonly string[],
  ): string | null {
    const check = (path: string | null, label: string): string | null => {
      if (path === null) return `${label} is unresolved`;
      if (!isWithin(path, this.#workspaceRealpath))
        return `${label} resolves outside the workspace`;
      if (isWithin(path, this.#privateRootRealpath))
        return `${label} resolves into the private runtime root`;
      return null;
    };
    return (
      check(contract.cwd, "cwd") ??
      contract.targets
        .map((target, index) => check(target.resolvedPath, `target ${index}`))
        .find((reason) => reason !== null) ??
      argumentTargets
        .map((target, index) => check(target, `argument path ${index}`))
        .find((reason) => reason !== null) ??
      null
    );
  }

  #emitDecisionAfterTerminal(requestId: string, turnId: string): void {
    this.#emit(
      "harness.diagnostic",
      {
        code: "permission_decision_after_terminal",
        adapter: "opencode-server",
        providerRequestId: requestId,
      },
      { turnId, itemId: requestId },
    );
  }

  /**
   * restricted_v1 (TAX-470 H2/H3): invalidate every typed permission that is
   * pending or still being frozen. Each one is settled natively with exactly
   * one `reject` (unless already settled) and can never be granted later.
   */
  #invalidateTypedPermissions(
    reason: string,
    diagnostic: string | null,
  ): void {
    if (this.#runtime.permissionProfile !== "restricted_v1") return;
    const ids = new Set<string>(this.#typedPermissionsInFlight);
    for (const [id, entry] of this.#pendingRuntimeRequests)
      if (entry.request.permission !== undefined) ids.add(id);
    for (const id of ids) {
      this.#invalidatedPermissions.add(id);
      const entry = this.#pendingRuntimeRequests.get(id);
      const turnId = entry?.request.turnId ?? this.#activeTurnId ?? "";
      if (diagnostic !== null)
        this.#emit(
          "harness.diagnostic",
          {
            code: diagnostic,
            adapter: "opencode-server",
            providerRequestId: id,
          },
          { turnId, itemId: id },
        );
      if (entry && this.#pendingRuntimeRequests.delete(id))
        this.#emit(
          "runtime_request.cancelled",
          harnessRuntimeRequestOutcome(entry.request, { reason }),
          { turnId: entry.request.turnId, itemId: entry.request.itemId },
        );
      if (
        !this.#closed &&
        !this.#paperclipPermissionReplies.has(id) &&
        !this.#providerRejectedPermissions.has(id)
      )
        void this.#replyPermissionOnce(id, "reject", turnId);
    }
  }

  async #fetchToolPart(tool: {
    messageId: string;
    callId: string;
  }): Promise<{ name: string; arguments: Record<string, unknown> }> {
    const message = record(
      await api(
        this.#fetch,
        this.#runtime,
        `/session/${encodeURIComponent(this.#providerSessionId)}/message/${encodeURIComponent(tool.messageId)}?directory=${encodeURIComponent(this.#workingDirectory)}`,
      ),
    );
    const parts = Array.isArray(message.parts) ? message.parts.map(record) : [];
    const matches = parts.filter(
      (part) => text(part.type) === "tool" && text(part.callID) === tool.callId,
    );
    if (matches.length !== 1)
      throw new Error("permission tool part is missing or ambiguous");
    const name = text(matches[0]!.tool);
    if (!name || name.length > 160)
      throw new Error("permission tool part has no tool name");
    const input = record(matches[0]!.state).input;
    if (!isRecord(input)) throw new Error("permission tool input is missing");
    return { name, arguments: jsonClean(input) as Record<string, unknown> };
  }

  /** TAX-452 §4: resolve one typed permission with exactly one native reply. */
  async #resolveTypedPermission(
    requestId: string,
    turnId: string,
    pending: { request: HarnessRuntimeRequest },
    resolution: HarnessRuntimeRequestResolution,
  ): Promise<void> {
    const contract = pending.request.permission!;
    // TAX-470 H2: re-checked after every await and immediately before the
    // native POST. A terminal turn, SSE loss, close, or any settlement of this
    // request wins over the decision; a losing decision never sends `once`.
    const stillCurrent = () =>
      !this.#closed &&
      this.#activeTurnId === turnId &&
      !this.#terminalTurns.has(turnId) &&
      this.#pendingRuntimeRequests.get(requestId) === pending &&
      !this.#invalidatedPermissions.has(requestId) &&
      !this.#paperclipPermissionReplies.has(requestId) &&
      !this.#providerRejectedPermissions.has(requestId);
    const loseRace = async (): Promise<void> => {
      this.#emitDecisionAfterTerminal(requestId, turnId);
      this.#invalidatedPermissions.add(requestId);
      if (
        !this.#closed &&
        !this.#paperclipPermissionReplies.has(requestId) &&
        !this.#providerRejectedPermissions.has(requestId)
      )
        await this.#replyPermissionOnce(requestId, "reject", turnId);
    };
    if (!stillCurrent()) return loseRace();
    let reply: PaperclipPermissionDecision = "reject";
    let diagnostic: string | null = null;
    if (resolution.action === "permission_decision") {
      if (resolution.contractSha256 !== contract.contractSha256) {
        diagnostic = "permission_contract_mismatch";
      } else if (resolution.decision === "once") {
        const live = await this.#permissionStillMatches(
          requestId,
          contract,
        ).catch(() => false);
        if (!stillCurrent()) return loseRace();
        if (live) reply = "once";
        else diagnostic = "permission_contract_drift";
      }
    }
    if (diagnostic !== null)
      this.#emit(
        "harness.diagnostic",
        {
          code: diagnostic,
          adapter: "opencode-server",
          providerRequestId: contract.providerRequestId,
        },
        { turnId, itemId: requestId },
      );
    // No await between this check and the POST being issued.
    if (!stillCurrent()) return loseRace();
    const delivered = await this.#replyPermissionOnce(requestId, reply, turnId);
    this.#frozenArgumentTargets.delete(requestId);
    if (!this.#pendingRuntimeRequests.delete(requestId)) return;
    if (!delivered) {
      this.#emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(pending.request, {
          reason: "permission_reply_uncertain",
        }),
        { turnId, itemId: pending.request.itemId },
      );
      // Never resend; stop the turn instead of leaving an unknown grant.
      await this.#failTurnClosed(turnId, "permission_reply_uncertain");
      return;
    }
    this.#emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        reason: reply === "once" ? "permission_once" : "permission_rejected",
      }),
      { turnId, itemId: pending.request.itemId },
    );
  }

  async #permissionStillMatches(
    requestId: string,
    contract: PaperclipOpenCodePermissionContract,
  ): Promise<boolean> {
    const value = await api(
      this.#fetch,
      this.#runtime,
      `/permission?directory=${encodeURIComponent(this.#workingDirectory)}`,
    );
    const live = (Array.isArray(value) ? value : [])
      .map(record)
      .find((entry) => text(entry.id) === contract.providerRequestId);
    if (!live) return false;
    if (
      text(live.sessionID) !== contract.providerSessionId ||
      text(live.permission) !== contract.permission ||
      canonicalJson(stringArray(live.patterns)) !==
        canonicalJson(contract.patterns)
    )
      return false;
    // TAX-452 H9/H10: the frozen tool identity and complete arguments are
    // mandatory; re-verify the live tool part (name included) before `once`.
    if (
      !isRecord(contract.tool) ||
      !isRecord(contract.arguments) ||
      !isRestrictedV1ApprovablePermissionTool(
        contract.permission,
        contract.tool.name,
      )
    )
      return false;
    const liveTool = record(live.tool);
    if (
      text(liveTool.messageID) !== contract.tool.messageId ||
      text(liveTool.callID) !== contract.tool.callId
    )
      return false;
    const livePart = await this.#fetchToolPart(contract.tool);
    if (livePart.name !== contract.tool.name) return false;
    if (
      sha256Hex(canonicalJson(livePart.arguments)) !==
      sha256Hex(canonicalJson(contract.arguments))
    )
      return false;
    const cwd = await realpath(this.#workingDirectory);
    if (cwd !== contract.cwd) return false;
    const targets = await resolvePermissionTargets(cwd, contract.patterns);
    if (canonicalJson(targets) !== canonicalJson(contract.targets)) return false;
    const argumentTargets = await resolveArgumentTargets(cwd, contract.arguments);
    if (
      canonicalJson(argumentTargets) !==
      this.#frozenArgumentTargets.get(requestId)
    )
      return false;
    return this.#escapesWorkspace(contract, argumentTargets) === null;
  }

  /**
   * Sends exactly one native reply. Never "always", never retried: a failed or
   * timed-out POST is reported as uncertain and the caller fails closed.
   */
  async #replyPermissionOnce(
    requestId: string,
    reply: PaperclipPermissionDecision,
    turnId: string,
  ): Promise<boolean> {
    this.#paperclipPermissionReplies.set(requestId, reply);
    try {
      await api(
        this.#fetch,
        this.#runtime,
        `/permission/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(this.#workingDirectory)}`,
        { method: "POST", body: JSON.stringify({ reply }) },
      );
      return true;
    } catch (error) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "permission_reply_uncertain",
          adapter: "opencode-server",
          providerRequestId: requestId,
          reply,
          reason: redact(String(error), this.#runtime.sensitiveValues).slice(
            0,
            1_000,
          ),
        },
        { turnId, itemId: requestId },
      );
      return false;
    }
  }

  #observeRestrictedPermissionReply(
    properties: Record<string, unknown>,
    turnId: string,
  ): void {
    const requestId = text(
      properties.requestID,
      text(properties.requestId, text(properties.id)),
    );
    const nativeReply = text(properties.reply, text(properties.response));
    const sent = this.#paperclipPermissionReplies.get(requestId);
    const pending = this.#pendingRuntimeRequests.get(requestId);
    if (sent !== undefined && sent === nativeReply) return;
    if (sent === undefined && nativeReply === "reject") {
      // OpenCode cascades a reject (and an abort) to the session's other
      // pending permissions. That only narrows authority, so it settles the
      // request as a provider cancellation rather than a breach.
      this.#typedPermissionsInFlight.delete(requestId);
      if (requestId) this.#providerRejectedPermissions.add(requestId);
      if (pending && this.#pendingRuntimeRequests.delete(requestId))
        this.#emit(
          "runtime_request.cancelled",
          harnessRuntimeRequestOutcome(pending.request, {
            reason: "provider_rejected",
          }),
          { turnId, itemId: pending.request.itemId },
        );
      return;
    }
    // A grant (or a reply differing from ours) that Paperclip did not send.
    this.#typedPermissionsInFlight.delete(requestId);
    this.#emit(
      "harness.diagnostic",
      {
        code: "permission_out_of_band_reply",
        adapter: "opencode-server",
        providerRequestId: requestId,
        reply: nativeReply,
      },
      { turnId, ...(requestId ? { itemId: requestId } : {}) },
    );
    if (pending && this.#pendingRuntimeRequests.delete(requestId))
      this.#emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(pending.request, {
          reason: "permission_out_of_band_reply",
        }),
        { turnId, itemId: pending.request.itemId },
      );
    void this.#failTurnClosed(turnId, "permission_out_of_band_reply");
  }

  /** Terminal fail-closed stop: the turn fails now, the provider is aborted. */
  async #failTurnClosed(turnId: string, code: string): Promise<void> {
    if (this.#activeTurnId === turnId) {
      this.#invalidateTypedPermissions(code, null);
      for (const [id, entry] of this.#pendingRuntimeRequests) {
        this.#pendingRuntimeRequests.delete(id);
        this.#emit(
          "runtime_request.cancelled",
          harnessRuntimeRequestOutcome(entry.request, { reason: code }),
          { turnId: entry.request.turnId, itemId: entry.request.itemId },
        );
      }
      this.#activeTurnId = null;
      this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
      this.#emit(
        "turn.failed",
        { status: "failed", error: { code, message: code } },
        { turnId },
      );
      this.#events.close();
    }
    await api(
      this.#fetch,
      this.#runtime,
      `/session/${encodeURIComponent(this.#providerSessionId)}/abort`,
      { method: "POST" },
    ).catch(() => undefined);
  }

  async #pumpEvents(): Promise<void> {
    let attempts = 0;
    while (!this.#closed && !this.#abort.signal.aborted) {
      try {
        const response = await this.#fetch(`${this.#runtime.baseUrl}/event`, {
          headers: {
            Authorization: this.#runtime.authHeader,
            Accept: "text/event-stream",
          },
          signal: this.#abort.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(
            `OpenCode event stream returned HTTP ${response.status}`,
          );
        const outboundFrameId = this.#runtime.trace?.frame({
          direction: "client_to_provider",
          raw: "",
          transport: "http_sse",
          nativeMethod: "GET /event",
        });
        if (outboundFrameId) {
          this.#runtime.trace?.interpretation({
            frameId: outboundFrameId,
            stage: "typescript_opencode_http_transport",
            ruleId: "opencode.http.GET_event",
            disposition: "operator_only",
            reason: "Opened the OpenCode server-sent event stream",
          });
        }
        for await (const frame of parseSseFrames(response.body)) {
          if (this.#closed) return;
          const frameId =
            this.#runtime.trace?.frame({
              direction: "provider_to_client",
              raw: frame.raw,
              transport: "http_sse",
              nativeMethod: "SSE /event",
            }) ?? null;
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
            if (frameId) {
              this.#runtime.trace?.interpretation({
                frameId,
                stage: "typescript_opencode_sse_parse",
                ruleId: "opencode.sse.json",
                disposition: "mapped",
                fieldMappings: [
                  {
                    inputPath: "$raw.data",
                    outputPath: "$providerEvent",
                    action: "normalized",
                    reason:
                      "Decoded the exact SSE data payload as an OpenCode event",
                  },
                ],
                reason: "OpenCode SSE frame parsed as JSON",
              });
            }
          } catch (error) {
            if (frameId) {
              this.#runtime.trace?.interpretation({
                frameId,
                stage: "typescript_opencode_sse_parse",
                ruleId: "opencode.sse.invalid_json",
                disposition: "rejected",
                reason: `OpenCode SSE data was not valid JSON: ${String(error).slice(0, 400)}`,
              });
            }
            throw error;
          }
          this.#mapProviderEvent(event, frameId);
        }
        throw new Error(
          "OpenCode event stream closed before the session became terminal",
        );
      } catch (error) {
        if (this.#closed || this.#abort.signal.aborted) return;
        if (this.#runtime.permissionProfile === "restricted_v1") {
          // TAX-470 H3: events (replies, aborts, new asks) may have been lost
          // in the gap. Never keep an approval alive across it: invalidate
          // every pending permission and fail the turn for reconciliation.
          this.#invalidateTypedPermissions(
            "permission_invalidated_sse_lost",
            "permission_invalidated_sse_lost",
          );
          const turnId = this.#activeTurnId;
          if (turnId !== null) {
            this.#emit(
              "harness.diagnostic",
              {
                code: "opencode_sse_lost",
                adapter: "opencode-server",
                message: redact(String(error), this.#runtime.sensitiveValues),
              },
              { turnId },
            );
            await this.#failTurnClosed(turnId, "opencode_sse_lost");
          }
        }
        attempts += 1;
        if (attempts > 3) {
          this.#emit("harness.diagnostic", {
            code: "opencode_sse_failed",
            message: redact(String(error), this.#runtime.sensitiveValues),
          });
          this.#events.fail(error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempts));
      }
    }
  }

  #mapProviderEvent(value: unknown, traceFrameId: number | null = null): void {
    this.#activeTraceFrameId = traceFrameId;
    this.#activeTraceEmittedEventIds = [];
    let rejected: unknown = null;
    try {
      this.#mapProviderEventValue(value);
    } catch (error) {
      rejected = error;
      throw error;
    } finally {
      if (traceFrameId) {
        const providerType = text(record(value).type, "unknown");
        this.#runtime.trace?.interpretation({
          frameId: traceFrameId,
          stage: "typescript_opencode_driver_normalization",
          ruleId: `opencode.normalize.${providerType.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
          disposition: rejected
            ? "rejected"
            : this.#activeTraceEmittedEventIds.length > 0
              ? "mapped"
              : "ignored",
          emittedEventIds: [...this.#activeTraceEmittedEventIds],
          fieldMappings:
            this.#activeTraceEmittedEventIds.length > 0
              ? [
                  {
                    inputPath: "properties",
                    outputPath: "prpEvent.payload",
                    action: "normalized",
                    reason:
                      "Mapped OpenCode event fields into canonical PRP payloads",
                  },
                ]
              : [],
          reason: rejected
            ? `OpenCode event normalization failed: ${String(rejected).slice(0, 400)}`
            : this.#activeTraceEmittedEventIds.length > 0
              ? "OpenCode event emitted one or more canonical PRP events"
              : "OpenCode event was observed but produced no canonical PRP event",
        });
      }
      this.#activeTraceFrameId = null;
      this.#activeTraceEmittedEventIds = [];
    }
  }

  #mapProviderEventValue(value: unknown): void {
    const event = record(value);
    const properties = record(event.properties);
    const type = text(event.type);
    const eventId = text(event.id, canonicalJson(value));
    if (this.#seenProviderEvents.has(eventId)) return;
    this.#seenProviderEvents.add(eventId);
    if (this.#seenProviderEvents.size > 10_000)
      this.#seenProviderEvents.delete(
        this.#seenProviderEvents.values().next().value!,
      );
    const sessionId = text(
      properties.sessionID,
      text(record(properties.info).sessionID),
    );
    if (sessionId && sessionId !== this.#providerSessionId) return;
    const turnId = this.#activeTurnId;
    if (type === "question.asked" && turnId) {
      this.#acceptQuestion(properties);
      return;
    }
    if (
      (type === "permission.updated" ||
        type === "permission.asked" ||
        type === "permission.v2.asked") &&
      turnId
    ) {
      this.#acceptPermission(properties, type);
      return;
    }
    if (
      (type === "permission.replied" || type === "permission.v2.replied") &&
      turnId &&
      this.#runtime.permissionProfile === "restricted_v1"
    ) {
      this.#observeRestrictedPermissionReply(properties, turnId);
      return;
    }
    if (
      (type === "permission.replied" || type === "permission.v2.replied") &&
      turnId
    ) {
      const permission = isRecord(properties.permission)
        ? properties.permission
        : isRecord(properties.request)
          ? properties.request
          : properties;
      const requestId = text(
        permission.id,
        text(
          permission.requestID,
          text(permission.requestId, text(permission.permissionID)),
        ),
      );
      const pending = this.#pendingRuntimeRequests.get(requestId);
      if (!pending || pending.request.requestKind !== "permission_approval")
        return;
      this.#pendingRuntimeRequests.delete(requestId);
      const nativeReply = text(
        properties.reply,
        text(
          properties.response,
          text(permission.reply, text(permission.response)),
        ),
      );
      const action =
        pending.submittedAction ??
        (nativeReply === "always" || nativeReply === "always_allow"
          ? "accept_for_session"
          : nativeReply === "once" || nativeReply === "allow"
            ? "accept"
            : "decline");
      this.#emit(
        "runtime_request.resolved",
        harnessRuntimeRequestOutcome(pending.request, { action }),
        {
          turnId,
          itemId: pending.request.itemId,
        },
      );
      return;
    }
    if (
      (type === "question.replied" || type === "question.rejected") &&
      turnId
    ) {
      const requestId = text(
        properties.id,
        text(properties.requestID, text(properties.requestId)),
      );
      const pending = this.#pendingRuntimeRequests.get(requestId);
      if (!pending) return;
      this.#pendingRuntimeRequests.delete(requestId);
      this.#emit(
        type === "question.replied"
          ? "runtime_request.resolved"
          : "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(
          pending.request,
          type === "question.replied"
            ? { action: "submit", response: pending.submittedResponse }
            : { reason: "provider_rejected" },
        ),
        { turnId, itemId: pending.request.itemId },
      );
      return;
    }
    if (type === "message.part.updated" && turnId) {
      const part = record(properties.part);
      const messageId = text(part.messageID, text(part.messageId));
      if (!messageId) return;
      const role = this.#messageRoles.get(messageId);
      if (role === "assistant") this.#emitAssistantPart(part, turnId);
      else if (role === undefined) {
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        if (pending.length < 100) pending.push(part);
        this.#pendingMessageParts.set(messageId, pending);
      }
      return;
    }
    if (type === "message.updated" && turnId) {
      const info = record(properties.info);
      const messageId = text(
        info.id,
        text(info.messageID, text(info.messageId)),
      );
      const role = text(info.role);
      if (messageId && role) {
        this.#messageRoles.set(messageId, role);
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        this.#pendingMessageParts.delete(messageId);
        if (role === "assistant")
          for (const part of pending) this.#emitAssistantPart(part, turnId);
      }
      const tokens = record(info.tokens);
      if (
        role === "assistant" &&
        (Object.keys(tokens).length > 0 || typeof info.cost === "number")
      ) {
        this.#usage = bounded({
          ...tokens,
          costUsd: info.cost ?? null,
          model: this.#model,
          provider: this.#model.split("/", 1)[0],
          driverVersion: this.#runtime.version,
        });
        const usageFingerprint = canonicalJson(this.#usage);
        const hasMeaningfulUsage =
          hasPositiveNumber(tokens) ||
          (typeof info.cost === "number" && info.cost > 0);
        if (
          hasMeaningfulUsage &&
          this.#messageUsageFingerprints.get(messageId) !== usageFingerprint
        ) {
          this.#messageUsageFingerprints.set(messageId, usageFingerprint);
          this.#emit(
            "item.completed",
            { kind: "usage", usage: this.#usage, usageMessageId: messageId },
            { turnId, itemId: `${turnId}:usage` },
          );
        }
      }
      return;
    }
    if (
      (type === "session.idle" ||
        (type === "session.status" &&
          text(record(properties.status).type) === "idle")) &&
      turnId
    ) {
      const fingerprint = canonicalJson({
        status: "completed",
        semanticResult: this.#resultFingerprint,
      });
      this.#invalidateTypedPermissions("turn_completed", null);
      this.#terminalTurns.set(turnId, fingerprint);
      this.#emitSettledFinalAgentMessage(turnId);
      const workspace = this.#workspaceChangesByTurn.get(turnId);
      if (workspace !== undefined)
        this.#emit(
          "workspace.diff.recorded",
          { ...workspace, complete: true },
          { turnId, itemId: `${turnId}:workspace` },
        );
      this.#activeTurnId = null;
      this.#emit("turn.completed", { status: "completed" }, { turnId });
      this.#events.close();
      return;
    }
    if (type === "session.error" && turnId) {
      const providerError = record(properties.error);
      const providerErrorData = record(providerError.data);
      if (
        text(providerError.name) === "MessageAbortedError" &&
        text(providerErrorData.message, text(providerError.message)) ===
          "Aborted"
      ) {
        // OpenCode reports its normal /abort control path as session.error. That
        // endpoint is also how Paperclip parks a provider turn after a durable
        // governed interaction is created, so presenting it as a provider
        // failure produces a false red error immediately above a healthy wait
        // card. Preserve the provider fact as a cancelled terminal event; the
        // native session loop independently commits the authoritative yielded
        // result when this abort followed a governed wait.
        this.#invalidateTypedPermissions("turn_cancelled", null);
        this.#terminalTurns.set(turnId, canonicalJson({ status: "cancelled" }));
        this.#activeTurnId = null;
        this.#emit(
          "turn.cancelled",
          {
            status: "cancelled",
            error: bounded(properties.error ?? properties),
          },
          { turnId },
        );
        this.#events.close();
        return;
      }
      this.#emit(
        "provider.notice.recorded",
        {
          schema: "paperclip.provider.notice.v1",
          noticeId: `${turnId}:session-error`,
          severity: "error",
          category: "session_error",
          scope: "turn",
          recoverable: false,
          userActionable: true,
          summary: redact(
            text(record(properties.error).message, "OpenCode session failed."),
            this.#runtime.sensitiveValues,
          ).slice(0, 4000),
        },
        { turnId, itemId: `${turnId}:session-error` },
      );
      this.#invalidateTypedPermissions("turn_failed", null);
      this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
      this.#activeTurnId = null;
      this.#emit(
        "turn.failed",
        { status: "failed", error: bounded(properties.error ?? properties) },
        { turnId },
      );
      this.#events.close();
    }
  }

  #emitAssistantPart(part: Record<string, unknown>, turnId: string): void {
    const partId = text(part.id, `${turnId}:part`);
    const partType = text(part.type, "unknown");
    const messageId = text(part.messageID, text(part.messageId)) || null;
    const canonicalToolName = canonicalOpenCodeMcpToolName(
      canonicalOpenCodeDisplayToolName(
        text(part.tool, text(part.name)),
        text(part.callID, text(part.callId)),
      ),
    );
    if (
      ["tool", "tool-call", "tool_call"].includes(partType) &&
      [PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME].includes(
        canonicalToolName as typeof PRP_COMPLETION_TOOL_NAME,
      ) &&
      messageId
    ) {
      // OpenCode may report the terminal MCP call before it marks the text
      // part from the same assistant message complete. Correlating by native
      // message identity selects that response while excluding both earlier
      // commentary messages and later acknowledgement-only messages.
      this.#semanticResultProviderMessageId = messageId;
    }
    for (const canonical of canonicalProviderEventsFromOpenCodePart(part)) {
      this.#emit(canonical.eventType, canonical.payload, {
        turnId,
        itemId: canonical.itemId,
      });
    }
    if (
      ["tool", "tool-call", "tool_call"].includes(partType) &&
      ![PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME].includes(
        canonicalToolName as typeof PRP_COMPLETION_TOOL_NAME,
      )
    ) {
      this.#lastNonTerminalToolSourceSeq = this.#sourceSequence;
    }
    if (partType === "patch") {
      const paths = Array.isArray(part.files) ? part.files : [];
      const files = paths
        .slice(0, 2_000)
        .flatMap((value): Record<string, unknown>[] => {
          const path = text(value).replaceAll("\\", "/");
          if (!path || path.startsWith("/") || path.split("/").includes(".."))
            return [];
          return [
            {
              path,
              operation: "modify",
              previousPath: null,
              additions: null,
              deletions: null,
              binary: false,
              diff: null,
            },
          ];
        });
      if (files.length > 0) {
        const previous = this.#workspaceChangesByTurn.get(turnId);
        const payload = {
          schema: "paperclip.workspace.diff.v1",
          changeSetId: `${turnId}:workspace`,
          revision: Number(record(previous).revision ?? 0) + 1,
          source: "harness_reported",
          complete: false,
          files,
          totals: { files: files.length, additions: null, deletions: null },
          patchArtifactRef: null,
        };
        this.#workspaceChangesByTurn.set(turnId, payload);
        this.#emit("workspace.change.updated", payload, {
          turnId,
          itemId: `${turnId}:workspace`,
        });
      }
    }
    const content = text(part.text, text(part.output));
    const previous = this.#partText.get(partId) ?? "";
    this.#partText.set(partId, content);
    if (partType === "text" && content.length > 0) {
      for (const reference of paperclipWorkspaceFileReferencesFromText(
        this.#workingDirectory,
        content,
        turnId,
      )) {
        if (this.#emittedFileReferences.has(reference.referenceId)) continue;
        this.#emittedFileReferences.add(reference.referenceId);
        this.#emit(
          "workspace.file.referenced",
          { ...reference },
          { turnId, itemId: reference.referenceId },
        );
      }
    }
    const delta = content.startsWith(previous)
      ? content.slice(previous.length)
      : content;
    if (delta) {
      // OpenCode calls assistant prose a `text` part, but `text` is not a PRP
      // item identity and is consequently ignored by the task projection.
      // Until settlement selects one completed part as the final response,
      // every assistant text update is canonical progress/commentary.
      const assistantDelta = partType === "text";
      const reasoningDelta = partType === "reasoning";
      this.#emit(
        "item.delta",
        {
          kind: assistantDelta
            ? "agentMessage"
            : reasoningDelta
              ? "reasoning"
              : partType,
          ...(assistantDelta
            ? { channel: "progress", providerPhase: "commentary" }
            : reasoningDelta
              ? { channel: "detail", providerPhase: "reasoning" }
              : {}),
          text: delta,
          item: bounded(
            assistantDelta
              ? {
                  ...part,
                  type: "agentMessage",
                  channel: "progress",
                  phase: "commentary",
                  text: delta,
                }
              : reasoningDelta
                ? {
                    ...part,
                    type: "reasoning",
                    channel: "detail",
                    phase: "reasoning",
                    text: delta,
                  }
                : part,
          ),
        },
        { turnId, itemId: partId },
      );
    }
    const completedAt = record(part.time).end;
    if (
      partType === "reasoning" &&
      content.trim().length > 0 &&
      Number.isFinite(completedAt) &&
      !this.#completedReasoningPartIds.has(partId)
    ) {
      this.#completedReasoningPartIds.add(partId);
      this.#emit(
        "item.completed",
        {
          kind: "reasoning",
          channel: "detail",
          providerPhase: "reasoning",
          text: content,
          item: bounded({
            ...part,
            type: "reasoning",
            channel: "detail",
            phase: "reasoning",
            text: content,
          }),
        },
        { turnId, itemId: partId },
      );
    }
    if (
      partType === "text" &&
      content.trim().length > 0 &&
      Number.isFinite(completedAt) &&
      !this.#completedTextPartIds.has(partId)
    ) {
      this.#completedTextPartIds.add(partId);
      this.#completedTextParts.push({
        partId,
        messageId,
        text: content,
        item: bounded({
          ...part,
          type: "agentMessage",
          phase: "final_answer",
          text: content,
        }),
        observedSourceSeq: this.#sourceSequence,
      });
    }
  }

  #emitSettledFinalAgentMessage(turnId: string): void {
    // OpenCode labels every assistant text part as plain `text`; unlike Codex,
    // it does not provide commentary/final-answer channels. A single native
    // assistant message can therefore contain an opening progress note, many
    // work tools, and the terminal MCP call. Do not promote that opening note
    // into the settled response merely because it shares the terminal call's
    // message id. Only text observed after the last non-terminal work tool can
    // be a final response. When no such text exists, emit no final agentMessage
    // and let the accepted semantic summary resolve the durable reply.
    const afterLastWorkTool = (part: { observedSourceSeq: number }) =>
      part.observedSourceSeq > this.#lastNonTerminalToolSourceSeq;
    const eligibleText = this.#completedTextParts.filter(afterLastWorkTool);
    // OpenCode exposes no prose channel, so final selection must use provider
    // structure rather than text length or content. When OpenCode reports the
    // terminal tool part, prefer prose completed afterward in that exact
    // provider message. If that message contains only pre-tool commentary,
    // the first later assistant message is the compatible terminal response.
    // Without a reported tool-message identity, a completed pre-tool message
    // is more authoritative than a later acknowledgement; otherwise the first
    // post-tool message is the only available compatibility fallback.
    const indexed = eligibleText.map((part) => ({
      part,
      index: this.#completedTextParts.indexOf(part),
    }));
    const boundary = this.#semanticResultTextBoundary;
    const beforeResult = indexed.filter(
      ({ index }) => boundary !== null && index < boundary,
    );
    const afterResult = indexed.filter(
      ({ index }) => boundary === null || index >= boundary,
    );
    const correlatedAfterResult =
      this.#semanticResultProviderMessageId === null
        ? []
        : afterResult.filter(
            ({ part }) =>
              part.messageId === this.#semanticResultProviderMessageId,
          );
    const uncorrelatedAfterResult =
      this.#semanticResultProviderMessageId === null
        ? afterResult
        : afterResult.filter(
            ({ part }) =>
              part.messageId !== this.#semanticResultProviderMessageId,
          );
    const selected =
      correlatedAfterResult.at(-1)?.part ??
      (this.#semanticResultProviderMessageId === null
        ? beforeResult.at(-1)?.part
        : uncorrelatedAfterResult[0]?.part) ??
      beforeResult.at(-1)?.part ??
      afterResult[0]?.part ??
      null;
    if (!selected) return;
    this.#emit(
      "item.completed",
      {
        kind: "agentMessage",
        channel: "final",
        providerPhase: "final_answer",
        text: selected.text,
        item: selected.item,
      },
      { turnId, itemId: selected.partId },
    );
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    if (this.#activeTraceFrameId !== null) {
      this.#activeTraceEmittedEventIds.push(event.sourceEventId);
    }
    this.#transcript.push(structuredClone(event));
    this.#events.push(event);
  }
}

async function startRuntime(input: {
  options: OpenCodeServerDriverOptions;
  root: string;
  cwd: string;
  trace: ProviderTraceFileSink | null;
  dispatch: (call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }) => Promise<unknown>;
}): Promise<OpenCodeRuntime> {
  const port = await reservePort();
  const password = randomBytes(32).toString("base64url");
  const username = "paperclip";
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const configHome = join(input.root, "config");
  const dataHome = join(input.root, "data");
  const cacheHome = join(input.root, "cache");
  const stateHome = join(input.root, "state");
  const restricted = input.options.permissionProfile === "restricted_v1";
  await Promise.all([
    mkdir(join(configHome, "opencode"), { recursive: true, mode: 0o700 }),
    mkdir(dataHome, { recursive: true, mode: 0o700 }),
    mkdir(cacheHome, { recursive: true, mode: 0o700 }),
    ...(restricted ? [mkdir(stateHome, { recursive: true, mode: 0o700 })] : []),
  ]);
  // HOME contains a read-only skill snapshot, whose destination must be fresh.
  // Keep OpenCode's XDG data stable for provider-session recovery while giving
  // every launch (including retries and recovery) a new isolated HOME.
  const isolatedHome = await mkdtemp(join(input.root, "home-"));
  await chmod(isolatedHome, 0o700);
  try {
    await materializeNativeRuntimeSkills(
      input.options.runtimeContext ?? null,
      join(isolatedHome, ".claude", "skills"),
    );
  } catch (error) {
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  const bridge = await startOpenCodeMcpBridge({
    tools: input.options.dynamicTools,
    handler: input.dispatch,
  }).catch(async (error) => {
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  });
  const assignedMcp = nativeMcpLaunchBinding(
    input.options.environment ?? process.env,
  );
  input.trace?.addSensitiveValues([
    password,
    authHeader,
    bridge.secret,
    assignedMcp?.token,
    input.options.environment?.OPENROUTER_API_KEY,
  ]);
  const instructionRoot =
    input.options.runtimeContext?.instructions.bundle.rootPath;
  const [modelProvider, ...modelIdParts] = input.options.model.split("/");
  const providerModelId = modelIdParts.join("/");
  const config = restricted
    ? restrictedOpenCodeConfig({
        model: input.options.model,
        llamaCppBaseUrl: input.options.llamaCppBaseUrl,
        bridge,
        assignedMcp,
      })
    : {
    $schema: "https://opencode.ai/config.json",
    model: input.options.model,
    small_model: input.options.model,
    share: "disabled",
    // The configured entry is already composed exactly once into the session
    // system prompt; siblings remain available through the read-only root.
    instructions: [],
    plugin: [],
    // OpenCode's bundled models.dev snapshot can lag behind OpenRouter's live
    // catalog. Bind the already-qualified exact model slug into the built-in
    // provider instead of silently falling back or rejecting a newer model.
    provider: {
      [modelProvider!]: {
        models: {
          [providerModelId]: { name: providerModelId },
        },
      },
    },
    tools: {
      question: true,
    },
    permission: {
      "*": input.options.permissionMode ?? "allow",
      question: "allow",
      "paperclip_*": "allow",
      "mcp__paperclip__*": "allow",
      external_directory: instructionRoot
        ? { "*": "deny", [`${instructionRoot}/**`]: "allow" }
        : "deny",
    },
    mcp: {
      paperclip: {
        type: "remote",
        url: bridge.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${bridge.secret}` },
        timeout: 30_000,
      },
      ...(assignedMcp
        ? {
            [assignedMcp.name]: {
              type: "remote",
              url: assignedMcp.url,
              enabled: true,
              oauth: false,
              headers: { Authorization: `Bearer ${assignedMcp.token}` },
              timeout: 30_000,
            },
          }
        : {}),
    },
  };
  await writeFile(
    join(configHome, "opencode", "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  const environment = restricted
    ? restrictedEnvironment(input.options.environment ?? process.env, {
        HOME: isolatedHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      })
    : sanitizedEnvironment(input.options.environment ?? process.env, {
        HOME: isolatedHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      });
  const isolateProcessGroup = input.options.isolateProcessGroup ?? true;
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "ignore", "pipe"];
  if (input.options.commandFd !== undefined) {
    while (stdio.length <= input.options.commandFd) stdio.push("ignore");
    stdio[input.options.commandFd] = input.options.commandFd;
  }
  input.options.commandLifecycle?.beforeSpawn();
  const child = spawn(
    input.options.command ?? "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: input.cwd,
      env: environment,
      stdio,
      detached: globalThis.process.platform !== "win32" && isolateProcessGroup,
    },
  );
  if (child.pid !== undefined) {
    try {
      input.options.commandLifecycle?.afterSpawn();
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const redactedDiagnostic = redact(raw.toString("utf8"), [
      password,
      input.options.environment?.OPENROUTER_API_KEY,
    ]);
    diagnostics = `${diagnostics}${redactedDiagnostic}`.slice(-8_192);
    const frameId = input.trace?.frame({
      direction: "provider_stderr",
      raw,
      transport: "process_stderr",
      nativeMethod: "opencode serve stderr",
    });
    if (frameId) {
      input.trace?.interpretation({
        frameId,
        stage: "typescript_opencode_process_transport",
        ruleId: "opencode.stderr",
        disposition: "operator_only",
        reason:
          "OpenCode stderr is retained only in the restricted trace sidecar",
      });
    }
    input.options.onDiagnostic?.(redactedDiagnostic);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid)
      await input.options.onSpawn?.({
        pid: child.pid,
        processGroupId:
          globalThis.process.platform === "win32" || !isolateProcessGroup
            ? null
            : child.pid,
        startedAt: new Date().toISOString(),
      });
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(
      baseUrl,
      authHeader,
      input.options.fetch ?? globalThis.fetch,
      child,
      () => diagnostics,
      input.trace,
    );
    const version = text(record(health).version);
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error("OpenCode health response omitted a semantic version");
    const qualifiedComparison = compareVersion(
      version,
      QUALIFIED_OPENCODE_VERSION,
    );
    if (qualifiedComparison !== 0) {
      throw new Error(
        `OpenCode ${version} is not the question-conformance-qualified ${QUALIFIED_OPENCODE_VERSION}`,
      );
    }
    return {
      baseUrl,
      authHeader,
      version,
      permissionMode: restricted
        ? "ask"
        : (input.options.permissionMode ?? "allow"),
      permissionProfile: restricted ? "restricted_v1" : null,
      process: child,
      bridge,
      trace: input.trace,
      sensitiveValues: [
        password,
        input.options.environment?.OPENROUTER_API_KEY,
      ].filter((value): value is string => Boolean(value)),
      close: async (closeInput = {}) => {
        await bridge.close().catch(() => {});
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            if (globalThis.process.platform === "win32" || !isolateProcessGroup)
              child.kill("SIGTERM");
            else globalThis.process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        await waitForExit(child, 2_000);
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            if (globalThis.process.platform === "win32" || !isolateProcessGroup)
              child.kill("SIGKILL");
            else globalThis.process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        await rm(join(configHome, "opencode", "opencode.json"), {
          force: true,
        }).catch(() => undefined);
        await rm(isolatedHome, { recursive: true, force: true }).catch(
          () => undefined,
        );
        if (closeInput.finalizeTrace !== false) {
          await input.trace?.finish({ reason: closeInput.reason ?? null });
        }
      },
    };
  } catch (error) {
    await bridge.close().catch(() => {});
    child.kill("SIGKILL");
    await rm(join(configHome, "opencode", "opencode.json"), {
      force: true,
    }).catch(() => undefined);
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export function normalizeOpenCodeQuestionSet(
  nativeQuestions: Record<string, unknown>[],
  metadata: Record<string, unknown> = {},
): PaperclipQuestionSet {
  const questions = nativeQuestions.map(
    (question, index): PaperclipQuestion => {
      const options = (Array.isArray(question.options) ? question.options : [])
        .map(record)
        .slice(0, 128)
        .map((option, optionIndex) => ({
          id: text(option.id, `option-${optionIndex + 1}`).slice(0, 160),
          label: text(
            option.label,
            text(option.value, `Option ${optionIndex + 1}`),
          ).slice(0, 1_000),
          ...(text(option.description)
            ? { description: text(option.description).slice(0, 4_000) }
            : {}),
        }));
      return {
        id: openCodeQuestionId(question, index),
        ...(text(question.header)
          ? { header: text(question.header).slice(0, 1_000) }
          : {}),
        prompt: text(
          question.question,
          text(question.prompt, `Question ${index + 1}`),
        ).slice(0, 4_000),
        ...(text(question.description)
          ? { helpText: text(question.description).slice(0, 4_000) }
          : {}),
        required: question.required === true,
        answerMode:
          options.length === 0
            ? "text"
            : question.multiple === true
              ? "multi_select"
              : "single_select",
        ...(options.length > 0 ? { options } : {}),
        ...(question.custom === true || question.allowCustom === true
          ? {
              customAnswer: {
                enabled: true,
                label: "Other",
                placeholder: "Enter another answer",
              },
            }
          : {}),
      };
    },
  );
  return parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: text(metadata.title, "OpenCode needs your input").slice(0, 1_000),
    ...(text(metadata.description)
      ? { description: text(metadata.description).slice(0, 4_000) }
      : {}),
    submitLabel: text(metadata.submitLabel, "Submit answers").slice(0, 200),
    questions,
  });
}

function openCodeAnswers(
  pending: {
    request: HarnessRuntimeRequest;
    nativeQuestions: Record<string, unknown>[];
  },
  response: PaperclipQuestionResponse,
): string[][] {
  return pending.nativeQuestions.map((nativeQuestion, index) => {
    const questionId = openCodeQuestionId(nativeQuestion, index);
    const question = pending.request.input?.questions.find(
      (candidate) => candidate.id === questionId,
    );
    const answer = response.answers[questionId];
    if (!question || !answer) return [];
    const values = (answer.selectedOptionIds ?? [])
      .map(
        (optionId) =>
          question.options?.find((option) => option.id === optionId)?.label,
      )
      .filter((value): value is string => typeof value === "string");
    if (answer.text !== undefined) values.push(answer.text);
    if (answer.customText !== undefined) values.push(answer.customText);
    return values;
  });
}

function openCodeQuestionId(
  question: Record<string, unknown>,
  index: number,
): string {
  const nativeId = text(question.id).trim();
  if (nativeId) return nativeId.slice(0, 160);
  const header = text(question.header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return header || `question-${index + 1}`;
}

async function api(
  fetcher: typeof globalThis.fetch,
  runtime: OpenCodeRuntime,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  const method = String(init.method ?? "GET").toUpperCase();
  const requestRaw =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? init.body
        : "";
  const requestFrameId = runtime.trace?.frame({
    direction: "client_to_provider",
    raw: requestRaw,
    transport: "http_json",
    nativeMethod: `${method} ${path}`,
  });
  if (requestFrameId) {
    runtime.trace?.interpretation({
      frameId: requestFrameId,
      stage: "typescript_opencode_http_transport",
      ruleId: `opencode.http.${method}.${safeTraceRulePath(path)}`,
      disposition: "operator_only",
      reason: "Sent an exact HTTP request body to the OpenCode app server",
    });
  }
  let response: Response;
  try {
    response = await fetcher(`${runtime.baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: runtime.authHeader,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new Error(
      `OpenCode API ${path} request failed: ${redact(String(error), runtime.sensitiveValues)}`,
    );
  }
  const responseRaw = await response.text();
  const responseFrameId = runtime.trace?.frame({
    direction: "provider_to_client",
    raw: responseRaw,
    transport: "http_json",
    nativeMethod: `${method} ${path} ${response.status}`,
  });
  if (!response.ok) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: `opencode.http.error.${response.status}`,
        disposition: "rejected",
        reason: `OpenCode API returned HTTP ${response.status}`,
      });
    }
    throw new Error(
      `OpenCode API ${path} returned HTTP ${response.status}: ${redact(responseRaw, runtime.sensitiveValues)}`,
    );
  }
  if (response.status === 204 || !responseRaw) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.empty_success",
        disposition: "operator_only",
        reason: "OpenCode API returned a successful empty response",
      });
    }
    return null;
  }
  try {
    const parsed = JSON.parse(responseRaw) as unknown;
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.json_success",
        disposition: "operator_only",
        fieldMappings: [
          {
            inputPath: "$raw",
            outputPath: "$response",
            action: "normalized",
            reason: "Decoded the exact OpenCode HTTP response body as JSON",
          },
        ],
        reason: "OpenCode HTTP response parsed as JSON",
      });
    }
    return parsed;
  } catch (error) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.invalid_json",
        disposition: "rejected",
        reason: `OpenCode response was not valid JSON: ${String(error).slice(0, 400)}`,
      });
    }
    throw error;
  }
}

function retryableOpenCodeStartupError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("request failed") ||
    message.includes("did not become healthy") ||
    message.includes("exited during startup") ||
    message.includes("provider_initialize_timeout") ||
    message.includes("provider_process_exited") ||
    message.includes("HTTP 408") ||
    message.includes("HTTP 425") ||
    message.includes("HTTP 429") ||
    /HTTP 5\d\d/.test(message)
  );
}

async function waitForHealth(
  baseUrl: string,
  authHeader: string,
  fetcher: typeof globalThis.fetch,
  process: ChildProcess,
  diagnostics: () => string,
  trace: ProviderTraceFileSink | null,
): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      const detail = redact(diagnostics());
      throw new Error(
        `provider_process_exited: provider=opencode stage=health exitCode=${process.exitCode ?? "null"} signal=${process.signalCode ?? "null"}${detail ? ` stderrTail=${detail}` : ""}`,
      );
    }
    try {
      const requestFrameId = trace?.frame({
        direction: "client_to_provider",
        raw: "",
        transport: "http_json",
        nativeMethod: "GET /global/health",
      });
      if (requestFrameId) {
        trace?.interpretation({
          frameId: requestFrameId,
          stage: "typescript_opencode_http_transport",
          ruleId: "opencode.http.GET_global_health",
          disposition: "operator_only",
          reason: "Probed the local OpenCode app-server health endpoint",
        });
      }
      const response = await fetcher(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(1_000),
      });
      const raw = await response.text();
      const responseFrameId = trace?.frame({
        direction: "provider_to_client",
        raw,
        transport: "http_json",
        nativeMethod: `GET /global/health ${response.status}`,
      });
      if (response.ok) {
        const parsed = JSON.parse(raw) as unknown;
        if (responseFrameId) {
          trace?.interpretation({
            frameId: responseFrameId,
            stage: "typescript_opencode_http_parse",
            ruleId: "opencode.http.health_success",
            disposition: "operator_only",
            reason: "OpenCode health response parsed successfully",
          });
        }
        return parsed;
      }
    } catch {
      /* server is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = redact(diagnostics());
  throw new Error(
    `provider_initialize_timeout: provider=opencode stage=health${detail ? ` stderrTail=${detail}` : ""}`,
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to reserve OpenCode port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ raw: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576)
      throw new Error("OpenCode SSE event exceeded the retained payload limit");
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const rawFrame = buffer.slice(0, boundary.index);
      const raw = buffer.slice(0, boundary.index + boundary[0].length);
      const frame = rawFrame.replaceAll("\r", "");
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      yield { raw, data };
    }
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  for await (const frame of parseSseFrames(stream))
    yield JSON.parse(frame.data);
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENROUTER_API_KEY",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed)
    if (source[key] !== undefined) result[key] = source[key];
  return { ...result, ...overrides };
}

function sanitizedEnvironmentKeys(): string[] {
  return [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENROUTER_API_KEY",
  ];
}

/**
 * TAX-452 restricted_v1: only locale/PATH survive from the ambient
 * environment. No proxies, TLS overrides, or provider API keys reach OpenCode
 * or anything it spawns; every writable XDG/HOME root lives in the session
 * root. The OPENCODE_DISABLE_* names were verified in the 1.18.29 binary.
 */
const RESTRICTED_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

const RESTRICTED_OPENCODE_FLAGS = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
} as const;

function restrictedEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of RESTRICTED_ENVIRONMENT_KEYS)
    if (source[key] !== undefined) result[key] = source[key];
  return { ...result, ...RESTRICTED_OPENCODE_FLAGS, ...overrides };
}

/**
 * Paperclip MCP bridge inventory (server/src/services/native-runtime/
 * paperclip-runner-tool-authority.ts IMPLEMENTED_OPERATIONS plus the runner's
 * terminal tools in mcp-bridge.ts). OpenCode names bridge tools
 * `paperclip_<operation>`; `mcp__paperclip__<operation>` is kept as the alias
 * form the legacy config also covers.
 *
 * Read-only (allowed): get_task_context, get_task_history, search_tasks,
 *   list_documents, read_document, list_document_revisions, list_agents,
 *   get_agent, list_approvals, get_approval, get_approval_context,
 *   list_projects, list_project_repositories, search_api (catalog search).
 * Terminal result protocol (allowed; proposes a governed result, no side
 *   effect by itself): paperclip_finish, paperclip_block.
 * Mutating or open-ended (denied via the paperclip_* deny): call_api,
 *   report_progress, request_human_input, create_task, set_dependencies,
 *   create_project, register_deliverable, write_document, and any tool not
 *   listed here (unknown future tools fail closed).
 */
export const RESTRICTED_READ_ONLY_PAPERCLIP_TOOLS = [
  "get_task_context",
  "get_task_history",
  "search_tasks",
  "list_documents",
  "read_document",
  "list_document_revisions",
  "list_agents",
  "get_agent",
  "list_approvals",
  "get_approval",
  "get_approval_context",
  "list_projects",
  "list_project_repositories",
  "search_api",
] as const;

const RESTRICTED_TERMINAL_PAPERCLIP_TOOLS = [
  PRP_COMPLETION_TOOL_NAME,
  PRP_BLOCK_TOOL_NAME,
] as const;

const RESTRICTED_DENIED_NATIVE_TOOLS = [
  "bash",
  "webfetch",
  "websearch",
  "task",
] as const;

function restrictedPermissionRules(): Record<string, string> {
  // OpenCode evaluates the last matching rule, so the blanket ask and the
  // paperclip denies precede the explicit read-only allows. "*" is never allow.
  const rules: Record<string, string> = {
    "*": "ask",
    "paperclip_*": "deny",
    "mcp__paperclip__*": "deny",
  };
  for (const tool of [
    ...RESTRICTED_READ_ONLY_PAPERCLIP_TOOLS,
    ...RESTRICTED_TERMINAL_PAPERCLIP_TOOLS,
  ]) {
    rules[`paperclip_${tool}`] = "allow";
    rules[`mcp__paperclip__${tool}`] = "allow";
  }
  rules.question = "allow";
  rules.external_directory = "deny";
  // TAX-470 H4: no tool that can spawn a process, reach the network, or start
  // a subagent. A shell could read /proc/<opencode pid>/environ or the private
  // config regardless of workspace checks (same OS uid).
  for (const tool of RESTRICTED_DENIED_NATIVE_TOOLS) rules[tool] = "deny";
  return rules;
}

function restrictedLlamaCppModelId(model: string): string {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : "";
  if (provider !== "llamacpp" || !id.trim())
    throw new Error(
      "OpenCode restricted_v1 requires a llamacpp/<model> model",
    );
  return id;
}

function validateLoopbackLlamaCppBaseUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("OpenCode restricted_v1 requires a llamaCppBaseUrl");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      "OpenCode restricted_v1 llamaCppBaseUrl must be an http loopback URL",
    );
  return url.toString().replace(/\/$/, "");
}

function restrictedOpenCodeConfig(input: {
  model: string;
  llamaCppBaseUrl: string | undefined;
  bridge: OpenCodeMcpBridge;
  assignedMcp: ReturnType<typeof nativeMcpLaunchBinding>;
}): Record<string, unknown> {
  const modelId = restrictedLlamaCppModelId(input.model);
  const baseURL = validateLoopbackLlamaCppBaseUrl(input.llamaCppBaseUrl);
  const model = `llamacpp/${modelId}`;
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    share: "disabled",
    autoupdate: false,
    instructions: [],
    plugin: [],
    enabled_providers: ["llamacpp"],
    provider: {
      llamacpp: {
        npm: "@ai-sdk/openai-compatible",
        name: "llama.cpp",
        options: { baseURL },
        models: { [modelId]: { name: modelId, tool_call: true } },
      },
    },
    tools: { question: true },
    permission: restrictedPermissionRules(),
    mcp: {
      paperclip: {
        type: "remote",
        url: input.bridge.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${input.bridge.secret}` },
        timeout: 30_000,
      },
      ...(input.assignedMcp
        ? {
            [input.assignedMcp.name]: {
              type: "remote",
              url: input.assignedMcp.url,
              enabled: true,
              oauth: false,
              headers: { Authorization: `Bearer ${input.assignedMcp.token}` },
              timeout: 30_000,
            },
          }
        : {}),
    },
  };
}

const PERMISSION_CONTRACT_MAX_BYTES = 64 * 1024;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** sha256 over canonical JSON (recursively sorted keys, compact, UTF-8). */
export function permissionContractSha256(
  unsigned: Record<string, unknown>,
): string {
  const { contractSha256: _ignored, ...rest } = unsigned;
  return sha256Hex(canonicalJson(rest));
}

function jsonClean<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("value is not JSON");
  return JSON.parse(serialized) as T;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    return null;
  return [...(value as string[])];
}

/**
 * TAX-470 H1: every target is frozen as the realpath of its deepest existing
 * ancestor plus the remaining non-existent suffix (dangling symlinks are
 * followed), so a changed ancestor symlink changes the frozen value even when
 * the leaf does not exist yet. Never null.
 */
async function resolvePermissionTargets(
  cwd: string,
  patterns: readonly string[],
): Promise<Array<{ pattern: string; resolvedPath: string }>> {
  return Promise.all(
    patterns.map(async (pattern) => ({
      pattern,
      resolvedPath: await resolveTargetPath(resolve(cwd, pattern)),
    })),
  );
}

const ARGUMENT_PATH_KEYS = ["filePath", "filepath", "file_path", "path"];

/** Paths a native tool actually acts on, resolved like OpenCode (vs cwd). */
async function resolveArgumentTargets(
  cwd: string,
  toolArguments: Record<string, unknown> | null | undefined,
): Promise<string[]> {
  if (!toolArguments) return [];
  const paths = ARGUMENT_PATH_KEYS.map((key) => toolArguments[key]).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return Promise.all(paths.map((path) => resolveTargetPath(resolve(cwd, path))));
}

async function resolveTargetPath(absolute: string, hops = 0): Promise<string> {
  if (hops > 40) throw new Error("permission target has too many symlinks");
  const parsed = parsePath(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index]!);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        return join(next, ...parts.slice(index + 1));
      throw error;
    }
    if (info.isSymbolicLink()) {
      current = await resolveTargetPath(
        resolve(current, await readlink(next)),
        hops + 1,
      );
    } else current = next;
  }
  return current;
}

function isWithin(path: string, root: string): boolean {
  return (
    path === root ||
    path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

function permissionPrompt(
  contract: PaperclipOpenCodePermissionContract,
): string {
  const scope = contract.patterns.length
    ? `: ${contract.patterns.join(", ")}`
    : "";
  return `OpenCode requests ${contract.permission} permission${scope}.`.slice(
    0,
    4000,
  );
}

function sessionRoot(
  runtimeDirectory: string,
  normalizedSessionId: string,
): string {
  const safe = normalizedSessionId
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!safe || safe === "." || safe === "..")
    throw new Error("Invalid normalized OpenCode session id");
  return join(resolve(runtimeDirectory), safe);
}

function validateWorkspace(value: string): string {
  const cwd = resolve(value);
  if (!value.trim() || cwd === dirname(cwd))
    throw new Error("OpenCode working directory must not be a filesystem root");
  return cwd;
}

function validModel(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function bounded(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 64 * 1024)
    return { omitted: true, reason: "payload_limit" };
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) ? parsed : { value: parsed };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
/** TAX-452 H9: the permission or its tool part is outside the allowlist. */
class PermissionUnknownToolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function hasPositiveNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.some(hasPositiveNumber);
  if (isRecord(value)) return Object.values(value).some(hasPositiveNumber);
  return false;
}
function safeTraceRulePath(value: string): string {
  return value
    .replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id")
    .replace(/[^A-Za-z0-9_.:/-]/g, "_")
    .replaceAll("/", "_")
    .slice(0, 120);
}
function redact(
  value: string,
  sensitiveValues: readonly (string | undefined)[] = [],
): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive && sensitive.length >= 4)
      redacted = redacted.split(sensitive).join("[REDACTED]");
  }
  return redacted
    .replace(
      /(OPENROUTER_API_KEY|authorization|password|token|secret)\s*[:=]\s*[^\s,}\]]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 8_192);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

async function waitForExit(
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const openCodeServerDriverInternals = { parseSse };

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown = null;
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter.resolve({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined)
          return Promise.resolve({ done: false, value: item });
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
      },
    };
  }
}
