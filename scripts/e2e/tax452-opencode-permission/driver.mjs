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
// Separate build with the non-default `e2e-fault-injection` Cargo feature; the
// default RUNNERD above must not contain the seam.
const RUNNERD_FAULT = join(ROOT, "packages/paperclip-runner/runner/target/e2e-fault/paperclip-runnerd");
const FAULT_DIR = "/tmp/paperclip-e2e-fault"; // private tmpfs of the namespace
const PERMISSION_TTL_MS = 8000;

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
// Scenario switched by the driver between runs (runs are strictly serial).
// "write2": the original two-write flow. "deny": exactly one tool call
// (`call`) on the first main-agent request, then a final text; the tool
// result OpenCode feeds back is kept as the observed tool-part outcome.
let scenario = { kind: "write2" };
let fixturePhase = null;
const exposedToolNames = new Set();
function messageText(m) {
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
}
function fixtureDecision(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name) : [];
  for (const t of tools) exposedToolNames.add(t);
  const toolResults = messages.filter((m) => m.role === "tool");
  const last = toolResults.at(-1);
  const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const rejected = /reject|denied|not allowed|permission/i.test(lastText);
  let action;
  if (scenario.kind === "deny") {
    if (tools.length === 0) action = { kind: "text", text: "E2E fixture" };
    else if (toolResults.length === 0) {
      const sys = messages.filter((m) => m.role === "system").map(messageText).join("\n");
      scenario.cwd ??= /Working directory: ([^\n]+)/.exec(sys)?.[1]?.trim() ?? null;
      scenario.toolsExposed = tools;
      scenario.prepare?.(scenario.cwd);
      action = { kind: "tool", id: `call_deny_${scenario.label}`, name: scenario.call.name, args: scenario.call.args };
    } else {
      scenario.toolResult ??= lastText.slice(0, 600);
      action = { kind: "text", text: "E2E fixture done." };
    }
  } else if (scenario.kind === "parallel2") {
    // Two writes in ONE model response: OpenCode asks both permissions while
    // the first is still pending (stale/cascade crossing case).
    if (!tools.includes(WRITE_TOOL)) action = { kind: "text", text: "E2E fixture" };
    else if (toolResults.length === 0) action = { kind: "tool", id: "call_par_1", extra: [{ id: "call_par_2" }] };
    else action = { kind: "text", text: "E2E fixture done." };
  } else if (!tools.includes(WRITE_TOOL)) action = { kind: "text", text: "E2E fixture" };
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
    scenario: scenario.kind === "deny" ? `deny:${scenario.label}` : scenario.kind,
    phase: fixturePhase,
    action: action.kind === "tool" ? `${action.name ?? WRITE_TOOL}:${action.id}` : "text",
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
    const toolCall = (a, index) => ({ index, id: a.id, type: "function", function: { name: a.name ?? WRITE_TOOL, arguments: JSON.stringify(a.args ?? { filePath: `${COUNTER_PREFIX}${a.id}.txt`, content: "tick\n" }) } });
    const calls = action.kind === "tool" ? [action, ...(action.extra ?? [])].map(toolCall) : [];
    const call = calls[0] ?? null;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant" }));
      if (call) {
        res.write(chunk({ tool_calls: calls }));
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
      choices: [{ index: 0, finish_reason: call ? "tool_calls" : "stop", message: call ? { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) } : { role: "assistant", content: action.text } }],
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
let startServerProcess = null;
// Process table of this PID namespace (only E2E processes are visible).
function processTable() {
  return execFileSync("ps", ["-eo", "pid,pgid,stat,args", "--no-headers"]).toString().split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [pid, pgid, stat, ...args] = l.split(/\s+/); return { pid: Number(pid), pgid: Number(pgid), stat, args: args.join(" ").slice(0, 160) }; })
    .filter((p) => !p.stat.startsWith("Z"));
}
// runnerd fd-execs the pinned OpenCode binary: `/proc/self/fd/N serve --hostname 127.0.0.1 --port P`.
const isOpencode = (p) => /^\/proc\/self\/fd\/\d+ serve --hostname /.test(p.args) || /opencode-linux-x64\/bin\/opencode serve/.test(p.args);
const isRunnerd = (p) => /paperclip-runnerd/.test(p.args);
// SIGKILL the whole server process group (tsx + node + every child that did
// not setsid away). Returns the survivors, which are the interesting part.
async function stopOrphanPostgres() {
  const pm = processTable().find((p) => /postgres/.test(p.args) && /-D /.test(p.args));
  if (!pm) return { postmaster: null };
  try { process.kill(pm.pid, "SIGINT"); } catch {}
  const end = Date.now() + 30_000;
  while (Date.now() < end && processTable().some((p) => p.pid === pm.pid)) await sleep(300);
  return { postmaster: pm.pid, stopped: !processTable().some((p) => p.pid === pm.pid) };
}
async function killServerHard() {
  const pgid = server.pid;
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  const end = Date.now() + 15_000;
  while (server.exitCode === null && server.signalCode === null && Date.now() < end) await sleep(200);
  await sleep(1500);
  const survivors = processTable().filter((p) => p.pgid !== process.pid && p.pid !== process.pid && !/^ps /.test(p.args) && !/driver\.mjs/.test(p.args));
  return { killedPgid: pgid, exit: { code: server.exitCode, signal: server.signalCode }, survivors };
}

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
    runnerdFaultSha256: fs.existsSync(RUNNERD_FAULT) ? sha256File(RUNNERD_FAULT) : null,
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
  startServerProcess = async (overrides = {}) => {
    server = spawn(join(ROOT, "server/node_modules/.bin/tsx"), ["src/index.ts"], {
      cwd: join(ROOT, "server"),
      env: { ...serverEnv, ...overrides },
      stdio: ["ignore", fs.openSync(join(OUT, "server.log"), "a"), fs.openSync(join(OUT, "server.log"), "a")],
      detached: true,
    });
    await waitFor(async () => (await api("GET", "/health").catch(() => ({ status: 0 }))).status === 200, "health", 300_000, 2000);
    log("server healthy", server.pid);
  };
  await startServerProcess();
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
  record("contract.typed_permission", "permission.v1 for a workspace file write (permission edit, frozen tool.name write, object arguments), restricted_v1/ask, decisions once|reject",
    { schema: reqA1.schema, permission: reqA1.permission.permission, tool: reqA1.permission.tool, argumentsIsObject: typeof reqA1.permission.arguments === "object" && reqA1.permission.arguments !== null && !Array.isArray(reqA1.permission.arguments), policy: reqA1.permission.policy, decisions: reqA1.decisions, providerVersion: reqA1.permission.providerVersion },
    reqA1.schema === "paperclip.runtime_request.permission.v1" && reqA1.permission.permission === "edit" && reqA1.permission.tool?.name === "write" && typeof reqA1.permission.tool?.messageId === "string" && typeof reqA1.permission.tool?.callId === "string" && typeof reqA1.permission.arguments === "object" && reqA1.permission.arguments !== null && !Array.isArray(reqA1.permission.arguments) && reqA1.permission.targets?.every((t) => typeof t.resolvedPath !== "string" || t.resolvedPath.startsWith(reqA1.permission.cwd)) && reqA1.permission.policy?.profile === "restricted_v1" && JSON.stringify(reqA1.decisions) === '["once","reject"]');
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

  // ================================================== adversarial (TAX-474)
  const once = (r) => ({ resolution: { action: "permission_decision", decision: "once", contractSha256: r.permission.contractSha256 } });
  const parkCounter = (cwd, tag) => {
    const dir = join(OUT, `counter-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of counterFiles(cwd)) fs.renameSync(join(cwd, f), join(dir, f));
  };
  const claimsFor = (runId) => pgSql`select request_id, decision, status, error, native_outcome from native_permission_decisions where run_id = ${runId} order by created_at`;
  // native_outcome = what OpenCode actually received (driver settle signal).
  // Consistency with the counter (the OpenCode-side effect of a native `once`):
  // once => once_applied; reject/no reply => rejected_* | unknown | null.
  // Every delivered claim must carry a non-null outcome: the proxy reports it
  // post-delivery and runnerd relays it (`permission_native_outcome`).
  // TAX452_REQUIRE_NATIVE_OUTCOME=0 relaxes that to "null allowed" (debug).
  const requireNativeOutcome = process.env.TAX452_REQUIRE_NATIVE_OUTCOME !== "0";
  const nativeOutcomeConsistent = (claim, onceObserved) => {
    const o = claim.native_outcome ?? null;
    if (o !== null && !["once_applied", "rejected_terminal", "rejected_drift", "rejected_expired", "unknown"].includes(o)) return false;
    if (requireNativeOutcome && claim.status === "delivered" && o === null) return false;
    return onceObserved ? (o === null || o === "once_applied") && (!requireNativeOutcome || o === "once_applied") : o !== "once_applied";
  };
  // runtime_request.resolved carries no decision: a `once` can only leave the
  // server through a claim, so the audit row + claim are the dispatch record.
  const onceDecisions = async (runId) => pgSql`select details->>'requestId' as request_id, details->>'status' as status from activity_log where entity_id = ${runId} and action = 'heartbeat.runtime_permission_decided' and details->>'decision' = 'once'`;
  const eventDigest = (ev) => ev.filter((e) => !/performance|^log|output|delta/.test(e.eventType ?? e.type ?? "")).map((e) => {
    const t = e.eventType ?? e.type; const p = eventPayload(e);
    return /diagnostic|fail|error|runtime_request|terminal|cancel|notice|item\./.test(t) ? `${t}:${JSON.stringify(p).slice(0, 300)}` : t;
  });
  async function startRunAndWaitPermission(title) {
    const { issue: iss, run } = await invokeAndGetRun(title);
    const req = await waitFor(async () => {
      const st = await runStatus(run.id);
      if (st && !["queued", "running"].includes(st)) throw new Error(`${title}: run ended ${st} before a permission request: ${JSON.stringify(await runFailure(run.id))}`);
      return pendingPermissions(await runEvents(run.id))[0];
    }, `${title} permission`, 240_000, 1000);
    return { issue: iss, run, req };
  }
  const opencodeProcs = () => processTable().filter(isOpencode).map((p) => p.pid);
  receipt.adversarial = {};

  // ---- 4. HTTP reply lost after delivery: the client sends `once`, the
  // server claims + dispatches, the client drops the socket without ever
  // reading the response, then retries.
  {
    const { run, req } = await startRunAndWaitPermission("E2E adv: lost HTTP reply");
    const cwd = req.permission.cwd;
    const before = counterValue(cwd);
    const payload = JSON.stringify(once(req));
    const sock = net.connect(SERVER_PORT, "127.0.0.1");
    sock.pause(); // never read: the response is lost from the client's view
    await new Promise((r) => sock.once("connect", r));
    sock.write(`POST /api${resolvePath(run.id, req.requestId)} HTTP/1.1\r\nHost: 127.0.0.1:${SERVER_PORT}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
    const settled = await waitFor(async () => (await claimsFor(run.id)).find((c) => c.status !== "claimed") ?? null, "lost-reply claim settled", 30_000, 200);
    sock.destroy();
    const retry = await api("POST", resolvePath(run.id, req.requestId), once(req));
    await waitFor(async () => counterValue(cwd) >= 1 || null, "lost-reply counter 1", 60_000, 500);
    const req2 = await waitFor(async () => pendingPermissions(await runEvents(run.id)).find((r) => r.requestId !== req.requestId), "lost-reply second ask", 120_000, 1000);
    const rej2 = await api("POST", resolvePath(run.id, req2.requestId), { resolution: { action: "permission_decision", decision: "reject", contractSha256: req2.permission.contractSha256 } });
    const st = await waitTerminal(run.id);
    await sleep(1000);
    const claims = await claimsFor(run.id);
    const ev = await runEvents(run.id);
    const firstOnce = (await onceDecisions(run.id)).filter((e) => e.request_id === req.requestId);
    receipt.adversarial.lostReply = { runId: run.id, requestId: req.requestId, settled, retry: { status: retry.status, body: retry.text.slice(0, 200) }, rej2: rej2.status, status: st, claims, onceEvents: firstOnce };
    record("adv.lost_reply.retry_409_no_redelivery", "client drops the 202 after claim+dispatch; retry -> 409; exactly one delivered claim and one once resolution for the request; counter 0->1 (not 2); second ask rejected",
      { retry: retry.status, counterBefore: before, counter: counterValue(cwd), claims: claims.map((c) => `${c.decision}:${c.status}`), onceResolutions: firstOnce.length, runStatus: st },
      retry.status === 409 && before === 0 && counterValue(cwd) === 1 && claims.filter((c) => c.request_id === req.requestId).length === 1 &&
        claims.find((c) => c.request_id === req.requestId)?.status === "delivered" && firstOnce.length === 1 && firstOnce[0].status === "delivered" && rej2.status === 202);
    parkCounter(cwd, "lostReply");
  }

  // ---- 3. Board cancel while a permission is pending, then a late `once`.
  {
    const { run, req } = await startRunAndWaitPermission("E2E adv: cancel then late once");
    const cwd = req.permission.cwd;
    const ocBefore = opencodeProcs();
    receipt.adversarial.cancelRunnerd = processTable().filter(isRunnerd).map((p) => p.pid);
    receipt.adversarial.processesWhilePending = processTable().filter((p) => !/^ps /.test(p.args));
    const cancel = await api("POST", `/heartbeat-runs/${run.id}/cancel`, {});
    const late = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const st = await waitTerminal(run.id, 60_000);
    const ocAfter = await waitFor(async () => (opencodeProcs().length === 0 ? [] : null), "opencode stopped after cancel", 30_000, 500).catch(() => opencodeProcs());
    const late2 = await api("POST", resolvePath(run.id, req.requestId), once(req));
    await sleep(1500);
    const claims = await claimsFor(run.id);
    const ev = await runEvents(run.id);
    receipt.adversarial.cancel = { runId: run.id, cancel: cancel.status, late: late.status, late2: late2.status, status: st, opencodeBefore: ocBefore, opencodeAfter: ocAfter, claims, digest: eventDigest(ev).slice(-12) };
    record("adv.cancel_then_once_409", "board cancel -> run cancelled; late once 409 (immediately and after terminal); 0 claims, 0 once; counter 0; OpenCode process stopped",
      { cancel: cancel.status, late: late.status, late2: late2.status, runStatus: st, claims: claims.length, once: (await onceDecisions(run.id)).length, counter: counterValue(cwd), opencodeBefore: ocBefore.length, opencodeAfter: ocAfter.length },
      cancel.status === 200 && late.status === 409 && late2.status === 409 && st === "cancelled" && claims.length === 0 && (await onceDecisions(run.id)).length === 0 && counterValue(cwd) === 0);
    const ownOc = ocBefore.filter((pid) => ocAfter.includes(pid));
    record("adv.cancel.opencode_stopped", "after board cancel of a run blocked on a permission, the run's runnerd/OpenCode exit within 30s",
      { opencodeWhilePending: ocBefore, opencodeAfter30s: ocAfter, stillAlive: ownOc }, ocBefore.length > 0 && ownOc.length === 0, { defectIfFailed: "runnerd keeps the cancelled run's OpenCode (pending native permission) alive" });
  }

  // ---- 1. Deny surfaces: one run per surface, the fixture emits exactly
  // that tool call. No permission request may be published and nothing may
  // change.
  {
    const toolNames = [...exposedToolNames];
    receipt.adversarial.exposedToolNames = toolNames;
    const mcpCreate = ["paperclip_create_task", "mcp__paperclip__create_task", "paperclip_paperclip_create_task"].find((n) => toolNames.includes(n)) ?? "paperclip_create_task";
    const outsideDir = "/tmp/e2e-outside-dir";
    fs.mkdirSync(outsideDir, { recursive: true });
    const surfaces = [
      { label: "bash", call: { name: "bash", args: { command: "echo x >> e2e-deny-bash.txt", description: "e2e deny probe" } } },
      { label: "webfetch", call: { name: "webfetch", args: { url: `http://127.0.0.1:${FIXTURE_PORT}/e2e-webfetch-probe`, format: "text" } } },
      { label: "task", call: { name: "task", args: { description: "e2e deny", prompt: "Create the file e2e-deny-task.txt", subagent_type: "general" } } },
      { label: "mcp_create_task", call: { name: mcpCreate, args: { title: "E2E deny MCP probe", description: "must never exist" } } },
      { label: "unknown_tool", call: { name: "e2e_unknown_tool", args: { path: "e2e-deny-unknown.txt" } } },
      { label: "write_abs_outside", call: { name: "write", args: { filePath: "/tmp/e2e-outside-abs.txt", content: "escape\n" } } },
      { label: "write_symlink_escape", call: { name: "write", args: { filePath: "e2e-escape-link/escaped.txt", content: "escape\n" } },
        prepare: (cwd) => { if (cwd && !fs.existsSync(join(cwd, "e2e-escape-link"))) fs.symlinkSync(outsideDir, join(cwd, "e2e-escape-link")); scenario.symlink = cwd ? fs.readlinkSync(join(cwd, "e2e-escape-link")) : null; } },
    ];
    const effects = (cwd) => ({
      bashMarker: fs.existsSync(join(cwd, "e2e-deny-bash.txt")),
      taskMarker: fs.existsSync(join(cwd, "e2e-deny-task.txt")),
      unknownMarker: fs.existsSync(join(cwd, "e2e-deny-unknown.txt")),
      absOutside: fs.existsSync("/tmp/e2e-outside-abs.txt"),
      symlinkOutside: fs.readdirSync(outsideDir),
      counter: counterValue(cwd),
      webfetchHits: receipt.fixture.requests.filter((r) => r.unexpected && r.unexpected.includes("e2e-webfetch-probe")).length,
    });
    const results = [];
    for (const surface of surfaces) {
      scenario = { kind: "deny", label: surface.label, call: surface.call, prepare: surface.prepare };
      const issuesBefore = (await pgSql`select count(*)::int as n from issues where company_id = ${company.id}`)[0].n;
      const claimsBefore = (await pgSql`select count(*)::int as n from native_permission_decisions`)[0].n;
      const { run } = await invokeAndGetRun(`E2E adv deny: ${surface.label}`);
      const st = await waitTerminal(run.id, 120_000);
      await sleep(1000);
      const cwd = scenario.cwd ?? cwdA;
      const ev = await runEvents(run.id);
      const created = ev.filter((e) => (e.eventType ?? e.type) === "runtime_request.created");
      // Driver diagnostics reach the run as harness.diagnostic or, for
      // turn-scoped warnings, as provider.notice.recorded{summary: code}.
      const diags = [
        ...summarizeEvents(ev).filter((e) => e.type === "harness.diagnostic").map((e) => e.code),
        ...ev.filter((e) => (e.eventType ?? e.type) === "provider.notice.recorded").map((e) => `notice:${eventPayload(e).summary}`),
      ].filter((c) => c !== "provider_startup_ownership");
      const issuesAfter = (await pgSql`select count(*)::int as n from issues where company_id = ${company.id}`)[0].n;
      const probeIssues = (await pgSql`select count(*)::int as n from issues where title = 'E2E deny MCP probe'`)[0].n;
      const claimsAfter = (await pgSql`select count(*)::int as n from native_permission_decisions`)[0].n;
      const fx = effects(cwd);
      const r = {
        surface: surface.label, tool: surface.call.name, runId: run.id, runStatus: st, cwd,
        toolExposedToModel: (scenario.toolsExposed ?? []).includes(surface.call.name),
        toolCallEmitted: receipt.fixture.requests.some((q) => q.scenario === `deny:${surface.label}` && q.action !== "text"),
        permissionRequestsCreated: created.length, diagnostics: diags,
        toolResult: scenario.toolResult ?? null,
        newIssues: issuesAfter - issuesBefore - 1, probeIssues, newClaims: claimsAfter - claimsBefore, effects: fx,
        symlink: scenario.symlink,
        fixtureCalls: receipt.fixture.requests.filter((q) => q.scenario === `deny:${surface.label}`).map((q) => q.action),
        digest: eventDigest(ev),
      };
      results.push(r);
      const zeroEffect = !fx.bashMarker && !fx.taskMarker && !fx.unknownMarker && !fx.absOutside && fx.symlinkOutside.length === 0 && fx.counter === 0 && fx.webfetchHits === 0;
      record(`adv.deny.${surface.label}`, "tool call reaches OpenCode; no permission request published; no claim; no file/network/Paperclip effect; run terminal",
        { runStatus: st, exposed: r.toolExposedToModel, emitted: r.toolCallEmitted, requests: created.length, claims: r.newClaims, newIssues: r.newIssues, diagnostics: diags, toolResult: (r.toolResult ?? "").slice(0, 160), effects: fx },
        r.toolCallEmitted && created.length === 0 && r.newClaims === 0 && r.newIssues === 0 && probeIssues === 0 && zeroEffect && !["queued", "running"].includes(st) &&
          (surface.label !== "write_symlink_escape" || (r.symlink === outsideDir && diags.includes("notice:permission_target_outside_workspace"))));
    }
    scenario = { kind: "write2" };
    receipt.adversarial.deny = results;
    try { fs.unlinkSync(join(results.at(-1).cwd, "e2e-escape-link")); } catch {}
  }

  // ---- 6. Simultaneous board cancel || `once` (TAX-476 pending heredado).
  // Both requests leave together; whichever wins, the run must end terminal,
  // no native `once` may happen after the terminal, a later decision is 409,
  // and the counter/claims must agree with the winner.
  {
    const iterations = [];
    for (let i = 1; i <= 3; i += 1) {
      const { run, req } = await startRunAndWaitPermission(`E2E adv: cancel||once #${i}`);
      const cwd = req.permission.cwd;
      const [cancel, dec] = await Promise.all([
        api("POST", `/heartbeat-runs/${run.id}/cancel`, {}),
        api("POST", resolvePath(run.id, req.requestId), once(req)),
      ]);
      const st = await waitTerminal(run.id, 90_000).catch((e) => `not terminal: ${e.message}`);
      const counterAtTerminal = counterValue(cwd);
      await sleep(3000);
      const late = await api("POST", resolvePath(run.id, req.requestId), once(req));
      const counterAfter = counterValue(cwd);
      // The native outcome arrives asynchronously after the delivery.
      let claims = await claimsFor(run.id);
      for (let w = 0; w < 20 && claims.some((c) => c.status === "delivered" && c.native_outcome == null); w += 1) {
        await sleep(500);
        claims = await claimsFor(run.id);
      }
      const onceRows = await onceDecisions(run.id);
      const ev = await runEvents(run.id);
      const delivered = claims.filter((c) => c.status === "delivered");
      const winner = dec.status === 202 ? (counterAfter === 1 ? "once_executed" : "once_claimed_lost_to_terminal") : "cancel";
      const it = { i, runId: run.id, cancel: cancel.status, decision: dec.status, decisionBody: dec.text.slice(0, 160), runStatus: st, late: late.status,
        counterAtTerminal, counterAfter, claims: claims.map((c) => `${c.decision}:${c.status}:${c.native_outcome ?? "null"}`), onceRows: onceRows.map((o) => o.status), winner,
        digest: eventDigest(ev).filter((d) => /runtime_request|permission|cancel|terminal/.test(d)).slice(-10) };
      it.pass = cancel.status === 200 && [202, 409].includes(dec.status) && typeof st === "string" && !st.startsWith("not terminal") &&
        late.status === 409 && counterAfter <= 1 && counterAfter === counterAtTerminal &&
        claims.length <= 1 && delivered.length <= 1 &&
        (dec.status === 409 ? claims.filter((c) => c.status === "delivered").length === 0 && counterAfter === 0 : claims.length === 1 && claims[0].decision === "once") &&
        (counterAfter === 1 ? dec.status === 202 && delivered.length === 1 : true) &&
        // A delivered once claim must mean the once won before the terminal,
        // unless the driver recorded that OpenCode got a native reject.
        (delivered.some((c) => c.decision === "once")
          ? counterAfter === 1 || delivered.every((c) => /^rejected_/.test(c.native_outcome ?? ""))
          : true) &&
        // (a) never a native once after terminal; (b) every claim's
        // native_outcome agrees with what OpenCode received.
        counterAfter === counterAtTerminal &&
        claims.every((c) => nativeOutcomeConsistent(c, counterAfter === 1)) &&
        onceRows.filter((o) => o.status === "delivered").length === delivered.filter((c) => c.decision === "once").length;
      iterations.push(it);
      parkCounter(cwd, `cancelOnce${i}`);
    }
    receipt.adversarial.cancelOnceRace = iterations;
    record("adv.cancel_once_race.single_terminal_winner", "3x Promise.all(board cancel, once): run terminal; decision 202|409; late once 409; counter <=1 and unchanged after terminal (no native once after terminal); claims <=1, once 409 => 0 delivered claims and counter 0; counter 1 => decision 202 + one delivered claim; once audit rows match delivered claims; native_outcome consistent with OpenCode (counter 1 => once_applied|null, else never once_applied; delivered once with counter 0 only if native_outcome rejected_*)",
      iterations.map((x) => ({ i: x.i, cancel: x.cancel, decision: x.decision, runStatus: x.runStatus, late: x.late, counter: `${x.counterAtTerminal}->${x.counterAfter}`, claims: x.claims, winner: x.winner, pass: x.pass })),
      iterations.length === 3 && iterations.every((x) => x.pass),
      { defectIfFailed: "a once that lost to the terminal cancel inside the driver (native reject) is still recorded as a delivered claim: delivered means 'handed to runnerd', not 'executed'" });
  }

  // ---- 7. Stale request of the same run (TAX-476 pending heredado): the
  // model asks two writes in one response, so two permissions are pending in
  // the same turn. Rejecting the first makes OpenCode cascade-reject the
  // second natively; a later `once` for that settled request must be 409 with
  // zero dispatch, both while the run continues and after the turn ended.
  {
    scenario = { kind: "parallel2" };
    const { run } = await invokeAndGetRun("E2E adv: stale cascaded permission");
    const reqs = await waitFor(async () => {
      const st = await runStatus(run.id);
      if (st && !["queued", "running"].includes(st)) throw new Error(`stale case: run ended ${st} before two permissions: ${JSON.stringify(await runFailure(run.id))}`);
      const p = pendingPermissions(await runEvents(run.id));
      return p.length >= 2 ? p : null;
    }, "two concurrent permissions", 240_000, 1000).catch(async (e) => ({ error: e.message, pending: pendingPermissions(await runEvents(run.id)).map((r) => r.requestId) }));
    if (!Array.isArray(reqs)) {
      receipt.adversarial.stale = { runId: run.id, notReproduced: reqs };
      record("adv.stale_cascaded_permission_409", "two permissions pending in one turn; reject #1 -> OpenCode cascade-rejects #2; once on #2 -> 409, 0 dispatch", { notReproduced: reqs }, false,
        { defectIfFailed: "OpenCode did not publish two concurrent permissions; stale crossing not exercised" });
      await api("POST", `/heartbeat-runs/${run.id}/cancel`, {});
      await waitTerminal(run.id, 60_000).catch(() => null);
    } else {
      const [r1, r2] = reqs;
      const cwd = r1.permission.cwd;
      const rej1 = await api("POST", resolvePath(run.id, r1.requestId), { resolution: { action: "permission_decision", decision: "reject", contractSha256: r1.permission.contractSha256 } });
      // Wait until the server no longer lists #2 as pending (runnerd retired
      // it after the proxy reported the provider cascade) or 10s.
      const settledLive = await waitFor(async () => (!pendingPermissions(await runEvents(run.id)).some((r) => r.requestId === r2.requestId) ? true : null), "stale #2 settled", 10_000, 250).catch(() => false);
      const liveOnce = await api("POST", resolvePath(run.id, r2.requestId), once(r2));
      const st = await waitTerminal(run.id, 90_000).catch((e) => `not terminal: ${e.message}`);
      await sleep(1500);
      const afterOnce = await api("POST", resolvePath(run.id, r2.requestId), once(r2));
      const claims = await claimsFor(run.id);
      const ev = await runEvents(run.id);
      const created = ev.filter((e) => (e.eventType ?? e.type) === "runtime_request.created").length;
      receipt.adversarial.stale = { runId: run.id, requests: [r1.requestId, r2.requestId], rej1: rej1.status, settledLive, liveOnce: { status: liveOnce.status, body: liveOnce.text.slice(0, 200) }, afterOnce: afterOnce.status, runStatus: st, claims, counter: counterValue(cwd), created,
        digest: eventDigest(ev).filter((d) => /runtime_request|permission|terminal|turn\./.test(d)).slice(-14) };
      record("adv.stale_cascaded_permission_409", "two permissions in one turn; reject #1 (202) -> OpenCode cascade-rejects #2 natively; server stops listing #2; once on #2 while the run is live -> 409 and again after the turn ended -> 409; only #1's reject claim (delivered); counter 0; no re-prompt",
        { rej1: rej1.status, serverSettledStale: settledLive, liveOnce: liveOnce.status, afterTurnOnce: afterOnce.status, runStatus: st, claims: claims.map((c) => `${c.request_id === r1.requestId ? "r1" : "r2"}:${c.decision}:${c.status}`), counter: counterValue(cwd), permissionsCreated: created },
        rej1.status === 202 && settledLive === true && liveOnce.status === 409 && afterOnce.status === 409 && claims.length === 1 && claims[0].request_id === r1.requestId && claims[0].status === "delivered" &&
          counterValue(cwd) === 0 && created === 2 && typeof st === "string" && !st.startsWith("not terminal"),
        { defectIfFailed: "a permission the provider already settled (cascade reject) stays decidable on the server and a later once is dispatched" });
      parkCounter(cwd, "stale");
    }
    scenario = { kind: "write2" };
  }

  // ---- 2. Restart without replay. (a) a request pending with no decision;
  // (b) a decision durably claimed (row `claimed`) and the server killed
  // before any dispatch. The claimed row is written with the server's own
  // claim shape right before SIGKILL; no production seam exists between the
  // claim INSERT and the dispatch.
  for (const variant of ["pending", "claimed"]) {
    const preOc = opencodeProcs();
    const preRd = processTable().filter(isRunnerd).map((p) => p.pid);
    const { run, req } = await startRunAndWaitPermission(`E2E adv: restart (${variant})`);
    const cwd = req.permission.cwd;
    const before = { counter: counterValue(cwd), opencode: opencodeProcs(), runnerd: processTable().filter(isRunnerd).map((p) => p.pid) };
    if (variant === "claimed") {
      await pgSql`insert into native_permission_decisions (company_id, agent_id, run_id, request_id, turn_id, contract_sha256, decision, resolver_user_id, status)
        values (${company.id}, ${agent.id}, ${run.id}, ${req.requestId}, ${req.turnId}, ${req.permission.contractSha256}, 'once', 'local-admin', 'claimed')`;
    }
    const killed = await killServerHard();
    // The embedded postmaster is in the server group and dies with it (its
    // workers exit on postmaster death); if one survived anyway, fast-stop it
    // so the restart is a clean crash of the whole service. runnerd and
    // OpenCode (own session) are deliberately left as they are.
    killed.pgProbe = await pgSql`select current_setting('data_directory', true) as dd, current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su`.then((r) => r[0]).catch((e) => ({ error: e.message }));
    killed.pgStopped = await stopOrphanPostgres();
    const fixtureMark = receipt.fixture.requests.length;
    await startServerProcess();
    const afterBoot = { runStatus: await runStatus(run.id), opencode: opencodeProcs(), runnerd: processTable().filter(isRunnerd).map((p) => p.pid) };
    const probe1 = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const st = await waitTerminal(run.id, 180_000).catch((e) => `not terminal: ${e.message}`);
    const probe2 = await api("POST", resolvePath(run.id, req.requestId), once(req));
    await sleep(3000);
    const ev = await runEvents(run.id);
    const claims = await claimsFor(run.id);
    const ocLeft = opencodeProcs();
    const replayed = receipt.fixture.requests.slice(fixtureMark).filter((q) => q.action && q.action !== "text");
    const row = (await pgSql`select status, error_code, error from heartbeat_runs where id = ${run.id}`)[0];
    const onceRows = await onceDecisions(run.id);
    receipt.adversarial[`restart_${variant}`] = { runId: run.id, requestId: req.requestId, before, killed, afterBoot, probe1: { status: probe1.status, body: probe1.text.slice(0, 200) }, probe2: probe2.status, terminal: st, row, claims, opencodeLeft: ocLeft, fixtureAfterRestart: receipt.fixture.requests.slice(fixtureMark), digest: eventDigest(ev).slice(-14) };
    // A probe that slips in before reconciliation may insert a claim, but it
    // must settle as `stale` (provably not dispatched); a pre-crash claim is
    // reconciled by restart recovery to `dispatch_uncertain`. Never `delivered`.
    const expectedClaims = variant === "pending"
      ? claims.every((c) => c.status === "stale")
      : claims.length === 1 && claims[0].decision === "once" && claims[0].status === "dispatch_uncertain";
    record(`adv.restart_${variant}.no_replay`, `server SIGKILL with the permission ${variant === "pending" ? "pending (no decision)" : "claimed (row claimed, not dispatched)"}; after restart: once -> 409 (twice), 0 once resolutions, counter 0, no new mutating tool call from the provider, run terminal/reconciled, no OpenCode left${variant === "claimed" ? ", claim never delivered" : ", no claim"}`,
      { probe1: probe1.status, probe2: probe2.status, runStatus: st, errorCode: row?.error_code, once: onceRows.filter((o) => o.status === "delivered").length, counter: counterValue(cwd), replayedToolCalls: replayed.length, claims: claims.map((c) => `${c.decision}:${c.status}`), opencodeLeft: ocLeft.length, survivorsAfterKill: killed.survivors.map((p) => p.args.slice(0, 60)) },
      probe1.status === 409 && probe2.status === 409 && onceRows.filter((o) => o.status === "delivered").length === 0 && counterValue(cwd) === 0 && replayed.length === 0 && expectedClaims &&
        typeof st === "string" && !st.startsWith("not terminal"));
    const runOc = before.opencode.filter((pid) => !preOc.includes(pid));
    const runRunnerd = before.runnerd.filter((pid) => !preRd.includes(pid));
    const leftover = await waitFor(async () => { const alive = processTable().map((p) => p.pid); const l = [...runOc, ...runRunnerd].filter((pid) => alive.includes(pid)); return l.length === 0 ? [] : null; }, "orphans reaped", 30_000, 1000).catch(() => { const alive = processTable().map((p) => p.pid); return [...runOc, ...runRunnerd].filter((pid) => alive.includes(pid)); });
    record(`adv.restart_${variant}.orphan_processes_stopped`, "after restart + reconciliation, the killed server's runnerd/OpenCode for this run exit within 30s",
      { opencodeBeforeKill: runOc, runnerdBeforeKill: runRunnerd, stillAlive: leftover }, leftover.length === 0, { defectIfFailed: "runnerd/OpenCode of a crashed server's run survive and are not reaped after native_restart_recovery_blocked" });
  }

  // ---- 8. Typed permission expiry (restricted_v1 TTL). The server is
  // restarted with PAPERCLIP_OPENCODE_PERMISSION_TTL_MS so the proxy of the
  // next run gets a short TTL through the env allowlists (server -> runnerd ->
  // proxy). The undecided permission must be rejected natively exactly once,
  // published as runtime_request.expired with permission_expired, and a later
  // decision must be 409 with zero dispatch and no re-prompt.
  {
    const killed = await killServerHard();
    killed.pgStopped = await stopOrphanPostgres();
    await startServerProcess({ PAPERCLIP_OPENCODE_PERMISSION_TTL_MS: String(PERMISSION_TTL_MS) });
    try { await pgSql?.end({ timeout: 2 }); } catch {}
    pgSql = createRequire(join(ROOT, "packages/db/package.json"))("postgres")(`postgres://paperclip:paperclip@127.0.0.1:${PG_PORT}/paperclip`, { max: 2, onnotice: () => {} });
    fixturePhase = "expiry";
    const { run, req } = await startRunAndWaitPermission("E2E adv: typed permission expiry");
    const cwd = req.permission.cwd;
    const createdAt = Date.now();
    // The controller publishes the settlement as runtime_request.cancelled
    // (serverRequest/resolved) or .expired; either takes it off the pending set.
    const settledTypes = ["runtime_request.expired", "runtime_request.cancelled"];
    const expiredEv = await waitFor(async () => (await runEvents(run.id)).find((e) => settledTypes.includes(e.eventType ?? e.type) && eventPayload(e).requestId === req.requestId) ?? null,
      "runtime_request.expired", PERMISSION_TTL_MS + 30_000, 500).catch(() => null);
    const expiredAfterMs = Date.now() - createdAt;
    const late = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const st = await waitTerminal(run.id, 90_000).catch((e) => `not terminal: ${e.message}`);
    await sleep(1500);
    const late2 = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const ev = await runEvents(run.id);
    const claims = await claimsFor(run.id);
    const diags = ev.filter((e) => (e.eventType ?? e.type) === "harness.diagnostic").map((e) => eventPayload(e).code);
    const created = ev.filter((e) => (e.eventType ?? e.type) === "runtime_request.created").length;
    const expiredCount = ev.filter((e) => settledTypes.includes(e.eventType ?? e.type) && eventPayload(e).requestId === req.requestId).length;
    const fixtureCalls = receipt.fixture.requests.filter((q) => q.phase === "expiry");
    const toolCalls = fixtureCalls.filter((q) => q.action && q.action !== "text").length;
    const terminalSeq = ev.find((e) => (e.eventType ?? e.type) === "run.terminal")?.seq ?? null;
    const settledBeforeTerminal = Boolean(expiredEv) && (terminalSeq === null || expiredEv.seq < terminalSeq);
    receipt.adversarial.expiry = { runId: run.id, requestId: req.requestId, ttlMs: PERMISSION_TTL_MS, expiredAfterMs, expiredEvent: expiredEv ? { type: expiredEv.eventType ?? expiredEv.type, seq: expiredEv.seq, payload: eventPayload(expiredEv) } : null, terminalSeq, digest: eventDigest(ev).filter((d) => /runtime_request|permission|terminal|turn\./.test(d)).slice(-12), late: { status: late.status, body: late.text.slice(0, 200) }, late2: late2.status, runStatus: st, claims, diags, created, expiredCount, fixtureCalls, killed: { survivors: killed.survivors.length } };
    record("adv.expiry.permission_expired_409", `TTL ${PERMISSION_TTL_MS}ms via env allowlists; undecided permission is rejected natively once (OpenCode ends the turn), runnerd publishes diagnostic permission_expired and the controller settles the request (runtime_request.cancelled|expired, before run.terminal) exactly once after >= TTL; later once -> 409 (twice); 0 claims; counter 0; no re-prompt (1 permission created, 1 provider tool call)`,
      { settled: expiredEv ? `${expiredEv.eventType ?? expiredEv.type}:${eventPayload(expiredEv).reason}` : null, settledBeforeTerminal, expiredAfterMs, settledCount: expiredCount, diagnostics: diags.filter((d) => /permission/.test(d ?? "")), late: late.status, late2: late2.status, runStatus: st, claims: claims.length, counter: counterValue(cwd), permissionsCreated: created, providerToolCalls: toolCalls },
      Boolean(expiredEv) && settledBeforeTerminal && expiredCount === 1 && expiredAfterMs >= PERMISSION_TTL_MS - 2000 && diags.includes("permission_expired") &&
        late.status === 409 && late2.status === 409 && claims.length === 0 && counterValue(cwd) === 0 && created === 1 && toolCalls === 1 && typeof st === "string" && !st.startsWith("not terminal"));
    fixturePhase = null;
    parkCounter(cwd, "expiry");
  }

  // ---- 9. Internal loss after delivery server<->runnerd + restart. Only the
  // separately built `e2e-fault-injection` runnerd has the seam: with the
  // trigger file present it aborts right after writing the `once` to the
  // OpenCode proxy and before the request.resolve result is acknowledged.
  if (!fs.existsSync(RUNNERD_FAULT)) {
    record("adv.internal_loss.no_reexecution", "fault-injection runnerd present", { missing: RUNNERD_FAULT }, false);
  } else {
    const killed = await killServerHard();
    killed.pgStopped = await stopOrphanPostgres();
    await startServerProcess({ PAPERCLIP_RUNNER_BINARY: RUNNERD_FAULT });
    try { await pgSql?.end({ timeout: 2 }); } catch {}
    pgSql = createRequire(join(ROOT, "packages/db/package.json"))("postgres")(`postgres://paperclip:paperclip@127.0.0.1:${PG_PORT}/paperclip`, { max: 2, onnotice: () => {} });
    fixturePhase = "fault";
    const preRd = processTable().filter(isRunnerd).map((p) => p.pid);
    const { run, req } = await startRunAndWaitPermission("E2E adv: runnerd lost after delivery");
    const cwd = req.permission.cwd;
    const faultRunnerd = processTable().filter(isRunnerd).filter((p) => !preRd.includes(p.pid)).map((p) => ({ pid: p.pid, args: p.args.slice(0, 120) }));
    fs.mkdirSync(FAULT_DIR, { recursive: true });
    fs.writeFileSync(join(FAULT_DIR, "crash-after-permission-delivery"), "1\n");
    const dec = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const crashed = await waitFor(async () => (fs.existsSync(join(FAULT_DIR, "crashed-after-permission-delivery")) ? fs.readFileSync(join(FAULT_DIR, "crashed-after-permission-delivery"), "utf8").trim() : null), "runnerd fault fired", 30_000, 250).catch(() => null);
    const claimAfterCrash = await waitFor(async () => (await claimsFor(run.id)).find((c) => c.status !== "claimed") ?? null, "claim settled after runnerd loss", 60_000, 500).catch(async () => (await claimsFor(run.id))[0] ?? null);
    const stBeforeRestart = await waitTerminal(run.id, 120_000).catch((e) => `not terminal: ${e.message}`);
    const counterBeforeRestart = counterValue(cwd);
    const retryBefore = await api("POST", resolvePath(run.id, req.requestId), once(req));
    // Restart the server on the default (seam-free) runnerd.
    const killed2 = await killServerHard();
    killed2.pgStopped = await stopOrphanPostgres();
    const fixtureMark = receipt.fixture.requests.length;
    await startServerProcess();
    try { await pgSql?.end({ timeout: 2 }); } catch {}
    pgSql = createRequire(join(ROOT, "packages/db/package.json"))("postgres")(`postgres://paperclip:paperclip@127.0.0.1:${PG_PORT}/paperclip`, { max: 2, onnotice: () => {} });
    const retryAfter = await api("POST", resolvePath(run.id, req.requestId), once(req));
    const stAfter = await waitTerminal(run.id, 120_000).catch((e) => `not terminal: ${e.message}`);
    await sleep(3000);
    const claims = await claimsFor(run.id);
    const onceRows = await onceDecisions(run.id);
    const row = (await pgSql`select status, error_code, error from heartbeat_runs where id = ${run.id}`)[0];
    const replayed = receipt.fixture.requests.slice(fixtureMark).filter((q) => q.action && q.action !== "text");
    const ev = await runEvents(run.id);
    const counter = counterValue(cwd);
    receipt.adversarial.internalLoss = { runId: run.id, requestId: req.requestId, faultRunnerd, decision: { status: dec.status, body: dec.text.slice(0, 200) }, crashed, claimAfterCrash, stBeforeRestart, counterBeforeRestart,
      retryBefore: retryBefore.status, retryAfter: { status: retryAfter.status, body: retryAfter.text.slice(0, 200) }, stAfter, row, claims, onceRows, replayedAfterRestart: replayed, counter,
      killed: { survivors: killed.survivors.length }, killed2: { survivors: killed2.survivors.map((p) => p.args.slice(0, 60)) }, digest: eventDigest(ev).slice(-16) };
    const reqClaims = claims.filter((c) => c.request_id === req.requestId);
    record("adv.internal_loss.no_reexecution", "fault runnerd aborts after writing once to the proxy, before acking request.resolve; the command is indeterminate: exactly one claim for the request, never delivered, ends dispatch_uncertain (blocked for reconciliation); retry once -> 409 before and after server restart; no second once (counter <= 1, unchanged after restart); no new provider tool call after restart; run terminal",
      { decision: dec.status, faultFired: Boolean(crashed), claimAfterCrash: claimAfterCrash ? `${claimAfterCrash.decision}:${claimAfterCrash.status}` : null, claims: reqClaims.map((c) => `${c.decision}:${c.status}`), retryBefore: retryBefore.status, retryAfter: retryAfter.status,
        runBefore: stBeforeRestart, runAfter: stAfter, errorCode: row?.error_code, counterBeforeRestart, counter, onceAudit: onceRows.map((o) => o.status), replayedToolCalls: replayed.length },
      Boolean(crashed) && reqClaims.length === 1 && reqClaims[0].decision === "once" && reqClaims[0].status === "dispatch_uncertain" && retryBefore.status === 409 && retryAfter.status === 409 &&
        counter <= 1 && counter === counterBeforeRestart && replayed.length === 0 && onceRows.filter((o) => o.status === "delivered").length === 0 &&
        typeof stAfter === "string" && !stAfter.startsWith("not terminal"),
      { defectIfFailed: "a request.resolve lost inside runnerd after delivery is not reconciled as dispatch_uncertain or is re-executed" });
    fixturePhase = null;
    try { fs.rmSync(FAULT_DIR, { recursive: true, force: true }); } catch {}
    parkCounter(cwd, "internalLoss");
  }

  await authenticatedPhase({ foreignSha: sha });
}

