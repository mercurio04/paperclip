import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isRestrictedV1ApprovablePermissionTool,
  RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS,
} from "../contracts/harness-driver.js";
import { permissionContractSha256 } from "../drivers/opencode/opencode-server-driver.js";

/**
 * TAX-452 cross-language parity: the Rust runnerd tests
 * (`accepts_the_canonical_typed_opencode_permission_contract`) validate this
 * same fixture's `contractSha256` and `canonicalContractJson`. The TS driver
 * and the server must produce the exact same values.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../protocol/fixtures/permissions/opencode-permission-request.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  canonicalContractJson: string;
  restrictedApprovablePermissionTools: Record<string, string[]>;
  request: { permission: Record<string, unknown> & { contractSha256: string } };
};

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      const source = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source).sort().map((key) => [key, sort(source[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(sort(value));
}

describe("OpenCode permission contract hash parity (TS driver / Rust runnerd / server)", () => {
  const { contractSha256, ...unsigned } = fixture.request.permission;

  it("matches the fixture contractSha256 the Rust tests assert", () => {
    expect(contractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(permissionContractSha256(fixture.request.permission)).toBe(
      contractSha256,
    );
  });

  it("uses the same canonical JSON bytes as the Rust canonical_json", () => {
    expect(canonicalJson(unsigned)).toBe(fixture.canonicalContractJson);
    expect(
      createHash("sha256")
        .update(fixture.canonicalContractJson, "utf8")
        .digest("hex"),
    ).toBe(contractSha256);
  });

  it("pins the restricted_v1 (permission, tool) allowlist shared with Rust and the server", () => {
    const normalized = Object.fromEntries(
      Object.entries(RESTRICTED_V1_APPROVABLE_PERMISSION_TOOLS).map(
        ([permission, tools]) => [permission, [...tools].sort()],
      ),
    );
    expect(normalized).toEqual(fixture.restrictedApprovablePermissionTools);
    const frozen = fixture.request.permission as unknown as {
      permission: string;
      tool: { name: string; messageId: string; callId: string };
      arguments: Record<string, unknown>;
    };
    expect(Object.keys(frozen.tool).sort()).toEqual([
      "callId",
      "messageId",
      "name",
    ]);
    expect(
      isRestrictedV1ApprovablePermissionTool(frozen.permission, frozen.tool.name),
    ).toBe(true);
    expect(isRestrictedV1ApprovablePermissionTool("edit", "bash")).toBe(false);
    expect(isRestrictedV1ApprovablePermissionTool("bash", "bash")).toBe(false);
    expect(isRestrictedV1ApprovablePermissionTool("list", "list")).toBe(false);
    expect(isRestrictedV1ApprovablePermissionTool("toString", "toString")).toBe(
      false,
    );
  });
});
