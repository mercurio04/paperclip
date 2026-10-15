export type OpenCodeProxyPermissionMode = "allow" | "ask" | "deny";

export function parseOpenCodeProxyPermissionMode(
  value: string | undefined,
): OpenCodeProxyPermissionMode {
  const configured = value?.trim();
  if (!configured) return "ask";
  if (
    configured === "allow"
    || configured === "ask"
    || configured === "deny"
  ) {
    return configured;
  }
  throw new Error("PAPERCLIP_OPENCODE_PERMISSION_MODE is invalid");
}

export type OpenCodeProxyPermissionProfile = "restricted_v1";

/**
 * `PAPERCLIP_OPENCODE_PERMISSION_PROFILE` opts a run into the typed TAX-452
 * permission bridge. Unset keeps the legacy behavior; any other value fails
 * closed instead of silently running without the profile.
 */
export function parseOpenCodeProxyPermissionProfile(
  value: string | undefined,
): OpenCodeProxyPermissionProfile | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  if (configured === "restricted_v1") return configured;
  throw new Error("PAPERCLIP_OPENCODE_PERMISSION_PROFILE is invalid");
}

/**
 * `PAPERCLIP_OPENCODE_PERMISSION_TTL_MS` bounds how long a typed permission
 * stays pending (restricted_v1). Unset keeps the driver default; anything but
 * a positive integer of at most 24h fails closed.
 */
export function parseOpenCodeProxyPermissionTtlMs(
  value: string | undefined,
): number | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  const parsed = /^[1-9][0-9]{0,8}$/.test(configured) ? Number(configured) : NaN;
  if (Number.isSafeInteger(parsed) && parsed <= 24 * 60 * 60_000) return parsed;
  throw new Error("PAPERCLIP_OPENCODE_PERMISSION_TTL_MS is invalid");
}

/**
 * Settles the controller's answer to a `paperclip/runtimeRequest` for a
 * permission. The runnerd resolution passes through unchanged; a JSON-RPC
 * error (or a missing resolution) becomes `cancel`, which the driver turns
 * into a native `reject`, instead of crashing the proxy.
 */
export async function settleOpenCodeProxyPermissionRequest(input: {
  ask(): Promise<unknown>;
  resolve(resolution: Record<string, unknown>): Promise<void>;
  isPending(): boolean;
  onFallback?(reason: string): void;
}): Promise<void> {
  let resolution: Record<string, unknown> | null = null;
  try {
    const response = await input.ask();
    const candidate =
      typeof response === "object" && response !== null && !Array.isArray(response)
        ? (response as Record<string, unknown>).resolution
        : undefined;
    if (
      typeof candidate === "object"
      && candidate !== null
      && !Array.isArray(candidate)
    ) {
      resolution = candidate as Record<string, unknown>;
    } else {
      input.onFallback?.("runtime request answer carried no resolution");
    }
  } catch (error) {
    input.onFallback?.(
      `runtime request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (resolution !== null) {
    try {
      await input.resolve(resolution);
      return;
    } catch (error) {
      // An invalid resolution is rejected before any native reply is sent.
      if (!input.isPending()) throw error;
      input.onFallback?.(
        `runtime request resolution was rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (input.isPending()) await input.resolve({ action: "cancel" });
}
