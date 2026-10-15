import { execFileSync } from "node:child_process";
import {
  chmod,
  symlink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../../contracts/runtime-context.js";
import { localIntegrityBoundaryGolden } from "../../../test-support/local-integrity-boundary-golden.js";
import {
  OpenCodeServerDriver,
  openCodeServerDriverInternals,
} from "./opencode-server-driver.js";

const roots: string[] = [];
const fixture = resolve("test/fixtures/fake-opencode-server.mjs");

function runtimeContext(
  skillRoot: string,
  instructionRoot: string,
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    },
    skills: [
      {
        key: "company/assigned",
        runtimeName: "assigned",
        versionId: "version-1",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: skillRoot,
          fileCount: 2,
          totalBytes: 2,
        },
      },
    ],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return {
    ...value,
    aggregateDigest: canonicalNativeRuntimeContextDigest(value),
  };
}

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root))
      await makeWritable(join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

afterAll(async () => {
  await chmod(fixture, 0o644);
});

describe("OpenCodeServerDriver", () => {
  it("advertises within-turn plans as unsupported", async () => {
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: "/tmp/paperclip-opencode-capabilities",
      command: fixture,
    });
    const descriptor = await driver.descriptor();
    expect(
      descriptor.capabilities.typedEventFamilies.find(
        (family) => family.family === "plan",
      ),
    ).toMatchObject({ availability: "unsupported" });
  });

  it("normalizes raw OpenCode boundary events into the local-integrity golden identities", async () => {
    await chmod(fixture, 0o755);
    const profile = localIntegrityBoundaryGolden.profiles.find(
      (candidate) => candidate.id === "runner-opencode",
    );
    if (!profile) throw new Error("missing runner-opencode golden profile");
    const goldenEvent = (sourceEventId: string) => {
      const event = localIntegrityBoundaryGolden.events.find(
        (candidate) => candidate.sourceEventId === sourceEventId,
      );
      if (!event) throw new Error(`missing golden event ${sourceEventId}`);
      return event;
    };
    const progress = localIntegrityBoundaryGolden.expected.assistantItems.find(
      (item) => item.channel === "progress",
    );
    const final = localIntegrityBoundaryGolden.expected.assistantItems.find(
      (item) => item.channel === "final",
    );
    if (!progress || !final)
      throw new Error("missing golden assistant messages");

    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-boundary-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-boundary-workspace-"),
    );
    roots.push(root, workspace);
    const tracePath = join(root, "provider-trace.ndjson");
    const providerSessionId = "provider-session-boundary";
    const nativeEvents: Array<Record<string, unknown>> = [];
    const queuedFrames: Uint8Array[] = [];
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let streamClosed = false;
    const emitNative = (event: Record<string, unknown>) => {
      nativeEvents.push(structuredClone(event));
      const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      if (streamController) streamController.enqueue(frame);
      else queuedFrames.push(frame);
    };
    const closeNativeStream = () => {
      streamClosed = true;
      streamController?.close();
    };
    const nativeQuestion = {
      type: "question.asked",
      id: "native-question-created",
      properties: {
        id: localIntegrityBoundaryGolden.expected.questionRequestId,
        sessionID: providerSessionId,
        title: "Boundary mode",
        questions: [
          {
            id: "boundary-mode",
            question: "Which mode should continue?",
            required: true,
            options: [{ id: "lossless", label: "Lossless" }],
          },
        ],
      },
    } satisfies Record<string, unknown>;
    const emitBeforeQuestion = () => {
      emitNative({
        type: "message.updated",
        id: "native-progress-message-role",
        properties: {
          info: {
            id: "provider-message-progress",
            sessionID: providerSessionId,
            role: "assistant",
          },
        },
      });
      emitNative({
        type: "message.part.updated",
        id: "native-progress-part",
        properties: {
          sessionID: providerSessionId,
          part: {
            id: progress.itemId,
            messageID: "provider-message-progress",
            type: "text",
            text: progress.text,
            time: { start: 1, end: 2 },
          },
        },
      });
      emitNative({
        type: "message.part.updated",
        id: "native-reasoning-part",
        properties: {
          sessionID: providerSessionId,
          part: {
            id: localIntegrityBoundaryGolden.expected.reasoningItemId,
            messageID: "provider-message-progress",
            type: "reasoning",
            text: "Verified event identity.",
            time: { start: 2, end: 3 },
          },
        },
      });
      for (const [id, status, state] of [
        ["native-tool-started", "pending", { title: "Inspecting" }],
        ["native-tool-progressed", "running", { title: "Inspecting" }],
        [
          "native-tool-completed",
          "completed",
          { output: "boundary-ok", time: 12, exit: 0 },
        ],
      ] as const) {
        emitNative({
          type: "message.part.updated",
          id,
          properties: {
            sessionID: providerSessionId,
            part: {
              id: localIntegrityBoundaryGolden.expected.toolExecutionId,
              messageID: "provider-message-progress",
              type: "tool",
              tool: "boundary-check",
              state: { status, ...state },
            },
          },
        });
      }
      emitNative(nativeQuestion);
    };
    const emitAfterQuestion = () => {
      emitNative({
        ...nativeQuestion,
        id: "native-question-resolved",
        type: "question.replied",
      });
      emitNative({
        type: "message.updated",
        id: "native-final-message-role",
        properties: {
          info: {
            id: "provider-message-final",
            sessionID: providerSessionId,
            role: "assistant",
          },
        },
      });
      emitNative({
        type: "message.part.updated",
        id: "native-final-part",
        properties: {
          sessionID: providerSessionId,
          part: {
            id: final.itemId,
            messageID: "provider-message-final",
            type: "text",
            text: final.text,
            time: { start: 4, end: 5 },
          },
        },
      });
      emitNative({
        type: "message.updated",
        id: "native-usage",
        properties: {
          info: {
            id: "provider-message-final",
            sessionID: providerSessionId,
            role: "assistant",
            tokens: {
              input: 40,
              output: 12,
              cache: { read: 3, write: 0 },
            },
            cost: 0.02,
          },
        },
      });
      emitNative({
        type: "session.idle",
        id: "native-turn-completed",
        properties: { sessionID: providerSessionId },
      });
      closeNativeStream();
    };
    let submittedQuestionReply: unknown = null;
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/global/health")
        return json({ healthy: true, version: "1.18.29" });
      if (url.pathname === "/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              for (const frame of queuedFrames.splice(0))
                controller.enqueue(frame);
              if (streamClosed) controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (method === "POST" && url.pathname === "/session")
        return json({ id: providerSessionId });
      if (method === "GET" && url.pathname === "/question") return json([]);
      if (method === "GET" && url.pathname === "/permission") return json([]);
      if (
        method === "POST" &&
        url.pathname === `/session/${providerSessionId}/prompt_async`
      ) {
        emitBeforeQuestion();
        return new Response(null, { status: 204 });
      }
      if (
        method === "POST" &&
        url.pathname ===
          `/question/${localIntegrityBoundaryGolden.expected.questionRequestId}/reply`
      ) {
        submittedQuestionReply = JSON.parse(String(init?.body));
        emitAfterQuestion();
        return json(true);
      }
      if (
        method === "POST" &&
        url.pathname === `/session/${providerSessionId}/abort`
      )
        return json(true);
      throw new Error(`unexpected OpenCode boundary request ${method} ${url}`);
    };
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      runnerInstanceId: profile.sourceInstanceId,
      fetch: fetcher,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
        PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      },
    });
    const session = await driver.openSession({
      runId: profile.runId,
      normalizedSessionId: profile.normalizedSessionId,
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "exercise native golden boundary" },
    });
    const events = [];
    const iterator = session.events()[Symbol.asyncIterator]();
    let requestCreated = false;
    while (!requestCreated) {
      const next = await iterator.next();
      if (next.done)
        throw new Error("OpenCode ended before asking its question");
      events.push(next.value);
      requestCreated = next.value.eventType === "runtime_request.created";
    }
    await session.resolveRuntimeRequest?.({
      requestId: localIntegrityBoundaryGolden.expected.questionRequestId,
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            "boundary-mode": { selectedOptionIds: ["lossless"] },
          },
        },
      },
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    await session.close({ reason: "boundary-golden-test" });

    expect(submittedQuestionReply).toEqual({ answers: [["Lossless"]] });
    expect(
      events.every(
        (event) =>
          event.runId === profile.runId &&
          event.normalizedSessionId === profile.normalizedSessionId,
      ),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        itemId: progress.itemId,
        eventType: "item.delta",
        payload: expect.objectContaining({
          kind: "agentMessage",
          channel: progress.channel,
          providerPhase: "commentary",
          text: progress.text,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        itemId: localIntegrityBoundaryGolden.expected.reasoningItemId,
        eventType: "item.completed",
        payload: expect.objectContaining({
          kind: "reasoning",
          channel: "detail",
          providerPhase: "reasoning",
          text: String(goldenEvent("reasoning-completed").payload.text),
        }),
      }),
    );
    expect(
      events
        .filter(
          (event) =>
            event.itemId ===
              localIntegrityBoundaryGolden.expected.toolExecutionId &&
            event.eventType.startsWith("tool.execution."),
        )
        .map((event) => [event.eventType, event.payload.status]),
    ).toEqual([
      ["tool.execution.started", "running"],
      ["tool.execution.progressed", "running"],
      ["tool.execution.completed", "completed"],
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        itemId: localIntegrityBoundaryGolden.expected.questionRequestId,
        eventType: "runtime_request.created",
        payload: {
          request: expect.objectContaining({
            requestId: localIntegrityBoundaryGolden.expected.questionRequestId,
            origin: {
              adapter: profile.adapter,
              provider: profile.originProvider,
              method: profile.originMethod,
            },
            input: expect.objectContaining({
              schema: "paperclip.question_set.v1",
              title: "Boundary mode",
              questions: [
                expect.objectContaining({
                  id: "boundary-mode",
                  answerMode: "single_select",
                }),
              ],
            }),
          }),
        },
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.itemId ===
            localIntegrityBoundaryGolden.expected.questionRequestId &&
          event.eventType === "runtime_request.resolved",
      ),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        itemId: final.itemId,
        eventType: "item.completed",
        payload: expect.objectContaining({
          kind: "agentMessage",
          channel: final.channel,
          providerPhase: "final_answer",
          text: final.text,
        }),
      }),
    );
    expect(
      events.find(
        (event) =>
          event.eventType === "item.completed" &&
          event.payload.kind === "usage",
      ),
    ).toMatchObject({
      itemId: `${turnId}:usage`,
      payload: {
        usageMessageId: "provider-message-final",
        usage: {
          input: 40,
          output: 12,
          cache: { read: 3, write: 0 },
          costUsd: 0.02,
        },
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "turn.completed",
        turnId,
        payload: { status: "completed" },
      }),
    );

    // OpenCode 1.18 does not expose a qualified structured Plan event, and
    // run.terminal is owned by the native-session layer above this driver.
    // Keep both absences explicit instead of synthesizing Codex-shaped input.
    expect(
      (await driver.descriptor()).capabilities.typedEventFamilies.find(
        (family) => family.family === "plan",
      ),
    ).toMatchObject({ availability: "unsupported" });
    expect(events.some((event) => event.eventType === "plan.updated")).toBe(
      false,
    );
    expect(events.some((event) => event.eventType === "run.terminal")).toBe(
      false,
    );

    const traceEntries = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const traceFrames = traceEntries.filter(
      (entry) =>
        entry.kind === "frame" && entry.direction === "provider_to_client",
    );
    const normalization = traceEntries.filter(
      (entry) =>
        entry.kind === "interpretation" &&
        entry.stage === "typescript_opencode_driver_normalization",
    );
    expect(nativeEvents.map((event) => event.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "question.asked",
      "question.replied",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "session.idle",
    ]);
    for (const nativeEvent of nativeEvents) {
      const frame = traceFrames.find((entry) => {
        if (typeof entry.rawBase64 !== "string") return false;
        const raw = Buffer.from(entry.rawBase64, "base64").toString("utf8");
        return raw.includes(`\"id\":\"${String(nativeEvent.id)}\"`);
      });
      expect(frame, String(nativeEvent.id)).toBeDefined();
      const interpretation = normalization.find(
        (entry) => entry.frameId === frame?.frameId,
      );
      expect(interpretation, String(nativeEvent.id)).toMatchObject({
        disposition: expect.stringMatching(/^(mapped|ignored)$/),
      });
      if (interpretation?.disposition === "ignored") {
        expect(
          [
            "native-progress-message-role",
            "native-final-message-role",
            "native-question-resolved",
          ],
          `${String(nativeEvent.id)} must be a structural or duplicate echo`,
        ).toContain(nativeEvent.id);
      }
    }
  });

  it("starts an authenticated isolated server, creates a session, streams usage, aborts, and cleans up", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const tracePath = join(root, "provider-trace.ndjson");
    const spawns: Array<{ pid: number; processGroupId: number | null }> = [];
    const diagnostics: string[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "test-openrouter-key",
        PAPERCLIP_API_KEY: "must-not-leak",
        UNRELATED_SECRET: "must-not-leak",
        PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
        PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
      },
      onSpawn: async (meta) => {
        spawns.push(meta);
      },
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const session = await driver.openSession({
      runId: "run-1",
      normalizedSessionId: "normalized/1",
      workingDirectory: workspace,
    });
    expect(session.ids()).toMatchObject({ providerSessionId: "ses_fake_1" });
    expect(spawns).toHaveLength(1);
    const turn = await session.startTurn({
      message: { role: "user", text: "finish" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toContain("turn.completed");
    expect(events).toContainEqual(
      expect.objectContaining({ eventType: "run.result.proposed" }),
    );
    expect(
      events.filter((event) => event.eventType === "item.delta"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "item.delta")?.payload.text,
    ).toBe("done [guide](guide.md)");
    expect(
      events.find(
        (event) =>
          event.eventType === "item.completed" &&
          event.payload.kind === "agentMessage",
      )?.payload,
    ).toMatchObject({
      channel: "final",
      providerPhase: "final_answer",
      text: "done [guide](guide.md)",
    });
    const usageEvents = events.filter(
      (event) =>
        event.eventType === "item.completed" && event.payload.kind === "usage",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.payload).toMatchObject({
      usageMessageId: expect.any(String),
    });
    expect(
      events.find((event) => event.eventType === "workspace.change.updated")
        ?.payload,
    ).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      source: "harness_reported",
      totals: { files: 1 },
    });
    expect(
      events.find((event) => event.eventType === "workspace.diff.recorded")
        ?.payload,
    ).toMatchObject({ schema: "paperclip.workspace.diff.v1", complete: true });
    expect(
      events.find((event) => event.eventType === "workspace.file.referenced")
        ?.payload,
    ).toMatchObject({
      schema: "paperclip.workspace.file_reference.v1",
      path: "guide.md",
    });
    expect(JSON.stringify(events)).not.toContain(
      "submitted prompt must not become assistant text",
    );
    expect(await session.usage()).toMatchObject({
      input: 3,
      output: 2,
      costUsd: 0.001,
      provider: "openrouter",
      driverVersion: "1.18.29",
    });
    await session.interrupt?.({ turnId: turn.turnId });
    const snapshot = await session.snapshot();
    expect(snapshot.driverKind).toBe("opencode_server");
    const sessionRoot = join(root, "normalized_1");
    expect((await stat(sessionRoot)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(sessionRoot, "config", "opencode", "opencode.json")))
        .mode & 0o777,
    ).toBe(0o600);
    const config = await readFile(
      join(sessionRoot, "config", "opencode", "opencode.json"),
      "utf8",
    );
    await session.close({ reason: "test" });
    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered).toMatchObject({ recovered: true });
    await expect(recovered?.session?.read?.()).resolves.toMatchObject({
      sessionId: "ses_fake_1",
      messages: [],
    });
    await recovered?.session?.close({ reason: "recovery-test" });

    const traceEntries = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(JSON.stringify(traceEntries)).not.toContain("test-openrouter-key");
    const traceFrames = traceEntries.filter((entry) => entry.kind === "frame");
    expect(traceFrames.map((entry) => entry.direction)).toEqual(
      expect.arrayContaining([
        "client_to_provider",
        "provider_to_client",
        "provider_stderr",
      ]),
    );
    expect(
      traceFrames.some((entry) => entry.nativeMethod === "SSE /event"),
    ).toBe(true);
    expect(
      traceEntries.some(
        (entry) =>
          entry.stage === "typescript_opencode_driver_normalization" &&
          Array.isArray(entry.emittedEventIds) &&
          entry.emittedEventIds.length > 0,
      ),
    ).toBe(true);
    expect(traceEntries.at(-1)).toMatchObject({
      kind: "trace_status",
      debugChannel: "typescript_opencode_native",
      status: "complete",
    });

    const environment = JSON.parse(
      await readFile(
        join(sessionRoot, "data", "fake-environment.json"),
        "utf8",
      ),
    );
    const mcpEvidence = JSON.parse(
      await readFile(
        join(sessionRoot, "data", "fake-mcp-evidence.json"),
        "utf8",
      ),
    );
    expect(environment.keys).toContain("OPENROUTER_API_KEY");
    expect(environment.keys).not.toContain("PAPERCLIP_API_KEY");
    expect(environment.keys).not.toContain("UNRELATED_SECRET");
    expect(environment.keys).not.toContain("PAPERCLIP_PROVIDER_TRACE_PATH");
    expect(environment.projectConfigDisabled).toBe("true");
    expect(mcpEvidence.tools).toEqual(
      expect.arrayContaining(["paperclip_finish", "paperclip_block"]),
    );
    expect(config).toContain("openrouter/deepseek/deepseek-v4-flash-0731");
    expect(config).toContain('"*": "allow"');
    expect(config).toContain('"external_directory": "deny"');
    expect(
      events.some((event) => event.eventType === "runtime_request.created"),
    ).toBe(false);
    expect(config).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).not.toContain("test-openrouter-key");
    expect(diagnostics.join("\n")).toContain("[REDACTED]");
  });

  it("maps OpenCode's normal abort error to cancellation without a false provider failure notice", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-abort-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-abort-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-aborted",
      normalizedSessionId: "aborted",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "session-aborted" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.eventType)).toContain("turn.cancelled");
    expect(events.map((event) => event.eventType)).not.toContain("turn.failed");
    expect(events.map((event) => event.eventType)).not.toContain(
      "provider.notice.recorded",
    );
    await session.close({ reason: "test" });
  });

  it("keeps OpenCode in an outer supervisor process group when requested", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    let processGroupId: number | null | undefined;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
      isolateProcessGroup: false,
      onSpawn: async (meta) => {
        processGroupId = meta.processGroupId;
      },
    });
    const session = await driver.openSession({
      runId: "run-supervised",
      normalizedSessionId: "supervised",
      workingDirectory: workspace,
    });
    expect(processGroupId).toBeNull();
    await session.close({ reason: "test" });
  });

  it("uses the native system channel, selected skill tree, instruction root, and assigned MCP gateway", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-context-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-context-workspace-"),
    );
    const skillRoot = join(root, "skill-source");
    const instructionRoot = join(root, "instruction-source");
    roots.push(root, workspace);
    await Promise.all([
      mkdir(join(skillRoot, "references"), { recursive: true }),
      mkdir(instructionRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(skillRoot, "SKILL.md"),
        "# Assigned\nRead references/support.md\n",
      ),
      writeFile(join(skillRoot, "references", "support.md"), "skill support\n"),
      writeFile(join(instructionRoot, "AGENTS.md"), "Read sibling.md\n"),
      writeFile(join(instructionRoot, "sibling.md"), "instruction sibling\n"),
    ]);
    const systemInstructions = `${PAPERCLIP_EXECUTION_PROMPT}\n\nRead sibling.md\n\nRead-only instruction sibling root: ${instructionRoot}`;
    let submittedPrompt: Record<string, unknown> | null = null;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      systemInstructions,
      runtimeContext: runtimeContext(skillRoot, instructionRoot),
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async"))
          submittedPrompt = JSON.parse(String(init?.body));
        return fetch(input, init);
      },
    });
    const session = await driver.openSession({
      runId: "run-context",
      normalizedSessionId: "context",
      workingDirectory: workspace,
    });
    await session.startTurn({ message: { role: "user", text: "finish" } });
    for await (const event of session.events()) {
      if (event.eventType === "turn.completed") break;
    }
    expect(submittedPrompt).toMatchObject({
      system: systemInstructions,
      tools: { question: true },
    });
    expect(JSON.stringify(submittedPrompt?.parts ?? null)).not.toContain(
      PAPERCLIP_EXECUTION_PROMPT,
    );
    const sessionRoot = join(root, "context");
    const isolatedHomes = (await readdir(sessionRoot)).filter((entry) =>
      entry.startsWith("home-"),
    );
    expect(isolatedHomes).toHaveLength(1);
    await expect(
      readFile(
        join(
          sessionRoot,
          isolatedHomes[0]!,
          ".claude",
          "skills",
          "assigned",
          "references",
          "support.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("skill support\n");
    const config = JSON.parse(
      await readFile(
        join(sessionRoot, "config", "opencode", "opencode.json"),
        "utf8",
      ),
    );
    expect(config).toMatchObject({
      instructions: [],
      plugin: [],
      tools: { question: true },
      permission: {
        external_directory: { "*": "deny", [`${instructionRoot}/**`]: "allow" },
      },
      mcp: {
        paperclip: { enabled: true },
        "paperclip-assigned": {
          url: "https://paperclip.example/mcp",
          enabled: true,
        },
      },
    });
    await expect(
      readFile(join(instructionRoot, "sibling.md"), "utf8"),
    ).resolves.toBe("instruction sibling\n");
    await session.close({ reason: "test" });
  });

  it("sends only the authoritative wake envelope when resuming an existing provider session", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-resume-context-"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-resume-workspace-"),
    );
    roots.push(root, workspace);
    let submittedPrompt: Record<string, unknown> | null = null;
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      systemInstructions: "large original system context",
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async"))
          submittedPrompt = JSON.parse(String(init?.body));
        return fetch(input, init);
      },
    });
    const seed = await driver.openSession({
      runId: "run-seed",
      normalizedSessionId: "resume-context",
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "seed complete" });

    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered).toMatchObject({ recovered: true });
    await recovered!.session!.startTurn({
      message: {
        role: "user",
        text: '{"interactionResponses":[{"answer":"friendly"}]}',
      },
    });
    for await (const event of recovered!.session!.events()) {
      if (event.eventType === "turn.completed") break;
    }

    expect(submittedPrompt).toMatchObject({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
      tools: { question: true },
      parts: [
        {
          type: "text",
          text: '{"interactionResponses":[{"answer":"friendly"}]}',
        },
      ],
    });
    expect(submittedPrompt).not.toHaveProperty("system");
    await recovered!.session!.close({ reason: "recovery-test" });
  });

  it("normalizes native question.asked events and replies with ordered OpenCode answer arrays", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-question-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-question-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-native-question",
      normalizedSessionId: "native-question",
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "native-question" },
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    let requestEvent:
      Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
    for (let count = 0; count < 30; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.created") {
        requestEvent = event.value;
        break;
      }
    }
    expect(requestEvent?.payload).toMatchObject({
      request: {
        schema: "paperclip.runtime_request.v2",
        requestKind: "runtime",
        type: "input",
        input: {
          schema: "paperclip.question_set.v1",
          questions: [
            {
              id: "environment",
              answerMode: "single_select",
              required: false,
              customAnswer: { enabled: true },
            },
            { id: "regions", answerMode: "multi_select", required: false },
          ],
        },
      },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    await session.resolveRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { customText: "Canary" },
            regions: { selectedOptionIds: ["option-1", "option-2"] },
          },
        },
      },
    });
    const reply = JSON.parse(
      await readFile(
        join(root, "native-question", "data", "fake-question-reply.json"),
        "utf8",
      ),
    );
    expect(reply).toEqual({
      url: expect.stringContaining(
        `directory=${encodeURIComponent(workspace)}`,
      ),
      body: { answers: [["Canary"], ["US", "EU"]] },
    });
    const terminalQuestionEvents =
      (await session.transcript?.())?.events.filter(
        (event) =>
          event.payload.requestId === "question-native-1" &&
          ["runtime_request.resolved", "runtime_request.cancelled"].includes(
            event.eventType,
          ),
      ) ?? [];
    expect(terminalQuestionEvents).toHaveLength(1);
    expect(terminalQuestionEvents[0]?.payload).toMatchObject({
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { customText: "Canary" },
          regions: { selectedOptionIds: ["option-1", "option-2"] },
        },
      },
    });
    await session.close({ reason: "test" });
  });

  it("hands a native question to the durable interaction path without touching permissions", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-question-handoff-"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-question-handoff-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-native-question-handoff",
      normalizedSessionId: "native-question-handoff",
      workingDirectory: workspace,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "native-question" },
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null =
      null;
    for (let count = 0; count < 30; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.created") {
        created = next.value;
        break;
      }
    }
    expect(created).toMatchObject({
      payload: { request: { requestId: "question-native-1", type: "input" } },
    });

    const firstHandoff = session.handoffRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(firstHandoff?.result).toBe("handed_off");
    await firstHandoff?.cleanup;
    const repeatedHandoff = session.handoffRuntimeRequest?.({
      requestId: "question-native-1",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(repeatedHandoff?.result).toBe("already_settled");
    await repeatedHandoff?.cleanup;

    let expired: Awaited<ReturnType<typeof iterator.next>>["value"] | null =
      null;
    for (let count = 0; count < 20; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.expired") {
        expired = next.value;
        break;
      }
    }
    expect(expired).toMatchObject({
      payload: {
        requestId: "question-native-1",
        reason: "durable_handoff",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestId: "question-native-1",
          type: "input",
        },
      },
    });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    const terminal = (await session.transcript?.())?.events.filter(
      (event) =>
        event.payload.requestId === "question-native-1" &&
        [
          "runtime_request.resolved",
          "runtime_request.cancelled",
          "runtime_request.expired",
        ].includes(event.eventType),
    );
    expect(terminal).toHaveLength(1);
    await session.close({ reason: "handoff test complete" });
  });

  it("recovers a missed pending question from the list endpoint and rejects it", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-question-recovery-"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-question-recovery-workspace-"),
    );
    roots.push(root, workspace);
    const normalizedSessionId = "question-recovery";
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const seed = await driver.openSession({
      runId: "run-question-recovery",
      normalizedSessionId,
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "simulate reconnect" });
    const dataRoot = join(root, normalizedSessionId, "data");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      join(dataRoot, "fake-pending-question.json"),
      JSON.stringify({
        id: "question-native-1",
        sessionID: "ses_fake_1",
        questions: [
          {
            id: "environment",
            header: "Environment",
            question: "Where should we deploy?",
            options: [{ label: "Staging" }, { label: "Production" }],
            custom: true,
          },
        ],
      }),
    );

    const recovered = await driver.recoverSession?.({
      ...snapshot,
      activeTurnId: "turn-recovered-question",
    });
    expect(recovered).toMatchObject({ recovered: true });
    const session = recovered!.session!;
    const iterator = session.events()[Symbol.asyncIterator]();
    let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null =
      null;
    for (let count = 0; count < 20; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.eventType === "runtime_request.created") {
        created = next.value;
        break;
      }
    }
    expect(created).toMatchObject({
      payload: { request: { requestId: "question-native-1", type: "input" } },
    });
    await session.resolveRuntimeRequest?.({
      requestId: "question-native-1",
      turnId: "turn-recovered-question",
      resolution: { action: "decline" },
    });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    await session.close({ reason: "recovery test complete" });
  });

  it.each([
    { style: "legacy", action: "accept" as const, reply: "once" },
    { style: "v2", action: "accept_for_session" as const, reply: "always" },
    { style: "v2", action: "decline" as const, reply: "reject" },
  ])(
    "normalizes $style permission events and maps $action to $reply",
    async ({ style, action, reply }) => {
      await chmod(fixture, 0o755);
      const root = await mkdtemp(
        join(tmpdir(), `paperclip-opencode-permission-${style}-`),
      );
      const workspace = await mkdtemp(
        join(tmpdir(), `paperclip-opencode-permission-${style}-workspace-`),
      );
      roots.push(root, workspace);
      const driver = new OpenCodeServerDriver({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        permissionMode: "ask",
        runtimeDirectory: root,
        command: fixture,
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_API_KEY: "fixture-key",
        },
      });
      const normalizedSessionId = `native-permission-${style}-${action}`;
      const session = await driver.openSession({
        runId: `run-${normalizedSessionId}`,
        normalizedSessionId,
        workingDirectory: workspace,
      });
      const { turnId } = await session.startTurn({
        message: { role: "user", text: `native-permission-${style}` },
      });
      const iterator = session.events()[Symbol.asyncIterator]();
      let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null =
        null;
      for (let count = 0; count < 30; count += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.eventType === "runtime_request.created") {
          created = next.value;
          break;
        }
      }
      expect(created).toMatchObject({
        payload: {
          request: {
            requestId: "permission-native-1",
            type: "permission",
            actions: ["accept", "accept_for_session", "decline", "cancel"],
          },
        },
      });
      await session.resolveRuntimeRequest?.({
        requestId: "permission-native-1",
        turnId,
        resolution: { action },
      });
      const persisted = JSON.parse(
        await readFile(
          join(root, normalizedSessionId, "data", "fake-permission-reply.json"),
          "utf8",
        ),
      );
      expect(persisted).toEqual({
        url: expect.stringContaining(
          `directory=${encodeURIComponent(workspace)}`,
        ),
        body: { reply },
      });
      expect(session.pendingRuntimeRequests?.()).toEqual([]);
      await session.close({ reason: "permission test complete" });
    },
  );

  it.each(["allow", "ask", "deny"] as const)(
    "pins the %s permission mode while retaining external-directory denial",
    async (permissionMode) => {
      await chmod(fixture, 0o755);
      const root = await mkdtemp(
        join(tmpdir(), `paperclip-opencode-mode-${permissionMode}-`),
      );
      const workspace = await mkdtemp(
        join(tmpdir(), `paperclip-opencode-mode-${permissionMode}-workspace-`),
      );
      roots.push(root, workspace);
      const driver = new OpenCodeServerDriver({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        permissionMode,
        runtimeDirectory: root,
        command: fixture,
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_API_KEY: "fixture-key",
        },
      });
      const session = await driver.openSession({
        runId: `run-${permissionMode}`,
        normalizedSessionId: permissionMode,
        workingDirectory: workspace,
      });
      const config = JSON.parse(
        await readFile(
          join(root, permissionMode, "config", "opencode", "opencode.json"),
          "utf8",
        ),
      );
      expect(config.permission).toMatchObject({
        "*": permissionMode,
        external_directory: "deny",
      });
      expect(config.provider.openrouter.models).toHaveProperty(
        "deepseek/deepseek-v4-flash-0731",
      );
      expect(config.permission.paperclip_finish).toBeUndefined();
      expect(config.permission["paperclip_*"]).toBe("allow");
      await session.close({ reason: "permission mode test complete" });
    },
  );

  it("clears a stale active turn that already has a persisted terminal fingerprint", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-stale-turn-"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-stale-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const seed = await driver.openSession({
      runId: "run-stale-turn",
      normalizedSessionId: "stale-turn",
      workingDirectory: workspace,
    });
    const snapshot = await seed.snapshot();
    await seed.close({ reason: "seed complete" });

    const recoveryDriver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const recovery = await recoveryDriver.recoverSession?.({
      ...snapshot,
      activeTurnId: "turn-already-terminal",
      terminalTurns: [
        {
          turnId: "turn-already-terminal",
          fingerprint: "terminal-fingerprint",
        },
      ],
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
    });
    await recovery!.session!.close({ reason: "recovery-test" });
  });

  it("validates provider/model form", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    roots.push(root);
    const driver = new OpenCodeServerDriver({
      model: "bad",
      runtimeDirectory: root,
    });
    await expect(
      driver.validateConfig?.({ model: "bad" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      driver.validateConfig?.({ model: "openrouter/model" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("normalizes a structured block result", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-block",
      normalizedSessionId: "block",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "block-result" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.find((event) => event.eventType === "run.result.proposed")
        ?.payload,
    ).toMatchObject({
      reportedWorkDisposition: "blocked",
      blocker: { reasonCode: "test_dependency" },
    });
    await session.close({ reason: "test" });
  });

  it("designates the substantive pre-finish response instead of a trailing acknowledgement", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-final-selection",
      normalizedSessionId: "final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "text-before-finish" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) =>
        event.eventType === "item.completed" &&
        event.payload.kind === "agentMessage" &&
        event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text).toBe(
      "Substantive answer before finish.",
    );
    expect(
      events
        .filter((event) => event.eventType === "item.delta")
        .map((event) => event.payload.text),
    ).toEqual(
      expect.arrayContaining(["Substantive answer before finish.", "Done."]),
    );
    await session.close({ reason: "test" });
  });

  it("does not promote opening commentary to the final response when work follows it", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-commentary-only",
      normalizedSessionId: "commentary-only",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "commentary-only-before-work" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.filter(
        (event) =>
          event.eventType === "item.completed" &&
          event.payload.kind === "agentMessage" &&
          event.payload.channel === "final",
      ),
    ).toHaveLength(0);
    expect(
      events
        .filter((event) => event.eventType === "item.delta")
        .map((event) => event.payload.text),
    ).toContain("I will inspect the workspace first.");
    expect(events).toContainEqual(
      expect.objectContaining({ eventType: "run.result.proposed" }),
    );
    await session.close({ reason: "test" });
  });

  it("correlates the final response to the native message containing the semantic tool", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-correlated-final-selection",
      normalizedSessionId: "correlated-final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "correlated-final-message" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) =>
        event.eventType === "item.completed" &&
        event.payload.kind === "agentMessage" &&
        event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text).toBe(
      "Correlated substantive final answer.",
    );
    const assistantDeltas = events.filter(
      (event) =>
        event.eventType === "item.delta" &&
        event.payload.kind === "agentMessage",
    );
    expect(assistantDeltas.map((event) => event.payload.text)).toEqual([
      "I will write the result now.",
      "Correlated substantive final answer.",
      "Done.",
    ]);
    expect(assistantDeltas).toHaveLength(3);
    expect(
      assistantDeltas.every(
        (event) =>
          event.payload.channel === "progress" &&
          event.payload.providerPhase === "commentary",
      ),
    ).toBe(true);
    expect(assistantDeltas.map((event) => event.payload.item)).toEqual([
      expect.objectContaining({
        type: "agentMessage",
        channel: "progress",
        phase: "commentary",
      }),
      expect.objectContaining({
        type: "agentMessage",
        channel: "progress",
        phase: "commentary",
      }),
      expect.objectContaining({
        type: "agentMessage",
        channel: "progress",
        phase: "commentary",
      }),
    ]);
    expect(finalMessages[0]?.itemId).toBe(
      assistantDeltas.find(
        (event) =>
          event.payload.text === "Correlated substantive final answer.",
      )?.itemId,
    );
    expect(finalMessages[0]?.payload).toMatchObject({
      kind: "agentMessage",
      channel: "final",
      providerPhase: "final_answer",
    });
    await session.close({ reason: "test" });
  });

  it("uses provider structure rather than prose length to select a post-tool answer", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const session = await driver.openSession({
      runId: "run-post-tool-final-selection",
      normalizedSessionId: "post-tool-final-selection",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "final-after-tool-commentary" },
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    const finalMessages = events.filter(
      (event) =>
        event.eventType === "item.completed" &&
        event.payload.kind === "agentMessage" &&
        event.payload.channel === "final",
    );
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.payload.text).toBe(
      "This is the complete substantive answer emitted after the accepted completion tool call.",
    );
    await session.close({ reason: "test" });
  });

  it("rejects malformed and oversized SSE frames", async () => {
    const stream = (value: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        },
      });
    const consume = async (value: string) => {
      for await (const _event of openCodeServerDriverInternals.parseSse(
        stream(value),
      )) {
        // Consume the complete stream so parse failures are observed.
      }
    };
    await expect(consume("data: {bad json}\n\n")).rejects.toThrow();
    await expect(consume(`data: ${"x".repeat(1_048_577)}`)).rejects.toThrow(
      "payload limit",
    );
  });

  it("restarts OpenCode when session startup fails transiently", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    let failSessionCreate = true;
    const spawns: number[] = [];
    const commandLifecycle: string[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
      commandLifecycle: {
        beforeSpawn: () => {
          commandLifecycle.push("before");
        },
        afterSpawn: () => {
          commandLifecycle.push("after");
        },
      },
      fetch: async (input, init) => {
        if (
          failSessionCreate &&
          String(input).endsWith("/session") &&
          init?.method === "POST"
        ) {
          failSessionCreate = false;
          throw new Error("transient session initialization failure");
        }
        return fetch(input, init);
      },
      onSpawn: async ({ pid }) => {
        spawns.push(pid);
      },
    });
    const session = await driver.openSession({
      runId: "run-retry",
      normalizedSessionId: "retry",
      workingDirectory: workspace,
    });
    expect(session.ids().providerSessionId).toBe("ses_fake_1");
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(spawns.length).toBeLessThanOrEqual(3);
    expect(commandLifecycle).toEqual(
      Array.from({ length: spawns.length }, () => ["before", "after"]).flat(),
    );
    await session.close({ reason: "test" });
  });

  it("reports startup exit details with stderr captured after spawn and redacted", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-driver-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-workspace-"),
    );
    roots.push(root, workspace);
    const exitingFixture = join(root, "exit-before-health.mjs");
    await writeFile(
      exitingFixture,
      "#!/usr/bin/env node\nprocess.stderr.write(`credential=${process.env.OPENROUTER_API_KEY}\\nauthorization=super-secret-opencode-token\\n`);\nprocess.exit(17);\n",
      { mode: 0o755 },
    );
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: exitingFixture,
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "fixture-key",
      },
    });
    const error = await driver
      .openSession({
        runId: "run-startup-exit",
        normalizedSessionId: "startup-exit",
        workingDirectory: workspace,
      })
      .then(
        () => "provider unexpectedly started",
        (cause: unknown) => String(cause),
      );
    expect(error).toContain("provider_process_exited");
    expect(error).toContain("provider=opencode");
    expect(error).toContain("stage=health");
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("fixture-key");
    expect(error).not.toContain("super-secret-opencode-token");
  });
});

