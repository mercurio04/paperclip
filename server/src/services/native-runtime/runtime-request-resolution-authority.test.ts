import { readFileSync } from "node:fs";

import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

import { redactEventPayload } from "../../redaction.js";
import {
  assertNativeRuntimeRequestResolverAuthorized,
  computeNativePermissionContractSha256,
  parseNativePermissionDecisionResolution,
  NativeRuntimeRequestResolutionAuthorizationError,
  readPendingNativeRuntimeRequest,
  type PendingNativeRuntimeRequest,
} from "./runtime-request-resolution-authority.js";

function dbReturning(row: Record<string, unknown> | null): Db {
  const limit = vi.fn(async () => row ? [row] : []);
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit,
  };
  return { select: vi.fn(() => query) } as unknown as Db;
}

const binding = {
  companyId: "company-1",
  runId: "00000000-0000-4000-8000-000000000901",
  requestId: "request-1",
};

function createdEvent(requestKind: string) {
  return {
    eventType: "runtime_request.created",
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        eventType: "runtime_request.created",
        sourceKind: "runner",
        runId: binding.runId,
        turnId: "turn-1",
        payload: {
          request: {
            requestId: binding.requestId,
            requestKind,
            turnId: "turn-1",
            status: "pending",
          },
        },
      },
    },
  };
}

