/**
 * Human-invocation task binding for opt-in manual-only agents (TAX-452 H6).
 *
 * A manual-only agent can never be an issue assignee. An authenticated board
 * user may still run it in a task by naming that task in the explicit manual
 * wake. Where the native control plane would otherwise require "the run's
 * agent is the issue assignee", it accepts this binding instead, and only
 * when every persisted fact agrees:
 *
 * - the run belongs to the agent and its persisted context names this issue
 *   in `manualInvocation.issueId`;
 * - the agent still carries `invocationPolicy.mode = "manual_only"`;
 * - the run's wake receipt is a `manualUserWake` requested by an authenticated
 *   user, the same user recorded in `manualInvocation.userId`;
 * - no agent is the issue assignee (the binding never overrides ownership).
 *
 * Nothing here applies to agents that did not opt in.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function manualOnlyHumanBindingSql(input: {
  readonly runId: string | AnyPgColumn | SQL;
  readonly agentId: string | AnyPgColumn | SQL;
  readonly issueId: string | AnyPgColumn | SQL;
  readonly issueAssigneeAgentId: AnyPgColumn;
}): SQL {
  return sql`(${input.issueAssigneeAgentId} is null and exists (
    select 1
      from heartbeat_runs mib_run
      join agents mib_agent
        on mib_agent.id = mib_run.agent_id
       and mib_agent.company_id = mib_run.company_id
      join agent_wakeup_requests mib_wake
        on mib_wake.id = mib_run.wakeup_request_id
       and mib_wake.company_id = mib_run.company_id
     where mib_run.id = ${input.runId}
       and mib_run.agent_id = ${input.agentId}
       and mib_run.context_snapshot -> 'manualInvocation' ->> 'issueId' = (${input.issueId})::text
       and mib_agent.permissions -> 'invocationPolicy' ->> 'mode' = 'manual_only'
       and mib_wake.payload ->> 'manualUserWake' = 'true'
       and mib_wake.requested_by_actor_type = 'user'
       and mib_wake.requested_by_actor_id is not null
       and mib_wake.requested_by_actor_id = mib_run.context_snapshot -> 'manualInvocation' ->> 'userId'
  ))`;
}