describe("OpenCodeServerDriver restricted_v1 typed permissions", () => {
  const sessionId = "ses_restricted";
  const permissionId = "per_restricted_1";
  const model = "llamacpp/qwen3-coder";
  const baseUrl = "http://127.0.0.1:8080/v1";

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value !== null)
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    return JSON.stringify(value);
  }

  async function harness(
    options: {
      metadata?: Record<string, unknown>;
      withToolPart?: boolean;
      failReply?: boolean;
    } = {},
  ) {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-typed-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-typed-workspace-"),
    );
    roots.push(root, workspace);
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const encoder = new TextEncoder();
    const queued: Uint8Array[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const emitNative = (event: Record<string, unknown>) => {
      const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      if (controller) controller.enqueue(frame);
      else queued.push(frame);
    };
    const asked = {
      id: permissionId,
      sessionID: sessionId,
      permission: "edit",
      patterns: ["notes.txt", "missing/file.txt"],
      metadata: options.metadata ?? { filepath: "notes.txt", diff: "+x" },
      always: ["*"],
      tool: { messageID: "msg_1", callID: "call_1" },
    };
    const state = {
      toolInput: { filePath: "notes.txt", content: "x" } as Record<
        string,
        unknown
      >,
      live: [structuredClone(asked)] as Array<Record<string, unknown>>,
      replies: [] as Array<{ id: string; body: unknown }>,
      aborts: 0,
      messageFetches: 0,
      childPid: 0,
      beforePermissionRead: null as (() => Promise<void>) | null,
    };
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/global/health")
        return json({ healthy: true, version: "1.18.29" });
      if (url.pathname === "/event")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              for (const frame of queued.splice(0))
                streamController.enqueue(frame);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      if (method === "POST" && url.pathname === "/session")
        return json({ id: sessionId });
      if (method === "GET" && url.pathname === "/question") return json([]);
      if (method === "GET" && url.pathname === "/permission") {
        await state.beforePermissionRead?.();
        return json(state.live);
      }
      if (
        method === "GET" &&
        url.pathname === `/session/${sessionId}/message/msg_1`
      ) {
        state.messageFetches += 1;
        return json({
          info: { id: "msg_1", role: "assistant" },
          parts:
            options.withToolPart === false
              ? []
              : [
                  {
                    id: "prt_1",
                    type: "tool",
                    callID: "call_1",
                    tool: (state as any).toolName ?? "edit",
                    state: { status: "running", input: state.toolInput },
                  },
                ],
        });
      }
      if (method === "POST" && url.pathname === `/session/${sessionId}/prompt_async`) {
        emitNative({ type: "permission.asked", id: "evt_asked", properties: asked });
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(url.pathname)) {
        state.replies.push({
          id: url.pathname.split("/")[2]!,
          body: JSON.parse(String(init?.body)),
        });
        if (options.failReply) return json({ error: "boom" }, 500);
        return json(true);
      }
      if (method === "POST" && url.pathname === `/session/${sessionId}/abort`) {
        state.aborts += 1;
        return json(true);
      }
      throw new Error(`unexpected OpenCode request ${method} ${url}`);
    };
    const driver = new OpenCodeServerDriver({
      model,
      permissionProfile: "restricted_v1",
      llamaCppBaseUrl: baseUrl,
      onSpawn: async ({ pid }) => {
        state.childPid = pid;
      },
      runtimeDirectory: root,
      command: fixture,
      fetch: fetcher,
      environment: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        OPENROUTER_API_KEY: "must-not-leak",
        HTTPS_PROXY: "http://proxy.invalid:3128",
        SSL_CERT_FILE: "/tmp/should-not-pass.pem",
      },
    });
    const normalizedSessionId = "typed";
    const session = await driver.openSession({
      runId: "run-typed",
      normalizedSessionId,
      workingDirectory: workspace,
    });
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> =
      [];
    const iterator = session.events()[Symbol.asyncIterator]();
    const next = async (eventType: string, limit = 60) => {
      for (let count = 0; count < limit; count += 1) {
        const result = await iterator.next();
        if (result.done) return null;
        events.push(result.value as never);
        if (result.value.eventType === eventType) return result.value;
      }
      return null;
    };
    return {
      root,
      workspace,
      session,
      state,
      asked,
      emitNative,
      events,
      next,
      dropSse: () => controller!.error(new Error("QA lost SSE")),
      configPath: join(root, normalizedSessionId, "config", "opencode", "opencode.json"),
      environmentPath: join(root, normalizedSessionId, "data", "fake-environment.json"),
    };
  }

  // QA TAX-473 H9/H10 probe, verbatim from the re-QA report.
  it.each(["unknown_tool", "missing_arguments"])("QA rejects incomplete or unknown permission: %s", async (kind) => {
    const h = await harness();
    if (kind === "unknown_tool") { h.asked.permission = "unrecognized_mutation"; (h.state as any).toolName = "unrecognized_mutation"; }
    else delete (h.asked as any).tool;
    h.state.live = [structuredClone(h.asked)];
    const { turnId } = await h.session.startTurn({message:{role:"user",text:"edit"}});
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    const pending = h.session.pendingRuntimeRequests?.()[0];
    if (pending) {
      await h.session.resolveRuntimeRequest!({requestId: permissionId, turnId,
        resolution:{action:"permission_decision",decision:"once",contractSha256: pending.permission!.contractSha256}});
    }
    const observed = structuredClone(h.state.replies);
    await h.session.close({reason:"QA complete"});
    expect(observed.some(r => (r.body as any).reply === "once")).toBe(false);
  });

  // TAX-452 H9/H10: every unapprovable shape is rejected natively, with the
  // right diagnostic, and never surfaces a typed request.
  it.each([
    {
      name: "unknown permission and tool",
      code: "permission_unknown_tool",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        h.asked.permission = "unrecognized_mutation";
        (h.state as any).toolName = "unrecognized_mutation";
      },
    },
    {
      name: "edit permission asked by a non-edit tool",
      code: "permission_unknown_tool",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        (h.state as any).toolName = "bash";
      },
    },
    {
      name: "read permission asked by the write tool",
      code: "permission_unknown_tool",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        h.asked.permission = "read";
        (h.state as any).toolName = "write";
      },
    },
    {
      name: "known tool under an unknown permission",
      code: "permission_unknown_tool",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        h.asked.permission = "list";
      },
    },
    {
      name: "missing tool reference",
      code: "permission_contract_unrepresentable",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        delete (h.asked as any).tool;
      },
    },
    {
      name: "null tool reference",
      code: "permission_contract_unrepresentable",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        (h.asked as any).tool = null;
      },
    },
    {
      name: "tool reference without callID",
      code: "permission_contract_unrepresentable",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        (h.asked as any).tool = { messageID: "msg_1" };
      },
    },
    {
      name: "non-object tool arguments",
      code: "permission_contract_unrepresentable",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        (h.state as any).toolInput = null;
      },
    },
    {
      name: "tool part without a name",
      code: "permission_contract_unrepresentable",
      mutate: (h: Awaited<ReturnType<typeof harness>>) => {
        (h.state as any).toolName = "";
      },
    },
  ])("rejects natively with $code for $name", async ({ code, mutate }) => {
    const h = await harness();
    mutate(h);
    h.state.live = [structuredClone(h.asked)];
    await h.session.startTurn({ message: { role: "user", text: "edit" } });
    const diagnostic = await h.next("harness.diagnostic");
    expect(diagnostic?.payload).toMatchObject({
      code,
      providerRequestId: permissionId,
    });
    for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    expect(
      h.events.some((event) => event.eventType === "runtime_request.created"),
    ).toBe(false);
    expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
    await h.session.close({ reason: "done" });
  });

  it.each(["write", "apply_patch"])(
    "keeps the %s tool approvable under the edit permission",
    async (toolName) => {
      const h = await harness();
      (h.state as any).toolName = toolName;
      const { turnId } = await h.session.startTurn({
        message: { role: "user", text: "edit" },
      });
      const created = await h.next("runtime_request.created");
      const contract = (created!.payload as any).request.permission;
      expect(contract.tool).toEqual({
        name: toolName,
        messageId: "msg_1",
        callId: "call_1",
      });
      await h.session.resolveRuntimeRequest!({
        requestId: permissionId,
        turnId,
        resolution: {
          action: "permission_decision",
          decision: "once",
          contractSha256: contract.contractSha256,
        },
      });
      expect(h.state.replies).toEqual([
        { id: permissionId, body: { reply: "once" } },
      ]);
      await h.session.close({ reason: "done" });
    },
  );

  it("re-verifies the tool part name before once and rejects a swapped tool", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const contract = (created!.payload as any).request.permission;
    // Same call id and arguments, different tool identity.
    (h.state as any).toolName = "write";
    await h.session.resolveRuntimeRequest!({
      requestId: permissionId,
      turnId,
      resolution: {
        action: "permission_decision",
        decision: "once",
        contractSha256: contract.contractSha256,
      },
    });
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    const diagnostic = await h.next("harness.diagnostic");
    expect(diagnostic?.payload).toMatchObject({
      code: "permission_contract_drift",
    });
    await h.session.close({ reason: "done" });
  });

  // QA TAX-470 H4 (original OS-level probe). A raw process running as the same
  // OS uid as OpenCode can always read /proc/<pid>/environ of the OpenCode
  // server (OPENCODE_SERVER_PASSWORD is env-only in OpenCode 1.18.29) and any
  // file that process can read. No in-process policy can prevent that; the only
  // full mitigation is OS-user separation between the control plane and the
  // tool-executing uid (handoff, out of scope for the driver). restricted_v1
  // instead removes every tool that can spawn such a process (bash/task deny)
  // and rejects any permission whose resolved target escapes the workspace —
  // asserted by "QA restricted tool surface cannot reach the control
  // credential" below. Kept skipped, not deleted, so the residual is visible.
  it.skip("QA hides control credentials from same-uid shell processes (needs OS-user separation)", async () => {
    const h = await harness();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `
      const fs=require('fs');
      const env=fs.readFileSync('/proc/'+process.argv[1]+'/environ');
      const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      process.stdout.write(JSON.stringify({
        controlPasswordReadable:env.includes(Buffer.from('OPENCODE_SERVER_PASSWORD=')),
        bridgeCredentialReadable:typeof config.mcp.paperclip.headers.Authorization==='string'
      }));`,
          String(h.state.childPid),
          h.configPath,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      ),
    );
    await h.session.close({ reason: "QA complete" });
    expect(result).toEqual({
      controlPasswordReadable: false,
      bridgeCredentialReadable: false,
    });
  });

  it("QA blocks changed symlink ancestor for a nonexistent write target", async () => {
    const h = await harness();
    await mkdir(join(h.workspace, "before"));
    await mkdir(join(h.workspace, "after"));
    await symlink(join(h.workspace, "before"), join(h.workspace, "missing"));
    h.state.toolInput = { filePath: "missing/file.txt", content: "x" };
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const contract = (created?.payload as any).request.permission;
    await rm(join(h.workspace, "missing"));
    await symlink(join(h.workspace, "after"), join(h.workspace, "missing"));
    await h.session.resolveRuntimeRequest!({
      requestId: permissionId,
      turnId,
      resolution: {
        action: "permission_decision",
        decision: "once",
        contractSha256: contract.contractSha256,
      },
    });
    const observed = structuredClone(h.state.replies);
    await h.session.close({ reason: "QA complete" });
    expect(observed).toEqual([{ id: permissionId, body: { reply: "reject" } }]);
  });

  it("QA prevents a once dispatch after terminal cancellation wins during live validation", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as any).request.permission.contractSha256;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    h.state.beforePermissionRead = async () => {
      entered();
      await gate;
    };
    const approval = h.session.resolveRuntimeRequest!({
      requestId: permissionId,
      turnId,
      resolution: { action: "permission_decision", decision: "once", contractSha256: sha },
    });
    await enteredPromise;
    h.emitNative({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    });
    await h.next("turn.cancelled");
    release();
    await approval;
    const observed = structuredClone(h.state.replies);
    await h.session.close({ reason: "QA complete" });
    expect(observed.some((r) => (r.body as any).reply === "once")).toBe(false);
  });

  it("QA invalidates a pending approval after loss of SSE", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as any).request.permission.contractSha256;
    h.dropSse();
    await new Promise((r) => setTimeout(r, 100));
    await h.session
      .resolveRuntimeRequest!({
        requestId: permissionId,
        turnId,
        resolution: { action: "permission_decision", decision: "once", contractSha256: sha },
      })
      .catch(() => {});
    const observed = structuredClone(h.state.replies);
    await h.session.close({ reason: "QA complete" });
    expect(observed.some((r) => (r.body as any).reply === "once")).toBe(false);
  });

  it.each([
    { name: "/proc environ of the OpenCode server", target: "environ" },
    { name: "private generated opencode.json", target: "config" },
    { name: "dangling symlink outside the workspace", target: "dangling" },
  ])(
    "QA restricted tool surface cannot reach the control credential: $name",
    async ({ target }) => {
      const h = await harness();
      const config = JSON.parse(await readFile(h.configPath, "utf8"));
      // No process-spawning, network, or subagent tool exists to bypass the
      // per-path checks (the raw same-uid OS probe above stays skipped).
      for (const tool of ["bash", "webfetch", "websearch", "task"])
        expect(config.permission[tool]).toBe("deny");
      expect(config.permission["*"]).toBe("ask");
      expect(config.permission.external_directory).toBe("deny");
      expect(h.state.childPid).toBeGreaterThan(0);
      const destination =
        target === "environ"
          ? `/proc/${h.state.childPid}/environ`
          : target === "config"
            ? h.configPath
            : join(tmpdir(), `paperclip-qa-outside-${process.pid}`, "new.txt");
      await symlink(destination, join(h.workspace, "link"));
      h.asked.permission = target === "dangling" ? "edit" : "read";
      (h.state as any).toolName = target === "dangling" ? "write" : "read";
      h.asked.patterns = ["link"];
      h.state.toolInput = { filePath: "link" };
      h.state.live = [structuredClone(h.asked)];
      await h.session.startTurn({ message: { role: "user", text: "read" } });
      const diagnostic = await h.next("harness.diagnostic");
      expect(diagnostic?.payload).toMatchObject({
        code: "permission_target_outside_workspace",
        providerRequestId: permissionId,
      });
      for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      expect(h.state.replies).toEqual([
        { id: permissionId, body: { reply: "reject" } },
      ]);
      expect(
        h.events.some((event) => event.eventType === "runtime_request.created"),
      ).toBe(false);
      expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
      // The suite cleanup chmods recursively and would follow this link.
      await rm(join(h.workspace, "link"));
      await h.session.close({ reason: "escape test complete" });
    },
  );

  it("emits typed diagnostics when SSE loss invalidates a pending permission and fails the turn", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as any).request.permission.contractSha256;
    h.dropSse();
    const failed = await h.next("turn.failed");
    expect(failed?.payload).toMatchObject({ error: { code: "opencode_sse_lost" } });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: "harness.diagnostic",
        payload: expect.objectContaining({
          code: "permission_invalidated_sse_lost",
          providerRequestId: permissionId,
        }),
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: "runtime_request.cancelled",
        payload: expect.objectContaining({ reason: "permission_invalidated_sse_lost" }),
      }),
    );
    for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.replies).toEqual([{ id: permissionId, body: { reply: "reject" } }]);
    await expect(
      h.session.resolveRuntimeRequest!({
        requestId: permissionId,
        turnId,
        resolution: { action: "permission_decision", decision: "once", contractSha256: sha },
      }),
    ).rejects.toThrow(/no longer pending/);
    const transcript = await h.session.transcript();
    expect(transcript.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "permission_decision_after_terminal" }),
      }),
    );
    expect(h.state.replies).toEqual([{ id: permissionId, body: { reply: "reject" } }]);
    await h.session.close({ reason: "sse test complete" });
  });

  it("settles a pending permission with exactly one native reject on terminal cancellation", async () => {
    const h = await harness();
    await h.session.startTurn({ message: { role: "user", text: "edit" } });
    await h.next("runtime_request.created");
    h.emitNative({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    });
    await h.next("turn.cancelled");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: "runtime_request.cancelled",
        payload: expect.objectContaining({ reason: "turn_cancelled" }),
      }),
    );
    for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.replies).toEqual([{ id: permissionId, body: { reply: "reject" } }]);
    expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
    await h.session.close({ reason: "terminal test complete" });
  });

  it("rejects a pending permission natively before /abort when the turn is interrupted (board cancel)", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({ message: { role: "user", text: "edit" } });
    await h.next("runtime_request.created");
    await h.session.interrupt?.({ turnId, reason: "Cancelled by a board operator" });
    for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.replies).toEqual([{ id: permissionId, body: { reply: "reject" } }]);
    expect(h.state.aborts).toBe(1);
    const cancelled = await h.next("runtime_request.cancelled");
    expect(cancelled?.payload).toMatchObject({ reason: "turn_interrupted" });
    expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
    // A late `once` can never reach OpenCode.
    await expect(h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: { action: "permission_decision", decision: "once", contractSha256: "0".repeat(64) },
    })).rejects.toThrow();
    expect(h.state.replies.filter((reply) => (reply.body as { reply: string }).reply === "once")).toEqual([]);
    await h.session.close({ reason: "interrupt test complete" });
  });

  it("freezes a typed, hash-bound request with fetched arguments and replies once when live state matches", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const request = (created?.payload as Record<string, any>).request;
    expect(Object.keys(request).sort()).toEqual(
      [
        "decisions",
        "itemId",
        "origin",
        "permission",
        "prompt",
        "requestId",
        "requestKind",
        "schema",
        "status",
        "turnId",
        "type",
      ].sort(),
    );
    expect(request).toMatchObject({
      schema: "paperclip.runtime_request.permission.v1",
      requestKind: "runtime",
      requestId: permissionId,
      type: "permission",
      decisions: ["once", "reject"],
      origin: {
        adapter: "opencode-server",
        provider: "opencode",
        method: "permission.asked",
      },
    });
    const contract = request.permission;
    const workspaceReal = await realpathOf(h.workspace);
    expect(contract).toMatchObject({
      schema: "paperclip.opencode_permission_contract.v1",
      provider: "opencode",
      providerVersion: "1.18.29",
      providerSessionId: sessionId,
      providerRequestId: permissionId,
      permission: "edit",
      tool: { name: "edit", messageId: "msg_1", callId: "call_1" },
      arguments: { filePath: "notes.txt", content: "x" },
      metadata: h.asked.metadata,
      always: ["*"],
      cwd: workspaceReal,
      targets: [
        { pattern: "notes.txt", resolvedPath: join(workspaceReal, "notes.txt") },
        // TAX-470 H1: deepest existing ancestor realpath + missing suffix.
        {
          pattern: "missing/file.txt",
          resolvedPath: join(workspaceReal, "missing", "file.txt"),
        },
      ],
      policy: { profile: "restricted_v1", permissionDefault: "ask" },
    });
    const { contractSha256, ...unsigned } = contract;
    expect(contractSha256).toBe(
      createHash("sha256").update(canonical(unsigned)).digest("hex"),
    );
    expect(h.session.pendingRuntimeRequests?.()[0]).toMatchObject({
      requestKind: "permission_approval",
      decisions: ["once", "reject"],
      permission: { contractSha256 },
    });
    await h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: {
        action: "permission_decision",
        decision: "once",
        contractSha256,
      },
    });
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "once" } },
    ]);
    expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
    await h.session.close({ reason: "typed test complete" });
  });

  it("replies reject when tool arguments drift before a once decision", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as Record<string, any>).request.permission
      .contractSha256;
    h.state.toolInput = { filePath: "notes.txt", content: "rm -rf" };
    await h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: { action: "permission_decision", decision: "once", contractSha256: sha },
    });
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    await h.next("runtime_request.resolved");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: "harness.diagnostic",
        payload: expect.objectContaining({ code: "permission_contract_drift" }),
      }),
    );
    await h.session.close({ reason: "drift test complete" });
  });

  it("replies reject when the native request disappeared or changed patterns", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as Record<string, any>).request.permission
      .contractSha256;
    h.state.live = [{ ...h.asked, patterns: ["other.txt"] }];
    await h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: { action: "permission_decision", decision: "once", contractSha256: sha },
    });
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    await h.session.close({ reason: "pattern drift test complete" });
  });

  it("replies reject on a contract hash mismatch and on cancel, and never sends always", async () => {
    const h = await harness();
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    await h.next("runtime_request.created");
    await expect(
      h.session.resolveRuntimeRequest!({
        requestId: permissionId,
        turnId,
        resolution: { action: "accept_for_session" },
      }),
    ).rejects.toThrow(/permission_decision or cancel/);
    await expect(
      h.session.resolveRuntimeRequest!({
        requestId: permissionId,
        turnId,
        resolution: { action: "accept" },
      }),
    ).rejects.toThrow();
    expect(h.state.replies).toEqual([]);
    await h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: {
        action: "permission_decision",
        decision: "once",
        contractSha256: "0".repeat(64),
      },
    });
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    expect(h.events.concat(await drainUntil(h, "runtime_request.resolved"))).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "permission_contract_mismatch" }),
      }),
    );
    await h.session.close({ reason: "mismatch test complete" });

    const c = await harness();
    const cancelTurn = await c.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    await c.next("runtime_request.created");
    await c.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId: cancelTurn.turnId,
      resolution: { action: "cancel" },
    });
    expect(c.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    expect(
      [...h.state.replies, ...c.state.replies].some(
        (reply) => (reply.body as { reply: string }).reply === "always",
      ),
    ).toBe(false);
    await c.session.close({ reason: "cancel test complete" });
  });

  async function drainUntil(
    h: Awaited<ReturnType<typeof harness>>,
    eventType: string,
  ) {
    await h.next(eventType);
    return h.events;
  }

  it.each([
    { name: "missing tool part", options: { withToolPart: false } },
    {
      name: "oversize contract",
      options: { metadata: { diff: "x".repeat(70 * 1024) } },
    },
  ])("rejects natively without a request for a $name", async ({ options }) => {
    const h = await harness(options);
    await h.session.startTurn({ message: { role: "user", text: "edit" } });
    const diagnostic = await h.next("harness.diagnostic");
    expect(diagnostic?.payload).toMatchObject({
      code: "permission_contract_unrepresentable",
      providerRequestId: permissionId,
    });
    for (let attempt = 0; attempt < 50 && h.state.replies.length === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.replies).toEqual([
      { id: permissionId, body: { reply: "reject" } },
    ]);
    expect(
      h.events.some((event) => event.eventType === "runtime_request.created"),
    ).toBe(false);
    expect(h.session.pendingRuntimeRequests?.()).toEqual([]);
    await h.session.close({ reason: "unrepresentable test complete" });
  });

  it("fails the turn closed on an out-of-band grant", async () => {
    const h = await harness();
    await h.session.startTurn({ message: { role: "user", text: "edit" } });
    await h.next("runtime_request.created");
    h.emitNative({
      type: "permission.replied",
      id: "evt_oob",
      properties: { sessionID: sessionId, requestID: permissionId, reply: "once" },
    });
    const failed = await h.next("turn.failed");
    expect(failed?.payload).toMatchObject({
      error: { code: "permission_out_of_band_reply" },
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: "harness.diagnostic",
        payload: expect.objectContaining({ code: "permission_out_of_band_reply" }),
      }),
    );
    for (let attempt = 0; attempt < 50 && h.state.aborts === 0; attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(h.state.aborts).toBe(1);
    expect(h.state.replies).toEqual([]);
    await h.session.close({ reason: "oob test complete" });
  });

  it("does not retry a failed reply and fails the turn as uncertain", async () => {
    const h = await harness({ failReply: true });
    const { turnId } = await h.session.startTurn({
      message: { role: "user", text: "edit" },
    });
    const created = await h.next("runtime_request.created");
    const sha = (created?.payload as Record<string, any>).request.permission
      .contractSha256;
    await h.session.resolveRuntimeRequest?.({
      requestId: permissionId,
      turnId,
      resolution: { action: "permission_decision", decision: "reject", contractSha256: sha },
    });
    expect(h.state.replies).toHaveLength(1);
    await h.next("turn.failed");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "permission_reply_uncertain" }),
      }),
    );
    expect(h.state.replies).toHaveLength(1);
    await h.session.close({ reason: "uncertain test complete" });
  });

  it("writes a loopback llama.cpp-only config and an allowlisted environment", async () => {
    const h = await harness();
    const config = JSON.parse(await readFile(h.configPath, "utf8"));
    expect(config).toMatchObject({
      model,
      small_model: model,
      enabled_providers: ["llamacpp"],
      provider: {
        llamacpp: {
          npm: "@ai-sdk/openai-compatible",
          name: "llama.cpp",
          options: { baseURL: baseUrl },
          models: { "qwen3-coder": { name: "qwen3-coder", tool_call: true } },
        },
      },
    });
    expect(Object.keys(config.provider)).toEqual(["llamacpp"]);
    expect(config.permission["*"]).toBe("ask");
    expect(config.permission.external_directory).toBe("deny");
    for (const tool of ["bash", "webfetch", "websearch", "task"])
      expect(config.permission[tool]).toBe("deny");
    expect(config.permission.question).toBe("allow");
    expect(config.permission["paperclip_*"]).toBe("deny");
    expect(config.permission["mcp__paperclip__*"]).toBe("deny");
    expect(config.permission.paperclip_read_document).toBe("allow");
    expect(config.permission.paperclip_write_document).toBeUndefined();
    expect(config.permission.paperclip_call_api).toBeUndefined();
    expect(
      Object.entries(config.permission).filter(
        ([key, value]) => value === "allow" && key.endsWith("*"),
      ),
    ).toEqual([]);
    let environment: { keys: string[] } | null = null;
    for (let attempt = 0; attempt < 200 && environment === null; attempt += 1) {
      environment = await readFile(h.environmentPath, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      if (environment === null)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    expect(environment).not.toBeNull();
    const keys = environment!.keys;
    for (const forbidden of [
      "OPENROUTER_API_KEY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "SSL_CERT_FILE",
    ])
      expect(keys).not.toContain(forbidden);
    for (const required of [
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "HOME",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_SHARE",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    ])
      expect(keys).toContain(required);
    await h.session.close({ reason: "config test complete" });
  });

  it.each([
    "http://10.0.0.5:8080/v1",
    "https://127.0.0.1:8080/v1",
    "http://localhost.evil.test/v1",
    "not a url",
  ])("rejects the non-loopback llama.cpp base URL %s", (llamaCppBaseUrl) => {
    expect(
      () =>
        new OpenCodeServerDriver({
          model,
          permissionProfile: "restricted_v1",
          llamaCppBaseUrl,
          runtimeDirectory: "/tmp/paperclip-opencode-loopback",
        }),
    ).toThrow(/llamaCppBaseUrl/);
  });

  it("requires a llamacpp model under restricted_v1", () => {
    expect(
      () =>
        new OpenCodeServerDriver({
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          permissionProfile: "restricted_v1",
          llamaCppBaseUrl: baseUrl,
          runtimeDirectory: "/tmp/paperclip-opencode-loopback",
        }),
    ).toThrow(/llamacpp/);
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
