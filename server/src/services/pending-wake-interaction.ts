import { and, eq, inArray } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";

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