describe("native runtime request resolution authority", () => {
  it("derives privileged approval policy from the durable canonical request", async () => {
    await expect(
      readPendingNativeRuntimeRequest(
        dbReturning(createdEvent("command_approval")),
        binding,
      ),
    ).resolves.toEqual({
      ...binding,
      requestKind: "command_approval",
      turnId: "turn-1",
      resolverPolicy: "instance_admin",
    });
  });

  it("treats a terminal latest event as no longer pending", async () => {
    await expect(
      readPendingNativeRuntimeRequest(dbReturning({
        eventType: "runtime_request.resolved",
        payload: { prpEvent: { payload: { requestId: binding.requestId } } },
      }), binding),
    ).resolves.toBeNull();
  });

  it("denies ordinary humans for approvals but permits administrators", () => {
    const pending: PendingNativeRuntimeRequest = {
      ...binding,
      requestKind: "file_approval",
      turnId: "turn-1",
      resolverPolicy: "instance_admin",
    };
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "ordinary-member",
      isInstanceAdmin: false,
    })).toThrowError(NativeRuntimeRequestResolutionAuthorizationError);
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "instance-admin",
      isInstanceAdmin: true,
    })).not.toThrow();
  });

  it("keeps structured questions on the existing authenticated-human policy", () => {
    const pending: PendingNativeRuntimeRequest = {
      ...binding,
      requestKind: "runtime",
      turnId: "turn-1",
      resolverPolicy: "human_only",
    };
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "company-member",
      isInstanceAdmin: false,
    })).not.toThrow();
  });

  describe("typed OpenCode permission requests", () => {
    const baseContract = {
      schema: "paperclip.opencode_permission_contract.v1",
      provider: "opencode",
      providerVersion: "1.18.29",
      providerSessionId: "ses_1",
      providerRequestId: "per_1",
      permission: "bash",
      tool: null,
      patterns: ["ls"],
      always: [],
      metadata: {},
      arguments: null,
      cwd: "/w",
      targets: [],
      policy: { profile: "restricted_v1", permissionDefault: "ask" },
    };
    const sha = computeNativePermissionContractSha256(baseContract);
    function permissionEvent(
      request: Record<string, unknown> = {},
      permission: Record<string, unknown> = {},
    ) {
      const event = createdEvent("runtime");
      const contract: Record<string, unknown> = { ...baseContract, ...permission };
      if (!("contractSha256" in permission)) {
        contract.contractSha256 = computeNativePermissionContractSha256(contract);
      }
      Object.assign(event.payload.prpEvent.payload.request, {
        schema: "paperclip.runtime_request.permission.v1",
        type: "permission",
        prompt: "edit",
        decisions: ["once", "reject"],
        permission: contract,
        ...request,
      });
      return event;
    }

    it("recomputes the canonical contract sha exactly like the TS driver and Rust runnerd", () => {
      const fixture = JSON.parse(readFileSync(
        new URL(
          "../../../../packages/paperclip-runner/protocol/fixtures/permissions/opencode-permission-request.json",
          import.meta.url,
        ),
        "utf8",
      )) as { request: { permission: Record<string, unknown> & { contractSha256: string } } };
      expect(computeNativePermissionContractSha256(fixture.request.permission))
        .toBe(fixture.request.permission.contractSha256);
    });

    it("treats a stored contract that no longer matches its own sha as non-actionable", async () => {
      // Same signed sha, but a field changed after signing (e.g. redaction).
      const tampered = permissionEvent({}, {
        contractSha256: sha,
        arguments: { command: "rm -rf /" },
      });
      await expect(readPendingNativeRuntimeRequest(dbReturning(tampered), binding))
        .resolves.toBeNull();
      // A well-formed but wrong hex sha is equally non-actionable.
      await expect(readPendingNativeRuntimeRequest(
        dbReturning(permissionEvent({}, { contractSha256: "0".repeat(64) })),
        binding,
      )).resolves.toBeNull();
    });

    it("keeps the frozen contract verbatim through event redaction so the sha still verifies", async () => {
      const event = permissionEvent({}, {
        tool: { messageId: "msg_1", callId: "call_1" },
        metadata: { command: "curl -H 'x-token: abc' https://example.test", deep: { a: { b: { c: 1 } } } },
        arguments: { command: "curl -H 'x-token: abc' https://example.test", token: "visible-to-approver" },
      });
      const original = JSON.parse(JSON.stringify(event.payload));
      const redacted = redactEventPayload(event.payload);
      const contract = (redacted as typeof original).prpEvent.payload.request.permission;
      expect(contract).toEqual(original.prpEvent.payload.request.permission);
      await expect(readPendingNativeRuntimeRequest(
        dbReturning({ eventType: "runtime_request.created", payload: redacted }),
        binding,
      )).resolves.toMatchObject({ resolverPolicy: "instance_admin" });
      // Keys outside the permission subtree are still redacted by key.
      const leaky = redactEventPayload({
        ...event.payload,
        prpEvent: {
          ...event.payload.prpEvent,
          payload: { ...event.payload.prpEvent.payload, token: "secret-value" },
        },
      }) as { prpEvent: { payload: { token: string } } };
      expect(leaky.prpEvent.payload.token).toBe("***REDACTED***");
    });

    it("raises a runtime permission to instance_admin and exposes the frozen contract", async () => {
      const pending = await readPendingNativeRuntimeRequest(
        dbReturning(permissionEvent()),
        binding,
      );
      expect(pending).toMatchObject({
        requestKind: "runtime",
        turnId: "turn-1",
        resolverPolicy: "instance_admin",
        permission: {
          contractSha256: sha,
          decisions: ["once", "reject"],
          contract: expect.objectContaining({ permission: "bash", cwd: "/w" }),
        },
      });
    });

    it.each([
      ["unknown request key", { extra: 1 }, {}],
      ["unknown permission key", {}, { extra: 1 }],
      ["always decision", { decisions: ["once", "always", "reject"] }, {}],
      ["bad sha", {}, { contractSha256: "nothex" }],
      ["wrong contract schema", {}, { schema: "paperclip.other.v1" }],
    ])("fails closed on %s", async (_label, request, permission) => {
      await expect(readPendingNativeRuntimeRequest(
        dbReturning(permissionEvent(request, permission)),
        binding,
      )).resolves.toBeNull();
    });

    it("keeps ordinary runtime input human_only", async () => {
      await expect(readPendingNativeRuntimeRequest(
        dbReturning(createdEvent("runtime")),
        binding,
      )).resolves.toMatchObject({ resolverPolicy: "human_only" });
    });

    it("parses only canonical permission decisions", () => {
      expect(parseNativePermissionDecisionResolution({
        action: "permission_decision", decision: "reject", contractSha256: sha,
      })).toEqual({ action: "permission_decision", decision: "reject", contractSha256: sha });
      for (const value of [
        { action: "permission_decision", decision: "always", contractSha256: sha },
        { action: "accept_for_session" },
        { action: "permission_decision", decision: "once", contractSha256: sha, x: 1 },
        null,
      ]) {
        expect(parseNativePermissionDecisionResolution(value)).toBeNull();
      }
    });
  });
});
