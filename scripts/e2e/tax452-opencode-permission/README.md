# TAX-452 isolated E2E: OpenCode permission bridge + inert manual-only agent

Credential-free, zero-egress end-to-end check of the `restricted_v1` OpenCode
profile and the typed `once`/`reject` permission decision, plus the inert
(manual-only) agent gates. It never contacts a real model or a real instance.

## What runs

- New user, network, mount and PID namespaces (`unshare`): loopback only,
  private tmpfs `/tmp` (the embedded Postgres socket/lock live there), and
  every leftover process dies with the namespace.
- A throwaway Paperclip server (`tsx server/src/index.ts`) with its own HOME,
  `PAPERCLIP_HOME`, instance id `e2e-tax452`, embedded Postgres and
  `local_trusted` loopback board actor.
- Real `paperclip-runnerd` (release build) and real OpenCode 1.18.29 from the
  pinned dependency, using `opencodePermissionProfile: "restricted_v1"`.
- A deterministic OpenAI-compatible fixture provider on `127.0.0.1:47301`
  whose only tool call is an OpenCode `write` of a relative marker file
  `e2e-tick-<call>.txt` inside the run workspace (the counter is the number of
  marker files). restricted_v1 denies bash/webfetch/task, so a file write is
  the innocuous action that still asks for permission.

## Prerequisites

```sh
cargo build --release --manifest-path packages/paperclip-runner/runner/Cargo.toml \
  --locked -p paperclip-runner-core --bin paperclip-runnerd
pnpm --filter @paperclipai/paperclip-runner build:typescript   # includes the bundled .cjs proxy
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
```

A stale `dist/cli/opencode-app-server-proxy.cjs` silently drops the profile
(OpenCode then fails with `"undefined/chat/completions"`): rebuild it.

## Run

```sh
scripts/e2e/tax452-opencode-permission/run.sh [OUT_DIR]   # default .e2e/runs/<utc>
```

Exit 0 only if every case passes. `OUT_DIR/receipt.json` holds the git SHA,
OpenCode/runnerd digests, sanitized config, IDs, per-case expected/observed,
fixture request log, run events, durable claims, activity rows and cleanup.
On failure the instance directories are kept for diagnosis.

## Cases (baseline)

Inert agent: paused, manual-only policy, no grants/memberships, assignment 409
(create and patch), wakes 409 while paused, agent-actor wakes skipped with
`agent.manual_only` after a human resume, including an agent wake naming a
task; a human invocation naming another company's task 404s. Permission
bridge on the SAME inert agent (TAX-452 H6): each run starts from an
explicit board wake (`POST /agents/:id/wakeup` with `payload.issueId`) that
binds the task without assigning it; typed contract, sha mismatch 409, `always` and
`accept_for_session` 400, agent actor 403, unknown request 409, double click
202/409, once → counter 0→1, second action asks again, cross-request sha 409,
reject leaves the counter unchanged, cross-run 409, reject on first action →
counter 0, exactly one delivered durable claim per request. Afterwards: both
runs belong to the inert agent with a user manual-wake receipt and a
`heartbeat.invoked` activity row naming the invoking user and task; the tasks
were never assigned, assignment is still 409 and the persisted locks are
unchanged.

An `OUT_DIR` under `/tmp` is bind-mounted across the private tmpfs so the
receipt survives on the host.

## Adversarial cases (TAX-474 inherited rows, `adv.*` / `auth.*`)

Runs are strictly serial; the fixture switches scenario between runs.

- `adv.lost_reply.*`: `once` sent on a raw socket that is destroyed unread
  once the durable claim settles (HTTP reply lost after delivery); the retry
  must be 409, one delivered claim, counter 0→1 (never 2).
- `adv.cancel_then_once_409`: board cancel while a permission is pending,
  then `once` → 409 twice, 0 claims, counter 0.
  `adv.cancel.opencode_stopped`: the run's OpenCode must exit within 30s.
- `adv.deny.<surface>`: one run per surface, the fixture emits exactly one
  tool call — `bash`, `webfetch` (to the fixture), `task`,
  `paperclip_create_task`, an unknown tool, `write` to an absolute `/tmp`
  path, and `write` through a workspace symlink pointing to `/tmp`. Asserts
  no `runtime_request.created`, no claim, no file/network/Paperclip effect,
  and records the tool result OpenCode returned to the model plus driver
  diagnostics (the symlink case must carry the
  `permission_target_outside_workspace` notice).
