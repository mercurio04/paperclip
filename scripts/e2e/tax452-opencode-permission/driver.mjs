// TAX-452 isolated E2E driver. Runs inside the namespaces set up by run.sh:
// loopback only, private /tmp, unprivileged uid. It never reads the host
// Paperclip instance: every path below lives under OUT.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import { join } from "node:path";

const [ROOT, OUT] = process.argv.slice(2);
const SERVER_PORT = 47200;
const FIXTURE_PORT = 47301;
const PG_PORT = 54329; // inside the private netns; cannot reach the host one
const MODEL_ID = "e2e-fixture";
// Counter: one marker file per allowed write inside the workspace. A file
// write (OpenCode `write`, permission `edit`) stays valid under restricted_v1,
// which denies bash/webfetch/task; distinct files avoid OpenCode's
// read-before-overwrite guard on the second action.
const COUNTER_PREFIX = "e2e-tick-";
const API = `http://127.0.0.1:${SERVER_PORT}/api`;
const HOME = join(OUT, "home");
const PCHOME = join(OUT, "pchome");
const INSTANCE = "e2e-tax452";
const RUNNERD = join(ROOT, "packages/paperclip-runner/runner/target/release/paperclip-runnerd");

const receipt = {
  schema: "tax452.e2e.receipt.v1",
  startedAt: new Date().toISOString(),
  environment: {},
  versions: {},
  config: {},
  ids: {},
  cases: [],
  fixture: { requests: [] },
  events: {},
  cleanup: {},
};
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  fs.appendFileSync(join(OUT, "driver.log"), line + "\n");
  process.stdout.write(line + "\n");
};
const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(name, expected, observed, pass, extra = {}) {
  receipt.cases.push({ name, expected, observed, pass: Boolean(pass), ...extra });
  log(pass ? "PASS" : "FAIL", name, observed);
}

// ---------------------------------------------------------------- fixture
// Deterministic OpenAI-compatible provider. Main-agent requests (with tools):
// no tool result yet -> write call #1; one non-rejected tool result -> write
// call #2; otherwise a final text. Requests without tools (titles) -> text.
// Both writes target a relative path inside the run workspace.
const WRITE_TOOL = "write";
function fixtureDecision(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name) : [];
  const toolResults = messages.filter((m) => m.role === "tool");
  const last = toolResults.at(-1);
  const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const rejected = /reject|denied|not allowed|permission/i.test(lastText);
  let action;
  if (!tools.includes(WRITE_TOOL)) action = { kind: "text", text: "E2E fixture" };
  else if (toolResults.length === 0) action = { kind: "tool", id: "call_e2e_1" };
  else if (toolResults.length === 1 && !rejected) action = { kind: "tool", id: "call_e2e_2" };
  else action = { kind: "text", text: "E2E fixture done." };
  receipt.fixture.requests.push({
    at: new Date().toISOString(),
    stream: body.stream === true,
    messageCount: messages.length,
    toolCount: tools.length,
    toolResults: toolResults.length,
    lastToolResultRejected: toolResults.length ? rejected : null,
    action: action.kind === "tool" ? `${WRITE_TOOL}:${action.id}` : "text",
  });
  return action;
}
function chunk(delta, finish = null, usage) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}
const fixture = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      receipt.fixture.requests.push({ at: new Date().toISOString(), unexpected: `${req.method} ${req.url}` });
      res.writeHead(404);
      return res.end();
    }
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const action = fixtureDecision(body);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const call = action.kind === "tool"
      ? { index: 0, id: action.id, type: "function", function: { name: WRITE_TOOL, arguments: JSON.stringify({ filePath: `${COUNTER_PREFIX}${action.id}.txt`, content: "tick\n" }) } }
      : null;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant" }));
      if (call) {
        res.write(chunk({ tool_calls: [call] }));
        res.write(chunk({}, "tool_calls", usage));
      } else {
        res.write(chunk({ content: action.text }));
        res.write(chunk({}, "stop", usage));
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-e2e", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL_ID,
      choices: [{ index: 0, finish_reason: call ? "tool_calls" : "stop", message: call ? { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }] } : { role: "assistant", content: action.text } }],
      usage,
    }));
  });
});

