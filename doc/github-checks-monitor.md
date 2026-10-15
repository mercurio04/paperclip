# GitHub checks monitor

The opt-in `github_checks` issue monitor polls GitHub.com without an agent run.
Set `PAPERCLIP_GITHUB_CHECKS_MONITOR_ENABLED=true` on the server to enable it.
The default is off. With the switch off, the typed monitor uses the existing
one-shot external-service path. Existing `external_service` monitors do not change.

The monitor uses this policy shape:

```json
{
  "kind": "github_checks",
  "repo": "example/project",
  "prNumber": 4,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedChecks": ["build", "test"],
  "intervalMinutes": 5,
  "nextCheckAt": "2026-10-15T12:00:00Z",
  "timeoutAt": "2026-10-15T14:00:00Z",
  "maxAttempts": 10
}
```

Use the normal issue API and its existing assignment, status, company and
execution-policy permissions. All target fields, the interval and both existing
bounds are required. This feature adds no permission or connection grant.
The server calls `gh api --hostname github.com --method GET` with the service
user's inherited environment. It uses the existing host session. It does not
extract, save or log authentication data. Operators must supply an existing
working `gh` installation and session. The server does not run `gh auth`.

One poll counts as one attempt, including a query error or process crash.
A poll reads PR metadata, check runs and legacy status contexts for the exact
configured SHA. Pagination is bounded. A malformed or truncated response is an
error. The latest run for each check name and app, and the latest status for
each context, are used. All matching apps must succeed for an all-green result.
Only `success` is green. Neutral and skipped results require an agent decision.
A missing expected check with no other running expected checks also requires
an agent decision. No checks is a missing-check event.

A waiting poll saves its digest in server-owned `issues.monitor_probe_state`.
Issue detail, list, mutation and conversation responses omit `monitorProbeState`.
This includes recovery resolutions (also replays) and issues embedded in pipeline
case details, conversation sources and issue links. Type annotations alone do not
remove the private field; those raw-row responses apply the public projection.
Diagnostics and portable exports use public field projections. The existing
monitor schedule fields and structured `githubChecks` wake payload remain public.
The scheduler reads the private column directly; API reads do not clear it.
It updates the policy/state schedule and attempt projection together. The first
interval is the declared interval, clamped to 5–30 minutes. Later waiting polls
multiply it by 1.5, up to 30 minutes. The next poll never exceeds `timeoutAt`.
The bounds never increase. Exhaustion uses the existing clear-and-recover path.
If a poll starts within the deadline and finishes after it, an observed failure,
changed HEAD, closed PR or all-green completion is preserved in the result wake.
Errors and non-decisive results still use deadline recovery. No extra attempt or
later poll is permitted by this rule.

The server emits one structured `githubChecks` wake payload for a changed HEAD,
a closed or merged PR, a failed/cancelled/timed-out/action-required check, all
expected terminal checks, or missing expected checks after the rest finish.
The normal one-shot dispatch removes the schedule. A result does not authorize
merge, deploy or replacement of independent QA.

HTTP 401, HTTP 403 without rate limiting, and HTTP 404 wake immediately with
`probeError`. Network errors, HTTP 429, rate-limited HTTP 403, HTTP 5xx and invalid
responses use backoff. Three consecutive errors wake with `probeError`.
A successful poll resets the consecutive error counter. Raw `gh` output is not
included in errors, the database, agent payloads or logs.

The existing claim is reclaimed after five minutes. The scheduler takes the claim
in a short transaction. Typed polls reserve their attempt once per claim with an
atomic update. No transaction or reserved pool connection spans GitHub I/O.
CAS writes match the claim timestamp, schedule, target policy, owner and eligible status. Each API
request rechecks the claim. Cancellation cannot undo an API request already in
flight, but prevents later requests and result persistence. A pending event is
saved before delivery. After a crash, the next claim reuses it and checks the
existing `issue-monitor:{id}:{scheduledAt}` receipt before delivery. Wake admission
rechecks both the claim and the receipt under its existing issue lock.
An explicit new schedule resets the server-owned probe history. No additional
poll runs for a cleared monitor or a closed task.

Migration 0280 adds one nullable JSONB column with `IF NOT EXISTS`. It does not
rewrite existing rows or change table owners. Rollback: turn off the switch,
then revert the code. The additive column can remain unused. Enabling the
feature or deploying the server requires a separate operator decision.

## Local verification

Run from a disposable checkout with Node 24.11+ and pnpm 9.15.4:

```sh
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server typecheck
pnpm exec vitest run server/src/__tests__/github-checks-probe.test.ts server/src/__tests__/issue-monitor-scheduler.test.ts server/src/__tests__/github-checks-monitor-pool.test.ts --maxWorkers=1
pnpm build
```

Keep `PAPERCLIP_HOME`, temporary directories and XDG state paths isolated.
The scheduler tests use embedded disposable Postgres and a fake `gh` in PATH.
The fake accepts only GET. No GitHub credential is needed. The restart case
stops and starts two distinct loopback server processes with the real heartbeat
service against the same disposable database. It does not restart the installed
service or start the complete application HTTP/auth stack.

For E2E inspection, run the named `G2 no change` test and check zero wake and run
rows, an incremented attempt and the new schedule. Then run the `G2 green` case
and check one wake with the exact SHA and no later API request. Run `G2 real
process restart` to prove that a new server process uses the persisted schedule.
These fixtures prove local behavior. They do not prove live GitHub access,
external compatibility, required remote CI, a production rollout or savings.

The pool regression suite runs the production probe module in disposable child
processes with pool sizes 1, 2 and 3, N concurrent slow probes and repeated
invocations of the same claim. It checks `pg_stat_activity` during an in-flight
request and checks durable reservation after a process crash. Delivery in that
fixture uses a receipt callback; the scheduler suite tests real wake admission,
concurrent receipts, five-minute reclaim, and all deadline outcomes. Existing
external-service tests remain the control. This does not change or certify the
legacy wake-enqueue path's minimum pool capacity.
