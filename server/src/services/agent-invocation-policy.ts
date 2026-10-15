/**
 * Opt-in "inert / manual-only" agent policy (TAX-452).
 *
 * The policy is persisted in the agent `permissions` record, which only the
 * board can change for an agent carrying it. Nothing here changes the default
 * behaviour of agents that do not opt in.
 *
 * - `invocationPolicy.mode === "manual_only"`: the agent runs only from an
 *   explicit, authenticated human invocation (`manualUserWake`). Assignment,
 *   comment, mention, dependency, recovery, monitor, timer and automation wakes
 *   are recorded as skipped and never execute.
 * - `authorizationPolicy.protectedAgent.blockAssignment === true`: work and
 *   routines cannot be assigned to the agent through any service path.
 */

export const MANUAL_ONLY_INVOCATION_MODE = "manual_only" as const;
export const MANUAL_ONLY_SKIP_REASON = "agent.manual_only" as const;
export const INERT_AGENT_BLOCK_REASON =
  "Inert manual-only agent: work cannot be assigned to it." as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function agentInvocationIsManualOnly(permissions: unknown): boolean {
  return (
    asRecord(asRecord(permissions)?.invocationPolicy)?.mode ===
    MANUAL_ONLY_INVOCATION_MODE
  );
}

export function agentAssignmentIsBlocked(permissions: unknown): boolean {
  const protectedAgent = asRecord(
    asRecord(asRecord(permissions)?.authorizationPolicy)?.protectedAgent,
  );
  return protectedAgent?.blockAssignment === true;
}

/**
 * Hard, actor-independent assignment lock. It only applies to agents that
 * opted into the manual-only policy, so existing agents that merely carry
 * `protectedAgent.blockAssignment` keep their current (board-bypassable)
 * authorization semantics.
 */
export function agentAssignmentIsHardLocked(permissions: unknown): boolean {
  return (
    agentInvocationIsManualOnly(permissions) &&
    agentAssignmentIsBlocked(permissions)
  );
}

/** Permissions persisted for an agent created with `inert: true`. */
export function inertAgentPermissions(
  requested: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = asRecord(requested) ?? {};
  const authorizationPolicy = asRecord(base.authorizationPolicy) ?? {};
  const protectedAgent = asRecord(authorizationPolicy.protectedAgent) ?? {};
  return {
    ...base,
    canCreateAgents: false,
    canCreateSkills: false,
    authorizationPolicy: {
      ...authorizationPolicy,
      protectedAgent: {
        ...protectedAgent,
        blockAssignment: true,
        blockReason: INERT_AGENT_BLOCK_REASON,
      },
    },
    invocationPolicy: { mode: MANUAL_ONLY_INVOCATION_MODE },
  };
}

/** Runtime config persisted for an agent created with `inert: true`. */
export function inertAgentRuntimeConfig(
  requested: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = asRecord(requested) ?? {};
  const heartbeat = asRecord(base.heartbeat) ?? {};
  return {
    ...base,
    heartbeat: {
      ...heartbeat,
      enabled: false,
      wakeOnDemand: false,
      // Aliases read by heartbeat-policy; force them off so none can re-enable
      // automatic wakes.
      wakeOnAssignment: false,
      wakeOnOnDemand: false,
      wakeOnAutomation: false,
    },
  };
}

/**
 * Keep the persisted inert locks when the board rewrites permissions. The
 * PATCH body replaces `authorizationPolicy` wholesale; without this an update
 * could silently drop the assignment block or the manual-only gate.
 */
export function preserveInertLocks(
  existing: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!agentInvocationIsManualOnly(existing)) return next;
  const locked = inertAgentPermissions(next);
  return {
    ...locked,
    // The board may still choose these explicitly after creation.
    canCreateAgents: next.canCreateAgents === true,
    canCreateSkills: next.canCreateSkills === true,
  };
}
