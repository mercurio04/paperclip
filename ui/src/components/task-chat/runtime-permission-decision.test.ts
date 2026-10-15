import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import type { TaskChatRuntimeRequestItem } from "./task-chat-model";
import { runtimeRequestReplacesComposerSkip } from "./task-chat-model";
import {
  permissionDecisionError,
  permissionDecisionResolution,
} from "./runtime-permission-decision";

const SHA = "ef".repeat(32);

function item(
  overrides: Partial<TaskChatRuntimeRequestItem> = {},
): TaskChatRuntimeRequestItem {
  return {
    id: "permission-request",
    kind: "protocol",
    surface: "runtime_request",
    runId: "run-1",
    requestId: "perm-1",
    requestKind: "runtime",
    turnId: "turn-1",
    requestType: "permission",
    status: "pending",
    prompt: "Allow?",
    choices: [],
    fields: [],
    permissionContract: {
      schema: "paperclip.opencode_permission_contract.v1",
      provider: "opencode",
      providerVersion: "1.18.29",
      providerSessionId: "ses_1",
      providerRequestId: "per_1",
      permission: "bash",
      tool: null,
      patterns: ["ls"],
      always: [],
      cwd: "/work",
      targets: [],
      argumentsJson: null,
      metadataJson: null,
      policy: null,
      contractSha256: SHA,
      contractShaPrefix: SHA.slice(0, 12),
      decisions: ["once", "reject"],
    },
    ...overrides,
  };
}

describe("permissionDecisionResolution", () => {
  it.each(["once", "reject"] as const)("builds the %s resolution body", (decision) => {
    expect(
      permissionDecisionResolution(item(), {
        action: "permission_decision",
        decision,
        contractSha256: SHA,
      }),
    ).toEqual({ action: "permission_decision", decision, contractSha256: SHA });
  });

  it("refuses legacy actions, sha mismatch and malformed contracts", () => {
    expect(() =>
      permissionDecisionResolution(item(), { action: "accept_for_session" }),
    ).toThrow();
    expect(() =>
      permissionDecisionResolution(item(), { action: "cancel" }),
    ).toThrow();
    expect(() =>
      permissionDecisionResolution(item(), {
        action: "permission_decision",
        decision: "once",
        contractSha256: "00".repeat(32),
      }),
    ).toThrow(/changed since it was shown/);
    expect(() =>
      permissionDecisionResolution(
        item({ permissionContract: null, permissionContractInvalid: true }),
        { action: "permission_decision", decision: "reject", contractSha256: SHA },
      ),
    ).toThrow(/is invalid/);
  });

  it("hides the composer skip for typed permissions", () => {
    expect(runtimeRequestReplacesComposerSkip(item())).toBe(true);
    expect(
      runtimeRequestReplacesComposerSkip(item({ permissionContract: undefined })),
    ).toBe(false);
  });
});

describe("permissionDecisionError", () => {
  it("explains 409 and 502 without hiding the server message", () => {
    expect(
      permissionDecisionError(new ApiError("already decided", 409, null)).message,
    ).toMatch(/already decided or its contract.*already decided/);
    expect(
      permissionDecisionError(new ApiError("dispatch uncertain", 502, null)).message,
    ).toMatch(/not be retried.*dispatch uncertain/);
    const other = new Error("boom");
    expect(permissionDecisionError(other)).toBe(other);
  });
});