// ------------------------------------------------------------------- http
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 500) };
}
async function must(method, path, body) {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${r.text}`);
  return r.json;
}

function egressProbe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    s.on("connect", () => { s.destroy(); resolve("CONNECTED"); });
    s.on("timeout", () => { s.destroy(); resolve("timeout"); });
    s.on("error", (e) => resolve(e.code ?? String(e)));
  });
}

let server = null;
let pgSql = null;

async function waitFor(fn, label, timeoutMs = 180_000, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    if (server && server.exitCode !== null) throw new Error(`server exited while waiting for ${label}`);
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function runEvents(runId) {
  const r = await api("GET", `/heartbeat-runs/${runId}/events?afterSeq=0&limit=1000`);
  return Array.isArray(r.json) ? r.json : [];
}
function eventPayload(e) {
  const p = e.payload ?? {};
  return p.prpEvent?.payload ?? p;
}
function pendingPermissions(events) {
  const created = new Map();
  for (const e of events) {
    const t = e.eventType ?? e.type;
    const p = eventPayload(e);
    const req = p.request ?? null;
    if (t === "runtime_request.created" && req?.type === "permission") created.set(req.requestId, req);
    if (typeof t === "string" && t.startsWith("runtime_request.") && t !== "runtime_request.created") {
      created.delete(p.requestId ?? req?.requestId);
    }
  }
  return [...created.values()];
}
function counterFiles(cwd) {
  try { return fs.readdirSync(cwd).filter((f) => f.startsWith(COUNTER_PREFIX)); } catch { return []; }
}
function counterValue(cwd) {
  return counterFiles(cwd).length;
}
async function runFailure(runId) {
  const row = (await pgSql`select status, error_code, error from heartbeat_runs where id = ${runId}`)[0];
  const events = summarizeEvents(await runEvents(runId)).slice(-15);
  const raw = (await runEvents(runId)).filter((e) => /fail|diagnostic|error|stderr|log|harness/i.test(`${e.eventType ?? e.type} ${e.payload?.code ?? ""}`)).slice(-12).map((e) => ({ type: e.eventType ?? e.type, payload: JSON.stringify(e.payload ?? {}).slice(0, 900) }));
  return { row, events, raw };
}
async function runStatus(runId) {
  return (await api("GET", `/heartbeat-runs/${runId}`)).json?.status ?? null;
}
async function waitTerminal(runId, timeoutMs = 120_000) {
  return waitFor(async () => {
    const s = await runStatus(runId);
    return s && !["queued", "running"].includes(s) ? s : null;
  }, `run ${runId} terminal`, timeoutMs);
}
function summarizeEvents(events) {
  return events.map((e) => {
    const p = eventPayload(e);
    const req = p.request ?? {};
    return {
      seq: e.seq,
      type: e.eventType ?? e.type,
      at: e.createdAt,
      requestId: p.requestId ?? req.requestId,
      requestType: req.type,
      contractSha256: req.permission?.contractSha256 ?? p.response?.contractSha256 ?? p.resolution?.contractSha256,
      decision: p.response?.decision ?? p.resolution?.decision,
      code: p.code ?? p.diagnostic?.code,
    };
  }).filter((e) => e.type && !/^(log|output|stdout|stderr|text_delta)/.test(e.type));
}

async function main() {
  for (const d of [HOME, PCHOME]) fs.mkdirSync(d, { recursive: true });
  receipt.environment = {
    uidInNamespace: process.getuid(),
    netns: fs.readlinkSync("/proc/self/ns/net"),
    mntns: fs.readlinkSync("/proc/self/ns/mnt"),
    egressProbe1111: await egressProbe(),
    tmp: execFileSync("sh", ["-c", "df -h /tmp | tail -1"]).toString().trim(),
    interfaces: execFileSync("ip", ["-o", "link"]).toString().split("\n").filter(Boolean).map((l) => l.split(":")[1].trim()),
  };
  record("isolation.zero_egress", "connect to 1.1.1.1:443 fails", receipt.environment.egressProbe1111, receipt.environment.egressProbe1111 !== "CONNECTED");
  const ocBin = join(ROOT, "node_modules/.pnpm/opencode-linux-x64@1.18.29/node_modules/opencode-linux-x64/bin/opencode");
  receipt.versions = {
    gitHead: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"]).toString().trim(),
    gitDirty: execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"]).toString().trim() || null,
    node: process.version,
    opencode: execFileSync(ocBin, ["--version"], { env: { PATH: process.env.PATH, HOME } }).toString().trim(),
    opencodeBinarySha256: sha256File(ocBin),
    runnerdSha256: sha256File(RUNNERD),
    paperclipServerVersion: JSON.parse(fs.readFileSync(join(ROOT, "server/package.json"), "utf8")).version,
  };

  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const serverEnv = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME,
    XDG_CONFIG_HOME: join(HOME, ".config"),
    XDG_DATA_HOME: join(HOME, ".local/share"),
    XDG_STATE_HOME: join(HOME, ".local/state"),
    XDG_CACHE_HOME: join(HOME, ".cache"),
    PAPERCLIP_HOME: PCHOME,
    PAPERCLIP_INSTANCE_ID: INSTANCE,
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    PAPERCLIP_BIND_HOST: "127.0.0.1",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    SERVE_UI: "false",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_RUNNER_BINARY: RUNNERD,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_SHARE: "1",
  };
  receipt.config.serverEnv = Object.fromEntries(Object.entries(serverEnv).map(([k, v]) => [k, v.startsWith(OUT) ? v.replace(OUT, "$OUT") : v]));
  server = spawn(join(ROOT, "server/node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: join(ROOT, "server"),
    env: serverEnv,
    stdio: ["ignore", fs.openSync(join(OUT, "server.log"), "a"), fs.openSync(join(OUT, "server.log"), "a")],
    detached: true,
  });
  await waitFor(async () => (await api("GET", "/health").catch(() => ({ status: 0 }))).status === 200, "health", 300_000, 2000);
  log("server healthy");
  const require = createRequire(join(ROOT, "packages/db/package.json"));
  const postgres = require("postgres");
  pgSql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${PG_PORT}/paperclip`, { max: 2, onnotice: () => {} });

  await must("PATCH", "/instance/settings/experimental", { enableNativeRunner: true });
  const company = await must("POST", "/companies", { name: "E2E TAX-452" });
  receipt.ids.companyId = company.id;
  const adapterConfig = {
    provider: "opencode",
    model: `llamacpp/${MODEL_ID}`,
    opencodePermissionProfile: "restricted_v1",
    llamaCppBaseUrl: `http://127.0.0.1:${FIXTURE_PORT}/v1`,
  };
  receipt.config.adapterConfig = adapterConfig;
  const agentRes = await api("POST", `/companies/${company.id}/agents`, {
    name: "Bombero E2E", role: "engineer", adapterType: "paperclip_runner", adapterConfig, inert: true,
  });
  if (agentRes.status >= 400) throw new Error(`agent create ${agentRes.status} ${agentRes.text}`);
  const agent = agentRes.json;
  receipt.ids.agentId = agent.id;

  // ------------------------------------------------ inert / manual-only
  const a0 = await must("GET", `/agents/${agent.id}`);
  record("inert.status_paused", "paused", a0.status, a0.status === "paused");
  const perms = a0.permissions ?? {};
  receipt.config.inertPermissions = perms;
  record("inert.manual_only_policy", "invocationPolicy.mode=manual_only and blockAssignment=true",
    { mode: perms.invocationPolicy?.mode, blockAssignment: perms.authorizationPolicy?.protectedAgent?.blockAssignment, canCreateAgents: perms.canCreateAgents },
    perms.invocationPolicy?.mode === "manual_only" && perms.authorizationPolicy?.protectedAgent?.blockAssignment === true);
  const grants = await pgSql`select permission_key from principal_permission_grants where principal_type = 'agent' and principal_id = ${agent.id}`.catch((e) => ({ error: e.message }));
  const memberships = await pgSql`select id from company_memberships where principal_type = 'agent' and principal_id = ${agent.id}`.catch((e) => ({ error: e.message }));
  record("inert.no_grants", "0 permission grants and 0 memberships", { grants, memberships: memberships.length ?? memberships },
    Array.isArray(grants) && grants.length === 0 && Array.isArray(memberships) && memberships.length === 0);

  const assignCreate = await api("POST", `/companies/${company.id}/issues`, { title: "E2E assign attempt", assigneeAgentId: agent.id });
  record("inert.assignment_on_create_409", "409", { status: assignCreate.status, body: assignCreate.text.slice(0, 200) }, assignCreate.status === 409);
  const issue = await must("POST", `/companies/${company.id}/issues`, { title: "E2E TAX-452 permission bridge" });
  receipt.ids.issueId = issue.id;
  const assignPatch = await api("PATCH", `/issues/${issue.id}`, { assigneeAgentId: agent.id });
  record("inert.assignment_on_patch_409", "409", { status: assignPatch.status, body: assignPatch.text.slice(0, 200) }, assignPatch.status === 409);

  const pausedWakes = {};
  for (const source of ["timer", "assignment", "automation"]) {
    pausedWakes[source] = (await api("POST", `/agents/${agent.id}/wakeup`, { source })).status;
  }
  record("inert.paused_wakes_409", "409 for timer/assignment/automation while paused", pausedWakes, Object.values(pausedWakes).every((x) => x === 409));
  const pausedInvoke = await api("POST", `/agents/${agent.id}/heartbeat/invoke`, {});
  const runsAfterPausedInvoke = await pgSql`select count(*)::int as n from heartbeat_runs where agent_id = ${agent.id}`;
  record("inert.paused_invoke_does_not_run", "no run while paused", { status: pausedInvoke.status, body: pausedInvoke.json?.status ?? pausedInvoke.text.slice(0, 120), runs: runsAfterPausedInvoke[0].n },
    runsAfterPausedInvoke[0].n === 0);

  // Human gate: board resumes, then invokes manually.
  await must("POST", `/agents/${agent.id}/resume`, {});
  // Non-human wakes: the agent's own API key (actor type agent) cannot
  // satisfy the manual-only gate, whatever source it claims.
  const inertKey = await must("POST", `/agents/${agent.id}/keys`, { name: "e2e-self-wake" });
  const agentAuth = { authorization: `Bearer ${inertKey.token}` };
  const wakeResults = {};
  for (const source of ["timer", "assignment", "automation", "on_demand"]) {
    const r = await api("POST", `/agents/${agent.id}/wakeup`, { source }, agentAuth);
    wakeResults[source] = { status: r.status, body: r.json?.status ?? r.text.slice(0, 120) };
  }
  const selfInvoke = await api("POST", `/agents/${agent.id}/heartbeat/invoke`, {}, agentAuth);
  wakeResults.invoke = { status: selfInvoke.status, body: selfInvoke.json?.status ?? selfInvoke.text.slice(0, 120) };
  const skipped = await pgSql`select source, status, reason from agent_wakeup_requests where agent_id = ${agent.id} and requested_by_actor_type = 'agent' order by requested_at`;
  const runsBefore = await pgSql`select count(*)::int as n from heartbeat_runs where agent_id = ${agent.id}`;
  record("inert.non_human_wakes_skipped", "after human resume: every agent-actor wake (timer/assignment/automation/on_demand/invoke) skipped with reason agent.manual_only and 0 runs",
    { http: wakeResults, rows: skipped, runs: runsBefore[0].n },
    skipped.length >= 5 && skipped.every((w) => w.status === "skipped" && w.reason === "agent.manual_only") && runsBefore[0].n === 0);
  // Human invocation after the gate (TAX-452 H6): the board names the task in
  // the explicit manual wake. The SAME inert agent runs in that task context
  // without ever becoming its assignee; assignment stays a hard 409.
  const humanRuns = [];
  async function invokeAndGetRun(title) {
    const iss = await must("POST", `/companies/${company.id}/issues`, { title, status: "todo" });
    const r = await api("POST", `/agents/${agent.id}/wakeup`, { source: "on_demand", reason: "e2e_human_invocation", payload: { issueId: iss.id } });
    if (r.status !== 202 || !r.json?.id) throw new Error(`human invocation for ${title}: ${r.status} ${r.text}`);
    const run = (await pgSql`select id, status, agent_id, context_snapshot->'manualInvocation' as manual_invocation from heartbeat_runs where id = ${r.json.id}`)[0];
    const wake = (await pgSql`select requested_by_actor_type, requested_by_actor_id, payload->>'manualUserWake' as manual_user_wake, payload->>'issueId' as issue_id from agent_wakeup_requests where run_id = ${r.json.id}`)[0];
    const activity = (await pgSql`select actor_type, actor_id, details->'manualInvocation' as manual_invocation from activity_log where run_id = ${r.json.id} and action = 'heartbeat.invoked'`)[0];
    humanRuns.push({ title, http: r.status, issueId: iss.id, run, wake, activity });
    return { issue: iss, run };
  }
  // Agent-actor wakes that name a task are still skipped (no run, no binding).
  const issueProbe = await must("POST", `/companies/${company.id}/issues`, { title: "E2E agent self-wake probe", status: "todo" });
  const selfBound = await api("POST", `/agents/${agent.id}/wakeup`, { source: "on_demand", payload: { issueId: issueProbe.id } }, agentAuth);
  const selfBoundRuns = await pgSql`select count(*)::int as n from heartbeat_runs where agent_id = ${agent.id}`;
  const selfBoundRow = (await pgSql`select status, reason from agent_wakeup_requests where agent_id = ${agent.id} and requested_by_actor_type = 'agent' order by requested_at desc limit 1`)[0];
  record("inert.agent_task_bound_wake_skipped", "agent-actor wake naming a task: skipped agent.manual_only, 0 runs",
    { http: selfBound.status, row: selfBoundRow, runs: selfBoundRuns[0].n },
    selfBoundRow?.status === "skipped" && selfBoundRow?.reason === "agent.manual_only" && selfBoundRuns[0].n === 0);
  // Another company's task cannot be bound by the human invocation.
  const otherCompany = await must("POST", "/companies", { name: "E2E TAX-452 other" });
  const foreignIssue = await must("POST", `/companies/${otherCompany.id}/issues`, { title: "E2E foreign task", status: "todo" });
  const foreignWake = await api("POST", `/agents/${agent.id}/wakeup`, { source: "on_demand", payload: { issueId: foreignIssue.id } });
  const foreignRuns = await pgSql`select count(*)::int as n from heartbeat_runs where agent_id = ${agent.id}`;
  record("inert.cross_company_task_denied", "404 and 0 runs", { http: foreignWake.status, runs: foreignRuns[0].n },
    foreignWake.status === 404 && foreignRuns[0].n === 0);

  // --------------------------------------------- run A: once, then re-ask
  const { issue: issueA, run: runA } = await invokeAndGetRun("E2E run A: once then reject");
  receipt.ids.issueA = issueA.id;
  receipt.ids.runA = runA.id;
  log("runA", runA.id, runA.status);
  const reqA1 = await waitFor(async () => {
    const st = await runStatus(runA.id);
    if (st && !["queued", "running"].includes(st)) throw new Error(`runA ended ${st} before a permission request: ${JSON.stringify(await runFailure(runA.id))}`);
    return pendingPermissions(await runEvents(runA.id))[0];
  }, "runA permission #1", 240_000, 1500);
  const cwdA = reqA1.permission.cwd;
  receipt.ids.runA_request1 = reqA1.requestId;
  receipt.config.contractA1 = { ...reqA1.permission, metadata: Object.keys(reqA1.permission.metadata ?? {}), arguments: reqA1.permission.arguments };
  record("contract.typed_permission", "permission.v1 for a workspace file write (edit), restricted_v1/ask, decisions once|reject",
    { schema: reqA1.schema, permission: reqA1.permission.permission, policy: reqA1.permission.policy, decisions: reqA1.decisions, providerVersion: reqA1.permission.providerVersion },
    reqA1.schema === "paperclip.runtime_request.permission.v1" && ["edit", "write"].includes(reqA1.permission.permission) && reqA1.permission.targets?.every((t) => typeof t.resolvedPath !== "string" || t.resolvedPath.startsWith(reqA1.permission.cwd)) && reqA1.permission.policy?.profile === "restricted_v1" && JSON.stringify(reqA1.decisions) === '["once","reject"]');
  record("counter.before_once", 0, counterValue(cwdA), counterValue(cwdA) === 0);

  const resolvePath = (runId, requestId) => `/heartbeat-runs/${runId}/runtime-requests/${encodeURIComponent(requestId)}/resolve`;
  const sha = reqA1.permission.contractSha256;
  const badSha = sha.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  const wrongSha = await api("POST", resolvePath(runA.id, reqA1.requestId), { resolution: { action: "permission_decision", decision: "once", contractSha256: badSha } });
  record("negative.sha_mismatch_409", "409, no dispatch", { status: wrongSha.status, body: wrongSha.text.slice(0, 160) }, wrongSha.status === 409);
  const always = await api("POST", resolvePath(runA.id, reqA1.requestId), { resolution: { action: "permission_decision", decision: "always", contractSha256: sha } });
  record("negative.always_400", "400", { status: always.status }, always.status === 400);
  const legacy = await api("POST", resolvePath(runA.id, reqA1.requestId), { resolution: { action: "accept_for_session" } });
  record("negative.accept_for_session_400", "400", { status: legacy.status }, legacy.status === 400);
  const agentActor = await api("POST", resolvePath(runA.id, reqA1.requestId), { resolution: { action: "permission_decision", decision: "once", contractSha256: sha } }, agentAuth);
  record("negative.agent_actor_403", "403 (board-only)", { status: agentActor.status, body: agentActor.text.slice(0, 160) }, agentActor.status === 403 || agentActor.status === 401);
  const unknownReq = await api("POST", resolvePath(runA.id, "per_e2e_unknown"), { resolution: { action: "permission_decision", decision: "once", contractSha256: sha } });
  record("negative.unknown_request_409", "409", { status: unknownReq.status }, unknownReq.status === 409);
  record("counter.after_negatives", 0, counterValue(cwdA), counterValue(cwdA) === 0);

  // Double click: two concurrent identical decisions.
  const body = { resolution: { action: "permission_decision", decision: "once", contractSha256: sha } };
  const [c1, c2] = await Promise.all([api("POST", resolvePath(runA.id, reqA1.requestId), body), api("POST", resolvePath(runA.id, reqA1.requestId), body)]);
  const statuses = [c1.status, c2.status].sort();
  record("double_click.single_winner", "[202, 409]", { statuses, winner: (c1.status === 202 ? c1 : c2).json }, statuses[0] === 202 && statuses[1] === 409);
  const late = await api("POST", resolvePath(runA.id, reqA1.requestId), { resolution: { action: "permission_decision", decision: "reject", contractSha256: sha } });
  record("double_click.later_opposite_409", "409", { status: late.status }, late.status === 409);

  await waitFor(async () => counterValue(cwdA) >= 1 || null, "counter 1 after once", 60_000, 500);
  record("once.counter_0_to_1", 1, counterValue(cwdA), counterValue(cwdA) === 1);

  const reqA2 = await waitFor(async () => pendingPermissions(await runEvents(runA.id)).find((r) => r.requestId !== reqA1.requestId), "runA permission #2", 120_000, 1000);
  receipt.ids.runA_request2 = reqA2.requestId;
  record("second_action.asks_again", "new permission request with a new id", { request1: reqA1.requestId, request2: reqA2.requestId, sha2: reqA2.permission.contractSha256 },
    reqA2.requestId !== reqA1.requestId);
  // Cross: decision for request #2 carrying request #1's sha.
  const crossSha = await api("POST", resolvePath(runA.id, reqA2.requestId), { resolution: { action: "permission_decision", decision: "once", contractSha256: sha } });
  record("negative.cross_request_sha_409", "409", { status: crossSha.status }, crossSha.status === 409 || reqA2.permission.contractSha256 === sha);
  const rejA2 = await api("POST", resolvePath(runA.id, reqA2.requestId), { resolution: { action: "permission_decision", decision: "reject", contractSha256: reqA2.permission.contractSha256 } });
  record("reject.second_action_202", 202, { status: rejA2.status }, rejA2.status === 202);
  const statusA = await waitTerminal(runA.id);
  record("reject.counter_unchanged_after_second", 1, counterValue(cwdA), counterValue(cwdA) === 1, { runAStatus: statusA });
  const eventsA = await runEvents(runA.id);
  receipt.events.runA = summarizeEvents(eventsA);

  // ---------------------------------------------- run B: reject on first
  fs.mkdirSync(join(OUT, "counter-runA"), { recursive: true });
  for (const f of counterFiles(cwdA)) fs.renameSync(join(cwdA, f), join(OUT, "counter-runA", f));
  const { issue: issueB, run: runB } = await invokeAndGetRun("E2E run B: reject");
  receipt.ids.issueB = issueB.id;
  receipt.ids.runB = runB.id;
  const reqB1 = await waitFor(async () => {
    const st = await runStatus(runB.id);
    if (st && !["queued", "running"].includes(st)) throw new Error(`runB ended ${st} before a permission request: ${JSON.stringify(await runFailure(runB.id))}`);
    return pendingPermissions(await runEvents(runB.id))[0];
  }, "runB permission #1", 240_000, 1500);
  receipt.ids.runB_request1 = reqB1.requestId;
  const cwdB = reqB1.permission.cwd;
  // Cross run: run A's request id (terminal run) and run B's request under run A.
  const crossRunA = await api("POST", resolvePath(runA.id, reqB1.requestId), { resolution: { action: "permission_decision", decision: "once", contractSha256: reqB1.permission.contractSha256 } });
  const crossRunB = await api("POST", resolvePath(runB.id, reqA1.requestId), { resolution: { action: "permission_decision", decision: "once", contractSha256: sha } });
  record("negative.cross_run_409", "409 both directions", { runBRequestOnRunA: crossRunA.status, runARequestOnRunB: crossRunB.status },
    crossRunA.status === 409 && crossRunB.status === 409);
  record("counter.before_reject", 0, counterValue(cwdB), counterValue(cwdB) === 0);
  const rejB = await api("POST", resolvePath(runB.id, reqB1.requestId), { resolution: { action: "permission_decision", decision: "reject", contractSha256: reqB1.permission.contractSha256 } });
  record("reject.first_action_202", 202, { status: rejB.status }, rejB.status === 202);
  const statusB = await waitTerminal(runB.id);
  await sleep(1500);
  record("reject.counter_stays_0", 0, counterValue(cwdB), counterValue(cwdB) === 0, { runBStatus: statusB });
  receipt.events.runB = summarizeEvents(await runEvents(runB.id));

  // Durable claims and audit trail.
  receipt.events.nativePermissionDecisions = await pgSql`select run_id, request_id, decision, status, contract_sha256, created_at from native_permission_decisions order by created_at`;
  receipt.events.activity = (await pgSql`select action, details->>'requestId' as request_id, details->>'decision' as decision, details->>'status' as status, created_at from activity_log where company_id = ${company.id} and action like 'heartbeat.runtime_%' order by created_at`);
  const claims = receipt.events.nativePermissionDecisions;
  record("durable.one_claim_per_request", "3 claims (A1 once, A2 reject, B1 reject), all delivered",
    claims.map((c) => `${c.request_id.slice(-8)}:${c.decision}:${c.status}`),
    claims.length === 3 && claims.every((c) => c.status === "delivered"));

  receipt.events.humanInvocations = humanRuns;
  record("inert.same_agent_human_invocations", "runs A and B belong to the inert agent; receipt = authenticated user manual wake; activity records the invoking user and task",
    humanRuns.map((h) => ({ run: h.run?.agent_id === agent.id, wake: h.wake, activity: h.activity })),
    humanRuns.length === 2 && humanRuns.every((h) => h.run?.agent_id === agent.id && h.run?.manual_invocation?.issueId === h.issueId &&
      h.wake?.requested_by_actor_type === "user" && h.wake?.manual_user_wake === "true" && h.wake?.issue_id === h.issueId &&
      h.activity?.actor_type === "user" && h.activity?.manual_invocation?.issueId === h.issueId));
  const aEnd = await must("GET", `/agents/${agent.id}`);
  const boundIssues = await pgSql`select id, assignee_agent_id, execution_run_id from issues where id in ${pgSql([issueA.id, issueB.id])}`;
  const assignAfter = await api("PATCH", `/issues/${issueA.id}`, { assigneeAgentId: agent.id });
  const assignCreateAfter = await api("POST", `/companies/${company.id}/issues`, { title: "E2E assign after runs", assigneeAgentId: agent.id });
  const runAgents = await pgSql`select distinct agent_id from heartbeat_runs where company_id = ${company.id}`;
  record("inert.locks_intact_after_runs", "tasks never assigned and execution locks released; both human-invoked runs succeeded; assignment still 409; manual_only + blockAssignment persisted; only the inert agent ran",
    { assignees: boundIssues.map((i) => i.assignee_agent_id), executionLocks: boundIssues.map((i) => i.execution_run_id), runStatuses: [statusA, statusB], patch: assignAfter.status, create: assignCreateAfter.status,
      mode: aEnd.permissions?.invocationPolicy?.mode, blockAssignment: aEnd.permissions?.authorizationPolicy?.protectedAgent?.blockAssignment, runAgents: runAgents.map((r) => r.agent_id) },
    boundIssues.length === 2 && boundIssues.every((i) => i.assignee_agent_id === null && i.execution_run_id === null) &&
      statusA === "succeeded" && statusB === "succeeded" && assignAfter.status === 409 && assignCreateAfter.status === 409 &&
      aEnd.permissions?.invocationPolicy?.mode === "manual_only" && aEnd.permissions?.authorizationPolicy?.protectedAgent?.blockAssignment === true &&
      runAgents.length === 1 && runAgents[0].agent_id === agent.id);
}

