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

## Cases

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