// ------------------------------------------- 5. authenticated/private phase
// A second disposable instance (own instance id and embedded Postgres) in
// authenticated/private mode. Users are created through the real better-auth
// API; the first one claims the instance (DEPLOYMENT-MODES.md §8, browser
// claim endpoint, driven with the session cookie + trusted Origin). Company
// memberships of the non-admin users are seeded in SQL: inviting needs a
// mail/invite acceptance flow that is out of scope here.
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
async function sapi(method, path, body, cookie) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c));
  return { status: res.status, json, text: text.slice(0, 500), cookie: cookies.join("; ") || null };
}
async function smust(method, path, body, cookie) {
  const r = await sapi(method, path, body, cookie);
  if (r.status >= 400) throw new Error(`[auth] ${method} ${path} -> ${r.status} ${r.text}`);
  return r;
}
async function authenticatedPhase({ foreignSha }) {
  const A = (receipt.authenticated = { instanceId: `${INSTANCE}-auth` });
  A.killPhase1 = await killServerHard();
  A.killPhase1.pgStopped = await stopOrphanPostgres();
  try { await pgSql?.end({ timeout: 2 }); } catch {}
  await startServerProcess({
    PAPERCLIP_INSTANCE_ID: A.instanceId,
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_PUBLIC_URL: ORIGIN,
    PAPERCLIP_AUTH_RATE_LIMIT_ENABLED: "false",
    BETTER_AUTH_SECRET: createHash("sha256").update(`e2e-${Date.now()}-${Math.random()}`).digest("hex"),
  });
  const require = createRequire(join(ROOT, "packages/db/package.json"));
  pgSql = require("postgres")(`postgres://paperclip:paperclip@127.0.0.1:${PG_PORT}/paperclip`, { max: 2, onnotice: () => {} });
  const password = createHash("sha256").update(`pw-${Math.random()}`).digest("hex").slice(0, 24);
  const signUp = async (who) => {
    const r = await smust("POST", "/auth/sign-up/email", { email: `${who}@e2e.invalid`, password, name: `E2E ${who}` });
    return { userId: r.json?.user?.id, cookie: r.cookie };
  };
  const health = (await sapi("GET", "/health")).json;
  A.healthBefore = { deploymentMode: health?.deploymentMode, deploymentExposure: health?.deploymentExposure, bootstrapStatus: health?.bootstrapStatus };
  const admin = await signUp("admin");
  const claim = await sapi("POST", "/bootstrap/claim", {}, admin.cookie);
  const anon = await sapi("POST", "/companies", { name: "anon" });
  A.bootstrap = { claim: claim.status, anonCreateCompany: anon.status };
  record("auth.bootstrap_admin_claim", "authenticated/private instance; first signed-up user claims via POST /bootstrap/claim (200); anonymous mutation 401/403",
    { health: A.healthBefore, claim: claim.status, anon: anon.status }, claim.status === 200 && [401, 403].includes(anon.status));
  const C = admin.cookie;
  await smust("PATCH", "/instance/settings/experimental", { enableNativeRunner: true }, C);
  const company = (await smust("POST", "/companies", { name: "E2E auth company 1" }, C)).json;
  const company2 = (await smust("POST", "/companies", { name: "E2E auth company 2" }, C)).json;
  const agentRes = await smust("POST", `/companies/${company.id}/agents`, {
    name: "Bombero E2E auth", role: "engineer", adapterType: "paperclip_runner", inert: true,
    adapterConfig: { provider: "opencode", model: `llamacpp/${MODEL_ID}`, opencodePermissionProfile: "restricted_v1", llamaCppBaseUrl: `http://127.0.0.1:${FIXTURE_PORT}/v1` },
  }, C);
  const agent = agentRes.json;
  await smust("POST", `/agents/${agent.id}/resume`, {}, C);
  const iss = (await smust("POST", `/companies/${company.id}/issues`, { title: "E2E auth permission", status: "todo" }, C)).json;
  const wake = await smust("POST", `/agents/${agent.id}/wakeup`, { source: "on_demand", reason: "e2e_human_invocation", payload: { issueId: iss.id } }, C);
  const runId = wake.json.id;
  A.ids = { companyId: company.id, company2Id: company2.id, agentId: agent.id, runId, adminUserId: admin.userId };
  const req = await waitFor(async () => {
    const st = (await sapi("GET", `/heartbeat-runs/${runId}`, undefined, C)).json?.status;
    if (st && !["queued", "running"].includes(st)) throw new Error(`auth run ended ${st} before a permission request`);
    const evs = (await sapi("GET", `/heartbeat-runs/${runId}/events?afterSeq=0&limit=1000`, undefined, C)).json;
    return pendingPermissions(Array.isArray(evs) ? evs : [])[0];
  }, "auth run permission", 240_000, 1000);
  const cwd = req.permission.cwd;
  const path = `/heartbeat-runs/${runId}/runtime-requests/${encodeURIComponent(req.requestId)}/resolve`;
  const onceBody = (sha) => ({ resolution: { action: "permission_decision", decision: "once", contractSha256: sha } });

  // Users: a non-admin member of the same company and a non-admin member of
  // another company (memberships seeded, users created via the auth API).
  const member = await signUp("member");
  const outsider = await signUp("outsider");
  await pgSql`insert into company_memberships (company_id, principal_type, principal_id, status, membership_role) values (${company.id}, 'user', ${member.userId}, 'active', 'member')`;
  await pgSql`insert into company_memberships (company_id, principal_type, principal_id, status, membership_role) values (${company2.id}, 'user', ${outsider.userId}, 'active', 'member')`;
  // Stale admin session: a second admin session, then the first one signs out.
  const adminStale = admin.cookie;
  const relog = await smust("POST", "/auth/sign-in/email", { email: "admin@e2e.invalid", password }, undefined);
  const signOut = await sapi("POST", "/auth/sign-out", {}, adminStale);
  const C2 = relog.cookie;

  const probes = {
    memberSameCompany: await sapi("POST", path, onceBody(req.permission.contractSha256), member.cookie),
    outsiderOtherCompany: await sapi("POST", path, onceBody(req.permission.contractSha256), outsider.cookie),
    adminSignedOutSession: await sapi("POST", path, onceBody(req.permission.contractSha256), adminStale),
    adminOtherRunSha: await sapi("POST", path, onceBody(foreignSha), C2),
    adminNoOrigin: await (async () => { const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: C2 }, body: JSON.stringify(onceBody(req.permission.contractSha256)) }); return { status: r.status, text: (await r.text()).slice(0, 200) }; })(),
  };
  // Other-run crossing: the request id of this run posted under another run
  // of the same instance does not exist there.
  await sleep(1500);
  const claimsAfterProbes = await pgSql`select decision, status from native_permission_decisions where run_id = ${runId}`;
  A.probes = Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, { status: v.status, body: v.text.slice(0, 200) }]));
  A.signOut = signOut.status;
  record("auth.member_non_admin_403", "non-admin member of the run's company -> 403, no claim", { status: probes.memberSameCompany.status, body: probes.memberSameCompany.text.slice(0, 160) }, probes.memberSameCompany.status === 403);
  record("auth.other_company_user_403_404", "user of another company -> 403/404, no claim", { status: probes.outsiderOtherCompany.status, body: probes.outsiderOtherCompany.text.slice(0, 160) }, [403, 404].includes(probes.outsiderOtherCompany.status));
  record("auth.admin_signed_out_session_401", "admin cookie of a signed-out session -> 401/403, no claim", { signOut: signOut.status, status: probes.adminSignedOutSession.status }, signOut.status === 200 && [401, 403].includes(probes.adminSignedOutSession.status));
  record("auth.admin_other_run_sha_409", "instance admin (fresh session) with another run's contract sha -> 409", { status: probes.adminOtherRunSha.status }, probes.adminOtherRunSha.status === 409);
  record("auth.admin_without_trusted_origin_403", "instance admin session without Origin/Referer -> 403 (board mutation guard)", { status: probes.adminNoOrigin.status, body: probes.adminNoOrigin.text }, probes.adminNoOrigin.status === 403);
  record("auth.zero_dispatch_after_probes", "0 claims, counter 0, request still pending", { claims: claimsAfterProbes.length, counter: counterValue(cwd) }, claimsAfterProbes.length === 0 && counterValue(cwd) === 0);
  // The legitimate admin finally rejects: exactly one claim, delivered.
  const rej = await sapi("POST", path, { resolution: { action: "permission_decision", decision: "reject", contractSha256: req.permission.contractSha256 } }, C2);
  const st = await waitFor(async () => { const s2 = (await sapi("GET", `/heartbeat-runs/${runId}`, undefined, C2)).json?.status; return s2 && !["queued", "running"].includes(s2) ? s2 : null; }, "auth run terminal", 120_000);
  const claimsEnd = await pgSql`select decision, status, resolver_user_id from native_permission_decisions where run_id = ${runId}`;
  A.end = { reject: rej.status, runStatus: st, claims: claimsEnd };
  record("auth.admin_reject_single_claim", "instance admin reject -> 202; exactly one claim (reject, delivered, resolver = admin user); counter 0",
    { reject: rej.status, runStatus: st, claims: claimsEnd.map((c) => `${c.decision}:${c.status}:${c.resolver_user_id === admin.userId ? "admin" : c.resolver_user_id}`), counter: counterValue(cwd) },
    rej.status === 202 && claimsEnd.length === 1 && claimsEnd[0].decision === "reject" && claimsEnd[0].status === "delivered" && claimsEnd[0].resolver_user_id === admin.userId && counterValue(cwd) === 0);
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