let failure = null;
async function cleanup() {
  const c = receipt.cleanup;
  try { await pgSql?.end({ timeout: 2 }); } catch {}
  if (server && server.exitCode === null) {
    try { process.kill(-server.pid, "SIGTERM"); } catch {}
    const end = Date.now() + 30_000;
    while (server.exitCode === null && Date.now() < end) await sleep(500);
    if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch {} c.forcedKill = true; }
  }
  await new Promise((r) => fixture.close(() => r()));
  await sleep(1000);
  // PID namespace: only processes of this E2E are visible here.
  c.remainingProcessesBeforeNamespaceExit = execFileSync("ps", ["-eo", "pid,comm", "--no-headers"]).toString().trim().split("\n").map((l) => l.trim()).filter((l) => l && !/ (ps|node|bash|unshare|env)$/.test(l));
  if (failure) { c.keptForDiagnosis = true; c.tmpfsDiscardedWithNamespace = true; return; }
  for (const d of [PCHOME, HOME]) {
    try {
      c[`removed:${d.replace(OUT, "$OUT")}`] = execFileSync("du", ["-sh", d]).toString().split("\t")[0];
      execFileSync("chmod", ["-R", "u+rwX", d]);
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) { c[`removeError:${d}`] = e.message; }
  }
  c.tmpfsDiscardedWithNamespace = true;
}

try {
  await main();
} catch (e) {
  failure = e.stack ?? String(e);
  log("ERROR", failure);
} finally {
  await cleanup();
  receipt.finishedAt = new Date().toISOString();
  receipt.error = failure;
  receipt.passed = !failure && receipt.cases.length > 0 && receipt.cases.every((x) => x.pass);
  fs.writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2));
  log(`RESULT passed=${receipt.passed} cases=${receipt.cases.length} failed=${receipt.cases.filter((x) => !x.pass).map((x) => x.name).join(",")}`);
  process.exit(receipt.passed ? 0 : 1);
}
