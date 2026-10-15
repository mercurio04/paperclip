import { describe, expect, it } from "vitest";

import {
  parseOpenCodeProxyPermissionMode,
  parseOpenCodeProxyPermissionProfile,
  settleOpenCodeProxyPermissionRequest,
} from "./opencode-proxy-permission-mode.js";

describe("OpenCode runnerd proxy permission mode", () => {
  it.each(["allow", "ask", "deny"] as const)(
    "admits the exact %s mode",
    (mode) => {
      expect(parseOpenCodeProxyPermissionMode(mode)).toBe(mode);
    },
  );

  it("defaults an unset or empty mode to ask", () => {
    expect(parseOpenCodeProxyPermissionMode(undefined)).toBe("ask");
    expect(parseOpenCodeProxyPermissionMode("  ")).toBe("ask");
  });

  it("rejects an unknown mode", () => {
    expect(() => parseOpenCodeProxyPermissionMode("approve-all")).toThrow(
      "PAPERCLIP_OPENCODE_PERMISSION_MODE is invalid",
    );
  });
});

describe("OpenCode runnerd proxy permission profile", () => {
  it("is opt-in and admits only restricted_v1", () => {
    expect(parseOpenCodeProxyPermissionProfile(undefined)).toBeUndefined();
    expect(parseOpenCodeProxyPermissionProfile(" ")).toBeUndefined();
    expect(parseOpenCodeProxyPermissionProfile("restricted_v1")).toBe(
      "restricted_v1",
    );
    expect(() => parseOpenCodeProxyPermissionProfile("restricted")).toThrow(
      "PAPERCLIP_OPENCODE_PERMISSION_PROFILE is invalid",
    );
  });
});

describe("OpenCode runnerd proxy permission settlement", () => {
  const decision = {
    action: "permission_decision",
    decision: "once",
    contractSha256: "a".repeat(64),
  };

  it("passes the runnerd resolution through unchanged", async () => {
    const resolved: unknown[] = [];
    await settleOpenCodeProxyPermissionRequest({
      ask: async () => ({ resolution: decision }),
      resolve: async (resolution) => {
        resolved.push(resolution);
      },
      isPending: () => true,
    });
    expect(resolved).toEqual([decision]);
  });

  it("treats a JSON-RPC error reply as cancel instead of crashing", async () => {
    const resolved: unknown[] = [];
    await settleOpenCodeProxyPermissionRequest({
      ask: async () => {
        throw new Error('{"code":-32000,"message":"denied"}');
      },
      resolve: async (resolution) => {
        resolved.push(resolution);
      },
      isPending: () => true,
    });
    expect(resolved).toEqual([{ action: "cancel" }]);
  });

  it("falls back to cancel when the driver rejects the resolution shape", async () => {
    const resolved: unknown[] = [];
    let pending = true;
    await settleOpenCodeProxyPermissionRequest({
      ask: async () => ({ resolution: { action: "accept_for_session" } }),
      resolve: async (resolution) => {
        if (resolution.action !== "cancel") throw new Error("invalid");
        resolved.push(resolution);
        pending = false;
      },
      isPending: () => pending,
    });
    expect(resolved).toEqual([{ action: "cancel" }]);
  });
});