- `adv.restart_{pending,claimed}.*`: SIGKILL of the server process group with
  a permission pending (and, for `claimed`, a `claimed` decision row written
  just before the kill: there is no production seam between the claim INSERT
  and the dispatch), restart on the same instance, `once` → 409 before and
  after reconciliation, no delivered `once`, counter 0, no new provider tool
  call. `*.orphan_processes_stopped`: the crashed run's runnerd/OpenCode must
  exit within 30s.
- `auth.*`: a second disposable instance (`<id>-auth`) in
  `authenticated/private`. Users via the real better-auth API
  (`/auth/sign-up/email`); the first claims via `POST /bootstrap/claim`
  (DEPLOYMENT-MODES.md §8) with session cookie + trusted Origin. Company
  memberships of the non-admin users are seeded in SQL (invite acceptance is
  out of scope). Probes: non-admin member 403, other-company user 404,
  signed-out admin session 403, admin with another run's sha 409, admin
  without Origin 403; then 0 claims, and the admin's reject is the single
  delivered claim.

## Inherited TAX-476 rows (`adv.cancel_once_race`, `adv.stale_*`, `adv.expiry.*`, `adv.internal_loss.*`)

- `adv.cancel_once_race.single_terminal_winner`: three runs, each firing
  board cancel and `once` together (`Promise.all`). Run terminal, late `once`
  409, counter <= 1 and unchanged after the terminal, claims consistent with
  the winner (a 409 decision leaves no delivered claim and counter 0).
  `native_permission_decisions.native_outcome` must agree with what OpenCode
  received: counter 1 (native `once`) => `once_applied`; counter 0 => never
  `once_applied`; a delivered `once` claim with counter 0 passes only if
  `native_outcome` is `rejected_*`; every delivered claim carries a non-null
  outcome (the proxy reports `paperclip/runtimeRequestSettled{status:"applied",
  nativeOutcome}` after the delivery, runnerd relays it as the diagnostic
  `permission_native_outcome`, the server records it first-write-wins and
  audits `heartbeat.runtime_permission_native_outcome`). A claim whose outcome
  was not observed before the run went terminal is reconciled ~4s after the
  board cancel: recovered from a committed `permission_native_outcome`, else
  moved to `dispatch_uncertain` (audited `heartbeat.runtime_permission_reconciled`,
  previousStatus `delivered`); the once-audit check uses that latest status.
  `TAX452_REQUIRE_NATIVE_OUTCOME=0` allows a null outcome (debug only).
- `adv.stale_cascaded_permission_409`: fixture scenario `parallel2` asks two
  writes in one model response, so two permissions are pending in the same
  turn. Reject #1; OpenCode cascade-rejects #2 natively; the proxy reports
  the settlement (`paperclip/runtimeRequestSettled`) and runnerd publishes
  `runtime_request.cancelled`, so `once` on #2 is 409 while the run is live
  and after the turn ended; counter 0.
- `adv.expiry.permission_expired_409`: the server is restarted with
  `PAPERCLIP_OPENCODE_PERMISSION_TTL_MS=8000` (server env -> runnerd
  sanitized env allowlist -> Rust `OPENCODE_PROVIDER_ENVIRONMENT_KEYS` ->
  proxy -> driver `permissionTtlMs`, default 15 min). The undecided
  permission is rejected natively once, `runtime_request.expired`
  (`permission_expired`) is published, a later `once` is 409, 0 claims, no
  re-prompt.
- `adv.internal_loss.no_reexecution`: needs a second runnerd built with the
  non-default Cargo feature `e2e-fault-injection`:

  ```sh
  cargo build --release -j2 -p paperclip-runner-core --bin paperclip-runnerd --features e2e-fault-injection
  mkdir -p target/e2e-fault && cp target/release/paperclip-runnerd target/e2e-fault/
  cargo build --release -j2 -p paperclip-runner-core --bin paperclip-runnerd   # restore the default binary
  strings target/release/paperclip-runnerd | grep -c crash-after-permission    # must be 0
  ```

  The server is restarted on that binary; with
  `/tmp/paperclip-e2e-fault/crash-after-permission-delivery` present (the
  namespace's private tmpfs) runnerd aborts right after writing the `once` to
  the proxy and before the `request.resolve` result is acknowledged. Then the
  server is restarted on the default binary. Expected: one claim, never
  `delivered`, `dispatch_uncertain`; retries 409; counter <= 1 and unchanged;
  no new provider tool call.

Cases recorded with `defectIfFailed` describe a known product defect when
they fail; they are not waived. `ns-inner.sh` keeps bash as PID 1 of the
namespace so orphans (e.g. a SIGKILLed postmaster) are reaped; with node as
PID 1 a zombie postmaster made the restarted server refuse to start.
