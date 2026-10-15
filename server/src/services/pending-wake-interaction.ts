import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, type Db } from "@paperclipai/db";

/** Read the same task-scoped wait used by dependency recovery. No wake key is written. */
export async function findPendingWakeInteraction(db: Db, companyId: string, issueId: string) {
  return db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.continuationPolicy, [
          "wake_assignee",
          "wake_assignee_on_accept",
        ]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Only the restored-blocked route uses this race guard. A response committed
 * before the PATCH may not have a wake receipt yet. Allow a 30-second dispatch
 * grace from resolvedAt, not an indefinite wait for a receipt that may never
 * exist (e.g. resolution while unassigned). Correlate receipts across assignees;
 * only a queued/running continuation for the current assignee should suppress
 * its wake. Completed historical continuations must not hide independent work.
 */
export async function findRestoredBlockedInteractionContinuation(
  db: Db,
  companyId: string,
  issueId: string,
  agentId: string,
) {
  return db.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
      or(
        eq(issueThreadInteractions.continuationPolicy, "wake_assignee"),
        and(
          eq(issueThreadInteractions.continuationPolicy, "wake_assignee_on_accept"),
          inArray(issueThreadInteractions.status, ["accepted", "answered"]),
        ),
      ),
      or(
        and(
          sql`${issueThreadInteractions.resolvedAt} >= now() - interval '30 seconds'`,
          sql`not exists (
            select 1 from ${agentWakeupRequests}
            where ${agentWakeupRequests.companyId} = ${companyId}
              and ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
              and ${agentWakeupRequests.payload} ->> 'interactionId' = ${issueThreadInteractions.id}::text
          )`,
        ),
        sql`exists (
          select 1 from ${agentWakeupRequests}
          where ${agentWakeupRequests.companyId} = ${companyId}
            and ${agentWakeupRequests.agentId} = ${agentId}
            and ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
            and ${agentWakeupRequests.payload} ->> 'interactionId' = ${issueThreadInteractions.id}::text
            and (
              ${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')
              or exists (
                select 1 from ${heartbeatRuns}
                where ${heartbeatRuns.id} = ${agentWakeupRequests.runId}
                  and ${heartbeatRuns.companyId} = ${companyId}
                  and ${heartbeatRuns.agentId} = ${agentId}
                  and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
              )
            )
        )`,
      ),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
