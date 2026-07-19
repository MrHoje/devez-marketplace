#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
const runtime = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "runtime.json"), "utf8"));
const MODES = new Set(["deep-interview", "ralplan", "ultragoal"]);
const GOAL_STATUSES = new Set(["pending", "active", "complete", "failed", "blocked", "review_blocked", "superseded"]);

function now() { return new Date().toISOString(); }
function sha(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function flag(args, name) {
  const inline = args.find(a => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(args, name) { return args.includes(name) || args.some(a => a === name || a.startsWith(`${name}=`)); }
function required(value, message) { if (value === undefined || value === null || value === "") throw new Error(message); return value; }
function safeId(value, label = "id") {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(text)) throw new Error(`${label} must match [A-Za-z0-9._-]{1,128}`);
  return text;
}
function sessionId(args = []) {
  const explicit = flag(args, "--session-id") || process.env.HOJE_SESSION_ID;
  if (explicit) return safeId(explicit, "session id");
  return `shell-${sha(path.resolve(process.cwd())).slice(0, 20)}`;
}
function sessionRoot(cwd, sid) { return path.join(cwd, ".hoje", `_session-${sid}`); }
function resolveAskSettings(cwd) {
  let threshold = 0.2, source = "default"; const envValue = process.env.HOJE_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD;
  const configFile = process.env.HOJE_CONFIG_DIR ? path.join(process.env.HOJE_CONFIG_DIR, "config.json") : path.join(cwd, ".hoje", "config.json");
  if (fs.existsSync(configFile)) { const config = readJson(configFile, {}); const value = config?.hoje?.deepInterview?.ambiguityThreshold; if (value !== undefined) { threshold = Number(value); source = configFile; } }
  if (envValue !== undefined) { threshold = Number(envValue); source = "HOJE_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD"; }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`Hoje Ask ambiguity threshold from ${source} must be between 0 and 1`);
  return { ambiguity_threshold: threshold, threshold_source: source };
}
function stateDir(cwd, sid) { return path.join(sessionRoot(cwd, sid), "state"); }
function statePath(cwd, sid, mode) { return path.join(stateDir(cwd, sid), `${mode}-state.json`); }
function activePath(cwd, sid) { return path.join(stateDir(cwd, sid), "skill-active-state.json"); }
function auditPath(cwd, sid) { return path.join(stateDir(cwd, sid), "audit.jsonl"); }
function ultragoalDir(cwd, sid) { return path.join(sessionRoot(cwd, sid), "ultragoal"); }
function planPath(cwd, sid) { return path.join(ultragoalDir(cwd, sid), "goals.json"); }
function ledgerPath(cwd, sid) { return path.join(ultragoalDir(cwd, sid), "ledger.jsonl"); }
function briefPath(cwd, sid) { return path.join(ultragoalDir(cwd, sid), "brief.md"); }
function ensureParent(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function atomicWrite(file, content) {
  ensureParent(file);
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (error) {
    if (!fs.existsSync(file)) throw error;
    fs.unlinkSync(file);
    fs.renameSync(temp, file);
  }
}
function writeJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`invalid JSON at ${file}: ${error.message}`); }
}
function appendJsonl(file, value) { ensureParent(file); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8"); }
function withSessionLock(cwd, sid, operation) {
  const dir = path.join(cwd, ".hoje", "_locks"); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${safeId(sid, "session id")}.lock`); const deadline = Date.now() + 35000; let fd;
  while (fd === undefined) { try { fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() })); } catch (error) { if (error.code !== "EEXIST") throw error; let stale = false; try { const owner = JSON.parse(fs.readFileSync(file, "utf8")); try { process.kill(owner.pid, 0); } catch (signalError) { stale = signalError.code === "ESRCH"; } if (Date.now() - Date.parse(owner.createdAt) > 120000) stale = true; } catch { try { stale = Date.now() - fs.statSync(file).mtimeMs > 5000; } catch { stale = true; } } if (stale) { try { fs.unlinkSync(file); } catch {} continue; } if (Date.now() >= deadline) throw new Error(`session ${sid} is busy; retry after the active Hoje command completes`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
  try { return operation(); } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} }
}
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const output = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) { if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`unsafe state key ${key}`); output[key] = value && typeof value === "object" && !Array.isArray(value) ? deepMerge(output[key], value) : value; }
  return output;
}
function jsonArg(raw, cwd, label) {
  required(raw, `${label} is required`);
  const candidate = path.resolve(cwd, raw);
  const text = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? fs.readFileSync(candidate, "utf8") : raw;
  try { return JSON.parse(text); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}
function emit(value, asJson = false) { process.stdout.write(asJson || typeof value !== "string" ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`); }
function audit(cwd, sid, event, data = {}) { appendJsonl(auditPath(cwd, sid), { timestamp: now(), event, ...data }); }
function stampJson(file, value, field) {
  delete value[field]; const digest = sha(value);
  value[field] = { algorithm: "sha256", value: digest, covered_path: file, computed_at: now() };
  writeJson(file, value); return value;
}
function verifyJson(file, value, field) {
  if (!value) return value; const proof = value[field];
  if (!proof || proof.algorithm !== "sha256" || typeof proof.value !== "string") throw new Error(`missing integrity proof at ${file}`);
  const body = { ...value }; delete body[field];
  if (sha(body) !== proof.value) throw new Error(`integrity check failed at ${file}`);
  return value;
}
function readState(file, fallback = null) { if (!fs.existsSync(file)) return fallback; return verifyJson(file, readJson(file), "content_sha256"); }
function writeState(file, value) { return stampJson(file, value, "content_sha256"); }

function updateActive(cwd, sid, mode, phase, active) {
  const file = activePath(cwd, sid);
  const current = fs.existsSync(file) ? verifyJson(file, readJson(file), "integrity") : { version: 1, session_id: sid, skills: {} };
  current.skills[mode] = { active, current_phase: phase, updated_at: now() };
  current.active_skill = active ? mode : current.active_skill === mode ? null : current.active_skill;
  current.updated_at = now();
  stampJson(file, current, "integrity");
  return file;
}

function stateCommand(args, cwd) {
  let mode;
  let op;
  if (MODES.has(args[0])) { mode = args[0]; op = args[1]; args = args.slice(2); }
  else { op = args[0]; args = args.slice(1); mode = flag(args, "--mode") || flag(args, "--skill"); }
  if (op === "doctor") {
    if (mode && !MODES.has(mode)) throw new Error(`unknown state skill ${mode}`);
    const sid = sessionId(args);
    let integrityError = null; try { if (mode && fs.existsSync(statePath(cwd, sid, mode))) readState(statePath(cwd, sid, mode)); if (fs.existsSync(activePath(cwd, sid))) verifyJson(activePath(cwd, sid), readJson(activePath(cwd, sid)), "integrity"); if (mode === "ultragoal" && fs.existsSync(planPath(cwd, sid))) { readPlan(cwd, sid); readLedger(cwd, sid); } } catch (error) { integrityError = error.message; }
    const result = { ok: !integrityError, runtime: runtime.runtime, version: runtime.runtimeVersion, session_id: sid, skill: mode ?? null, state_exists: mode ? fs.existsSync(statePath(cwd, sid, mode)) : null, integrity_ok: !integrityError, integrity_error: integrityError, ...(mode === "deep-interview" ? resolveAskSettings(cwd) : {}) };
    emit(result, true); if (integrityError) process.exitCode = 1; return;
  }
  required(mode, "state command requires a skill/mode");
  if (!MODES.has(mode)) throw new Error(`unknown state mode ${mode}`);
  const sid = sessionId(args);
  const file = statePath(cwd, sid, mode);
  if (op === "read") { emit({ skill: mode, state: readState(file, {}), storage_path: file, ...(mode === "deep-interview" ? { settings: resolveAskSettings(cwd) } : {}) }, true); return; }
  if (op === "clear") {
    if (!has(args, "--force")) throw new Error("state clear requires --force");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (mode === "ultragoal") { const target = ultragoalDir(cwd, sid); const expectedParent = sessionRoot(cwd, sid); if (path.dirname(target) !== expectedParent) throw new Error("refusing unsafe ultragoal cleanup target"); fs.rmSync(target, { recursive: true, force: true }); }
    try { updateActive(cwd, sid, mode, "cleared", false); } catch (error) { const recovered = { version: 1, session_id: sid, active_skill: null, skills: { [mode]: { active: false, current_phase: "cleared", updated_at: now() } }, updated_at: now(), recovered_from_integrity_error: error.message }; stampJson(activePath(cwd, sid), recovered, "integrity"); }
    audit(cwd, sid, "state_cleared", { skill: mode });
    emit({ ok: true, skill: mode, session_id: sid, cleared: true }, true); return;
  }
  if (op === "handoff") {
    const target = required(flag(args, "--to"), "state handoff requires --to");
    if (!MODES.has(target)) throw new Error(`unsupported handoff target ${target}`);
    const source = readState(file, { skill: mode, version: 1, state_revision: 0 });
    source.current_phase = "handoff"; source.active = false; source.updated_at = now(); source.state_revision = (source.state_revision || 0) + 1;
    writeState(file, source);
    const targetFile = statePath(cwd, sid, target);
    const next = readState(targetFile, { skill: target, version: 1, state_revision: 0 });
    next.current_phase = next.current_phase || "seeded"; next.active = true; next.handoff_from = mode; next.updated_at = now(); next.state_revision = (next.state_revision || 0) + 1;
    writeState(targetFile, next); updateActive(cwd, sid, mode, "handoff", false); updateActive(cwd, sid, target, next.current_phase, true);
    audit(cwd, sid, "state_handoff", { from: mode, to: target }); emit({ ok: true, from: mode, to: target, session_id: sid }, true); return;
  }
  if (op === "write") {
    const input = jsonArg(required(flag(args, "--input"), "state write requires --input"), cwd, "--input");
    const previous = readState(file, { skill: mode, version: 1, state_revision: 0, state: {} });
    const merged = deepMerge(previous, input);
    merged.skill = mode; merged.version = 1; merged.session_id = sid; merged.active = merged.active !== false; merged.updated_at = now(); merged.state_revision = (previous.state_revision || 0) + 1;
    if (mode === "deep-interview") { const settings = resolveAskSettings(cwd); merged.state = merged.state || {}; merged.state.rounds = merged.state.rounds || []; merged.state.established_facts = merged.state.established_facts || []; if (merged.state.threshold === undefined) merged.state.threshold = settings.ambiguity_threshold; if (merged.state.threshold_source === undefined) merged.state.threshold_source = settings.threshold_source; }
    writeState(file, merged); updateActive(cwd, sid, mode, merged.current_phase || "active", merged.active); audit(cwd, sid, "state_written", { skill: mode, revision: merged.state_revision });
    emit({ ok: true, skill: mode, state_path: file, current_phase: merged.current_phase ?? null, active: merged.active, state_revision: merged.state_revision }, true); return;
  }
  throw new Error(`unknown state operation ${op || "<missing>"}`);
}

function deepInterviewCommand(args, cwd) {
  if (!has(args, "--write")) throw new Error("deep-interview currently requires --write");
  const sid = sessionId(args); const stage = flag(args, "--stage") || "final"; if (stage !== "final") throw new Error("deep-interview --write currently supports only --stage final");
  const slug = safeId(required(flag(args, "--slug"), "deep-interview --write requires --slug"), "spec slug"); let spec = required(flag(args, "--spec"), "deep-interview --write requires --spec"); const candidate = path.resolve(cwd, spec); if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) spec = fs.readFileSync(candidate, "utf8"); if (!String(spec).trim()) throw new Error("deep-interview spec must not be empty");
  const specPath = path.join(sessionRoot(cwd, sid), "specs", `deep-interview-${slug}.md`); atomicWrite(specPath, String(spec).endsWith("\n") ? String(spec) : `${spec}\n`);
  const stateFile = statePath(cwd, sid, "deep-interview"); const current = readState(stateFile, { skill: "deep-interview", version: 1, session_id: sid, state_revision: 0, state: { rounds: [], established_facts: [] } });
  current.spec_path = specPath; current.current_phase = has(args, "--deliberate") ? "handoff" : "pending_approval"; current.active = !has(args, "--deliberate"); current.updated_at = now(); current.state_revision = (current.state_revision || 0) + 1; writeState(stateFile, current);
  const receipt = { run_id: `ask-${Date.now()}-${sha(spec).slice(0, 8)}`, stage, path: specPath, sha256: sha(fs.readFileSync(specPath)), created_at: now(), deliberate: has(args, "--deliberate") };
  if (has(args, "--deliberate")) { const planFile = statePath(cwd, sid, "ralplan"); const prompt = `Refine and approve the Hoje Ask specification at ${specPath}`; const planState = { skill: "ralplan", version: 1, session_id: sid, run_id: `rp-${Date.now()}-${sha(prompt).slice(0, 8)}`, prompt, source_spec_path: specPath, current_phase: "planning", active: true, mode: "deliberate", interactive: false, stage_n: 0, created_at: now(), updated_at: now(), state_revision: 1 }; writeState(planFile, planState); updateActive(cwd, sid, "deep-interview", "handoff", false); updateActive(cwd, sid, "ralplan", "planning", true); receipt.handoff = "ralplan"; receipt.ralplan_run_id = planState.run_id; }
  else updateActive(cwd, sid, "deep-interview", "pending_approval", true);
  audit(cwd, sid, "deep_interview_spec_written", receipt); emit(receipt, has(args, "--json"));
}

function ralplanCommand(args, cwd) {
  const sid = sessionId(args); const file = statePath(cwd, sid, "ralplan");
  if (!has(args, "--write")) {
    const values = new Set(["--architect", "--critic", "--session-id"]);
    const promptParts = [];
    for (let i = 0; i < args.length; i++) { if (values.has(args[i])) { i++; continue; } if (!args[i].startsWith("--")) promptParts.push(args[i]); }
    const prompt = promptParts.join(" ").trim(); required(prompt, "ralplan requires a task description");
    const runId = `rp-${Date.now()}-${sha(prompt).slice(0, 8)}`;
    const state = { skill: "ralplan", version: 1, session_id: sid, run_id: runId, prompt, current_phase: "planning", active: true, mode: has(args, "--deliberate") ? "deliberate" : "short", interactive: has(args, "--interactive"), stage_n: 0, created_at: now(), updated_at: now(), state_revision: 1 };
    writeState(file, state); updateActive(cwd, sid, "ralplan", "planning", true); audit(cwd, sid, "ralplan_seeded", { run_id: runId });
    emit(`Hoje Plan seeded run_id=${runId}\nstate_path=${file}\nmode=${state.mode} interactive=${state.interactive}\nhandoff=/hoje-code:hoje-plan`); return;
  }
  const stages = new Set(["planner", "architect", "critic", "revision", "post-interview", "adr", "final"]);
  const stage = required(flag(args, "--stage"), "ralplan --write requires --stage"); if (!stages.has(stage)) throw new Error(`unsupported ralplan stage ${stage}`);
  const stageN = Number(required(flag(args, "--stage_n") || flag(args, "--stage-n"), "ralplan --write requires --stage_n")); if (!Number.isInteger(stageN) || stageN < 1) throw new Error("stage_n must be a positive integer");
  const envName = flag(args, "--artifact-env"); let artifact = envName ? process.env[envName] : flag(args, "--artifact"); required(artifact, "ralplan --write requires --artifact or --artifact-env");
  const resolved = path.resolve(cwd, artifact); if (!envName && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) artifact = fs.readFileSync(resolved, "utf8");
  if (!String(artifact).trim()) throw new Error("ralplan artifact must not be empty");
  const current = readState(file, {}); const runId = flag(args, "--run-id") || current.run_id || `rp-${Date.now()}-${sha(artifact).slice(0, 8)}`;
  const dir = path.join(sessionRoot(cwd, sid), "plans", "ralplan", safeId(runId, "run id")); const artifactPath = path.join(dir, `stage-${String(stageN).padStart(2, "0")}-${stage}.md`);
  atomicWrite(artifactPath, String(artifact).endsWith("\n") ? String(artifact) : `${artifact}\n`); const digest = sha(fs.readFileSync(artifactPath));
  const receipt = { run_id: runId, stage, stage_n: stageN, path: artifactPath, sha256: digest, created_at: now() };
  for (const key of ["planner-id", "planner-resumable", "fallback-reason", "fallback-attempted-id", "fallback-stage-n", "fallback-receipt-path"]) { const value = flag(args, `--${key}`); if (value !== undefined) receipt[key.replaceAll("-", "_")] = value; }
  appendJsonl(path.join(dir, "index.jsonl"), receipt); if (stage === "final") atomicWrite(path.join(dir, "pending-approval.md"), fs.readFileSync(artifactPath, "utf8"));
  const next = deepMerge(current, { skill: "ralplan", version: 1, session_id: sid, run_id: runId, current_phase: stage === "final" ? "pending_approval" : stage, active: true, stage_n: stageN, latest_receipt: receipt, updated_at: now(), state_revision: (current.state_revision || 0) + 1 });
  writeState(file, next); updateActive(cwd, sid, "ralplan", next.current_phase, true); audit(cwd, sid, "ralplan_stage_written", receipt); emit(receipt, has(args, "--json"));
}

function readPlan(cwd, sid) { const file = planPath(cwd, sid); const plan = readJson(file); if (!plan) throw new Error("no active Hoje Goals plan found"); return verifyJson(file, plan, "integrity"); }
function writePlan(cwd, sid, plan) { plan.updatedAt = now(); stampJson(planPath(cwd, sid), plan, "integrity"); }
function readLedger(cwd, sid) { const file = ledgerPath(cwd, sid); if (!fs.existsSync(file)) return []; const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch (error) { throw new Error(`invalid ledger JSON at line ${index + 1}: ${error.message}`); } }); let previousHash = null; for (const [index, row] of rows.entries()) { if (row.previousHash !== previousHash || typeof row.hash !== "string") throw new Error(`ledger chain failed at line ${index + 1}`); const body = { ...row }; delete body.hash; if (sha(body) !== row.hash) throw new Error(`ledger integrity failed at line ${index + 1}`); previousHash = row.hash; } return rows; }
function appendLedger(cwd, sid, event, data = {}) { const rows = readLedger(cwd, sid); const row = { id: `evt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`, timestamp: now(), event, ...data, previousHash: rows.at(-1)?.hash || null }; row.hash = sha(row); appendJsonl(ledgerPath(cwd, sid), row); return row; }
function parseGoals(brief) {
  const lines = brief.replace(/\r\n/g, "\n").split("\n"); const goals = []; let current = null;
  for (const line of lines) { const match = line.match(/^\s*@goal:\s*(.+?)\s*$/); if (match) { if (current) goals.push(current); current = { title: match[1], body: [] }; } else if (current) current.body.push(line); }
  if (current) goals.push(current);
  if (!goals.length) { const first = lines.find(line => line.trim())?.trim() || "Complete requested work"; goals.push({ title: first.slice(0, 120), body: lines.slice(1) }); }
  return goals.map((goal, index) => ({ id: `G${String(index + 1).padStart(3, "0")}`, title: goal.title, objective: goal.body.join("\n").trim() || goal.title, status: "pending", createdAt: now(), updatedAt: now() }));
}
function nonempty(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`qualityGate ${label} must be a non-empty string`); }
function emptyBlockers(value, label) { if (!Array.isArray(value) || value.length) throw new Error(`qualityGate ${label} must be an empty blockers array`); }
function stringArray(value, label) { if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(`qualityGate ${label} must be a non-empty string array`); }
function blockersArray(value, label) { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); }
function plainObject(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); }
function normalizeOutput(value) { return String(value ?? "").replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trimEnd(); }
function validateCliReplay(artifact, cwd, file, artifacts) {
  const replay = jsonArg(file, cwd, "CLI replay artifact"); if (replay.schemaVersion !== 1 || replay.kind !== "cli-replay" || replay.replaySafe !== true) throw new Error(`invalid CLI replay header at ${file}`);
  if (!Array.isArray(replay.command) || !replay.command.length || replay.command.some(item => typeof item !== "string" || !item)) throw new Error(`CLI replay command must be a non-empty argv array at ${file}`);
  if (replay.normalization !== undefined && replay.normalization !== "default") throw new Error(`CLI replay normalization must be default at ${file}`);
  if (replay.replayExempt) { const exempt = replay.replayExempt; const reasons = new Set(["unsafe_side_effect", "requires_credentials", "requires_network", "non_deterministic_external", "destructive", "interactive_only", "platform_unavailable"]); if (!reasons.has(exempt.reasonCode) || typeof exempt.reason !== "string" || exempt.reason.trim().length < 16 || typeof exempt.approvedBy !== "string" || !exempt.approvedBy.trim()) throw new Error(`invalid CLI replay exemption at ${file}`); stringArray(exempt.fallbackArtifactRefs, "replayExempt.fallbackArtifactRefs"); for (const id of exempt.fallbackArtifactRefs) { const fallback = artifacts.get(id); if (!fallback || id === artifact.id || fallback.kind.toLowerCase() === "cli-replay" || !/cli|transcript|test-report/.test(fallback.kind.toLowerCase())) throw new Error(`invalid same-surface replay fallback artifact ${id}`); } return; }
  const executable = path.basename(replay.command[0]).toLowerCase().replace(/\.exe$|\.cmd$/, ""); const argv = replay.command.slice(1); let allowed = false; let command = replay.command[0];
  if (executable === "node") { allowed = (argv.length === 1 && ["--version", "-v"].includes(argv[0])) || (argv.length === 2 && argv[0] === "-e" && /^console\.log\((['"])[\s\S]*\1\);?$/.test(argv[1])); command = process.execPath; }
  else if (["npm", "pnpm", "yarn"].includes(executable) && path.basename(replay.command[0]) === replay.command[0]) allowed = (argv.length === 1 && ["--version", "-v"].includes(argv[0])) || (argv[0] === "list" && argv.slice(1).every(item => /^(--json|--all|--depth=\d+|--omit=(dev|optional|peer))$/.test(item)));
  else if (executable === "git" && path.basename(replay.command[0]) === replay.command[0]) allowed = argv.length >= 1 && ["status", "rev-parse", "merge-base", "diff", "show", "log"].includes(argv[0]) && argv.slice(1).every(item => !/[;&|><]/.test(item) && !/^(--output|--exec|--config|-c$)/.test(item));
  else if (executable === "hoje") { allowed = (argv[0] === "state" && argv.includes("read")) || (argv[0] === "ultragoal" && argv[1] === "status"); command = process.execPath; argv.unshift(path.join(PLUGIN_ROOT, "scripts", "hoje-runtime.js")); }
  if (!allowed) throw new Error(`CLI replay command is not allowlisted at ${file}`);
  const safeEnv = {}; for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) safeEnv[key] = process.env[key]; for (const [key, value] of Object.entries(replay.env || {})) { if (!["LC_ALL", "LANG", "TZ", "NO_COLOR"].includes(key) || typeof value !== "string") throw new Error(`unsafe CLI replay env ${key}`); safeEnv[key] = value; }
  const runCwd = path.resolve(cwd, replay.cwd || "."); const realCwd = fs.realpathSync(cwd); if (!fs.existsSync(runCwd) || !fs.statSync(runCwd).isDirectory()) throw new Error(`CLI replay cwd is missing at ${file}`); const realRunCwd = fs.realpathSync(runCwd); if (realRunCwd !== realCwd && !realRunCwd.startsWith(realCwd + path.sep)) throw new Error(`CLI replay cwd escapes the workspace at ${file}`);
  const timeout = replay.timeoutMs ?? 30000; if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error(`invalid CLI replay timeout at ${file}`);
  const result = spawnSync(command, argv, { cwd: runCwd, env: safeEnv, encoding: "utf8", timeout, windowsHide: true }); if (result.error) throw new Error(`CLI replay failed at ${file}: ${result.error.message}`);
  const expectedExit = replay.expectedExitCode ?? 0; if (result.status !== expectedExit) throw new Error(`CLI replay exit mismatch at ${file}: expected ${expectedExit}, got ${result.status}`);
  const stdout = normalizeOutput(result.stdout), stderr = normalizeOutput(result.stderr); const invariants = replay.invariants;
  if (invariants !== undefined) { if (!Array.isArray(invariants) || !invariants.length) throw new Error(`CLI replay invariants must be non-empty at ${file}`); for (const invariant of invariants) { plainObject(invariant, "CLI replay invariant"); nonempty(invariant.value, "CLI replay invariant value"); if (invariant.type === "substring" && !stdout.includes(invariant.value)) throw new Error(`CLI replay substring invariant failed at ${file}`); else if (invariant.type === "not-substring" && `${stdout}\n${stderr}`.includes(invariant.value)) throw new Error(`CLI replay not-substring invariant failed at ${file}`); else if (invariant.type === "regex") { if (invariant.value.length > 200 || /(\.[*+]|\[[^\]]+\][*+]|\([^)]*[*+][^)]*\))[*+{]/.test(invariant.value)) throw new Error(`unsafe CLI replay regex at ${file}`); let expression; try { expression = new RegExp(invariant.value); } catch { throw new Error(`invalid CLI replay regex at ${file}`); } if (!expression.test(stdout)) throw new Error(`CLI replay regex invariant failed at ${file}`); } else if (!["substring", "not-substring", "regex"].includes(invariant.type)) throw new Error(`unsupported CLI replay invariant at ${file}`); } }
  else { if (typeof replay.recordedStdout !== "string") throw new Error(`CLI replay recordedStdout is required at ${file}`); if (stdout !== normalizeOutput(replay.recordedStdout)) throw new Error(`CLI replay stdout mismatch at ${file}`); }
  if (replay.recordedStderr !== undefined && stderr !== normalizeOutput(replay.recordedStderr)) throw new Error(`CLI replay stderr mismatch at ${file}`);
}
function validateExecutorQa(qa, cwd, strict = false) {
  if (!qa || typeof qa !== "object") throw new Error("qualityGate executorQa must be an object");
  for (const key of ["status", "e2eStatus", "redTeamStatus"]) if (qa[key] !== "passed") throw new Error(`qualityGate executorQa.${key} must be passed`);
  nonempty(qa.evidence, "executorQa.evidence"); stringArray(qa.e2eCommands, "executorQa.e2eCommands"); stringArray(qa.redTeamCommands, "executorQa.redTeamCommands"); emptyBlockers(qa.blockers, "executorQa.blockers");
  for (const key of ["artifactRefs", "contractCoverage", "surfaceEvidence", "adversarialCases"]) if (!Array.isArray(qa[key]) || !qa[key].length) throw new Error(`qualityGate executorQa.${key} must be a non-empty array`);
  if (strict && (qa.adversarialCases.length < 2 || qa.redTeamCommands.length < 2)) throw new Error("strict qualityGate requires at least two adversarial cases and red-team commands");
  const artifactIds = new Set(), artifacts = new Map();
  for (const row of qa.artifactRefs) { plainObject(row, "artifactRefs[]"); nonempty(row.id, "executorQa.artifactRefs[].id"); nonempty(row.kind, "executorQa.artifactRefs[].kind"); nonempty(row.path, "executorQa.artifactRefs[].path"); nonempty(row.description, "executorQa.artifactRefs[].description"); if (artifactIds.has(row.id)) throw new Error(`duplicate artifact id ${row.id}`); artifactIds.add(row.id); const target = path.resolve(cwd, row.path); if (!target.startsWith(path.resolve(cwd) + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) throw new Error(`qualityGate artifact does not exist or is empty under cwd: ${row.path}`); const realTarget = fs.realpathSync(target), realCwd = fs.realpathSync(cwd); if (!realTarget.startsWith(realCwd + path.sep)) throw new Error(`qualityGate artifact escapes cwd through a link: ${row.path}`); artifacts.set(row.id, { ...row, target }); }
  const surfaceIds = new Set(), adversarialIds = new Set();
  for (const row of qa.surfaceEvidence) { plainObject(row, "surfaceEvidence[]"); nonempty(row.id, "surfaceEvidence[].id"); if (surfaceIds.has(row.id)) throw new Error(`duplicate surfaceEvidence id ${row.id}`); surfaceIds.add(row.id); nonempty(row.contractRef, "surfaceEvidence[].contractRef"); nonempty(row.surface, "surfaceEvidence[].surface"); if (row.status === "not_applicable") nonempty(row.reason, "surfaceEvidence[].reason"); else { nonempty(row.invocation, "surfaceEvidence[].invocation"); if (row.verdict !== "passed") throw new Error("surfaceEvidence verdict must be passed"); stringArray(row.artifactRefs, "surfaceEvidence[].artifactRefs"); const refs = row.artifactRefs.map(id => { if (!artifactIds.has(id)) throw new Error(`surfaceEvidence references unknown artifact ${id}`); return artifacts.get(id); }); const kinds = refs.map(ref => ref.kind.toLowerCase()); const surface = row.surface.toLowerCase(); if (surface === "cli") { const replay = refs.find(ref => ref.kind.toLowerCase() === "cli-replay"); if (!replay) throw new Error("CLI surface requires a cli-replay artifact"); validateCliReplay(replay, cwd, replay.target, artifacts); } else if (["gui", "web"].includes(surface)) { const screenshot = refs.find(ref => /screenshot|image/.test(ref.kind.toLowerCase())), transcript = refs.find(ref => /automation|transcript/.test(ref.kind.toLowerCase())); if (!screenshot || !transcript) throw new Error(`${surface} surface requires screenshot and automation transcript artifacts`); const bytes = fs.readFileSync(screenshot.target), isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8; if ((!isPng && !isJpeg) || bytes.length < 128 || new Set(bytes).size < 8) throw new Error(`${surface} screenshot artifact is invalid, empty, or uniform`); } else if (["native", "desktop", "tui"].includes(surface)) { const proof = refs.find(ref => /screenshot|pty|automation|transcript/.test(ref.kind.toLowerCase())); if (!proof) throw new Error(`${surface} surface requires screenshot, PTY, or automation evidence`); if (/pty/.test(proof.kind.toLowerCase()) && !fs.readFileSync(proof.target).includes(Buffer.from("\x1b["))) throw new Error(`${surface} PTY artifact lacks terminal control codes`); } else if (["api", "package"].includes(surface)) { if (!kinds.some(kind => /api|package|consumer|black-box|test-report/.test(kind))) throw new Error(`${surface} surface artifact kind is not suitable`); } else if (["algorithm", "math"].includes(surface)) { if (!kinds.some(kind => /property|boundary|edge|adversarial|failure|math|algorithm|test-report/.test(kind))) throw new Error(`${surface} surface artifact kind is not suitable`); } else throw new Error(`unsupported surface ${row.surface}`); } }
  for (const row of qa.adversarialCases) { plainObject(row, "adversarialCases[]"); nonempty(row.id, "adversarialCases[].id"); if (adversarialIds.has(row.id)) throw new Error(`duplicate adversarial case id ${row.id}`); adversarialIds.add(row.id); nonempty(row.contractRef, "adversarialCases[].contractRef"); nonempty(row.scenario, "adversarialCases[].scenario"); nonempty(row.expectedBehavior, "adversarialCases[].expectedBehavior"); if (row.verdict !== "passed") throw new Error("adversarialCases verdict must be passed"); stringArray(row.artifactRefs, "adversarialCases[].artifactRefs"); for (const id of row.artifactRefs) if (!artifactIds.has(id)) throw new Error(`adversarialCases references unknown artifact ${id}`); }
  const coverageIds = new Set(); for (const row of qa.contractCoverage) { plainObject(row, "contractCoverage[]"); nonempty(row.id, "contractCoverage[].id"); if (coverageIds.has(row.id)) throw new Error(`duplicate contractCoverage id ${row.id}`); coverageIds.add(row.id); nonempty(row.contractRef, "contractCoverage[].contractRef"); if (row.status === "not_applicable") nonempty(row.reason, "contractCoverage[].reason"); else { nonempty(row.obligation, "contractCoverage[].obligation"); if (row.status !== "covered") throw new Error("contractCoverage status must be covered or not_applicable"); stringArray(row.surfaceEvidenceRefs, "contractCoverage[].surfaceEvidenceRefs"); stringArray(row.adversarialCaseRefs, "contractCoverage[].adversarialCaseRefs"); for (const id of row.surfaceEvidenceRefs) if (!surfaceIds.has(id)) throw new Error(`contractCoverage references unknown surface ${id}`); for (const id of row.adversarialCaseRefs) if (!adversarialIds.has(id)) throw new Error(`contractCoverage references unknown adversarial case ${id}`); } }
}
function validateGate(gate, cwd, intensity = "standard") {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new Error("quality gate must be an object");
  const review = gate.architectReview; if (!review || typeof review !== "object") throw new Error("qualityGate architectReview must be an object");
  for (const key of ["architectureStatus", "productStatus", "codeStatus"]) if (review[key] !== "CLEAR") throw new Error(`qualityGate architectReview.${key} must be CLEAR`);
  if (review.recommendation !== "APPROVE") throw new Error("qualityGate architectReview.recommendation must be APPROVE"); nonempty(review.evidence, "architectReview.evidence"); stringArray(review.commands, "architectReview.commands"); emptyBlockers(review.blockers, "architectReview.blockers");
  validateExecutorQa(gate.executorQa, cwd, intensity === "strict"); const iteration = gate.iteration; if (!iteration || iteration.status !== "passed" || iteration.fullRerun !== true) throw new Error("qualityGate iteration must be passed with fullRerun true"); nonempty(iteration.evidence, "iteration.evidence"); stringArray(iteration.rerunCommands, "iteration.rerunCommands"); emptyBlockers(iteration.blockers, "iteration.blockers");
}
function validateLightGate(gate) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new Error("light quality gate must be an object");
  const review = gate.selfReview; if (!review || review.status !== "CLEAR") throw new Error("light qualityGate selfReview.status must be CLEAR");
  nonempty(review.evidence, "selfReview.evidence"); stringArray(review.commands, "selfReview.commands"); emptyBlockers(review.blockers, "selfReview.blockers");
  const verification = gate.verification; if (!verification || verification.status !== "passed") throw new Error("light qualityGate verification.status must be passed");
  nonempty(verification.evidence, "verification.evidence"); stringArray(verification.commands, "verification.commands"); emptyBlockers(verification.blockers, "verification.blockers");
  const iteration = gate.iteration; if (!iteration || iteration.status !== "passed" || iteration.fullRerun !== true) throw new Error("light qualityGate iteration must be passed with fullRerun true");
  nonempty(iteration.evidence, "iteration.evidence"); stringArray(iteration.rerunCommands, "iteration.rerunCommands"); emptyBlockers(iteration.blockers, "iteration.blockers");
}
function metadataDigest(metadata) { const { metadataHash, ...body } = metadata || {}; return sha(body); }
function validateValidationBatches(batches, goals) {
  if (!Array.isArray(batches)) throw new Error("validation-batch-json must be an array");
  const goalIds = new Set(goals.map(goal => goal.id)); const seenBatches = new Set(); const seenMembers = new Set();
  return batches.map(batch => {
    plainObject(batch, "validation batch"); const batchId = safeId(required(batch.batchId, "validation batch requires batchId"), "batch id");
    if (seenBatches.has(batchId)) throw new Error(`duplicate validation batch ${batchId}`); seenBatches.add(batchId);
    if (batch.schemaVersion !== 1) throw new Error(`validation batch ${batchId} schemaVersion must be 1`);
    if (!Array.isArray(batch.memberIds) || batch.memberIds.length < 2 || new Set(batch.memberIds).size !== batch.memberIds.length) throw new Error(`validation batch ${batchId} requires at least two unique memberIds`);
    for (const id of batch.memberIds) { if (!goalIds.has(id)) throw new Error(`validation batch ${batchId} references unknown goal ${id}`); if (seenMembers.has(id)) throw new Error(`goal ${id} belongs to multiple validation batches`); seenMembers.add(id); }
    if (!batch.memberIds.includes(batch.finalGoalId)) throw new Error(`validation batch ${batchId} finalGoalId must be a member`);
    const normalized = { schemaVersion: 1, batchId, memberIds: [...batch.memberIds], finalGoalId: batch.finalGoalId };
    normalized.metadataHash = sha(normalized); return normalized;
  });
}
function validateDeferredGate(gate, batch, goal) {
  if (Object.keys(gate).length !== 1 || !gate.deferredToBatch) throw new Error("non-final validation-batch gate must contain only deferredToBatch");
  const d = gate.deferredToBatch; plainObject(d, "deferredToBatch");
  if (d.kind !== "validation-batch-deferred" || d.batchId !== batch.batchId || d.memberGoalId !== goal.id) throw new Error("deferredToBatch identity does not match the validation batch member");
  for (const [key, label] of [["targetedVerification", "targetedVerification"], ["cleaner", "cleaner"]]) { const check = d[key]; plainObject(check, `deferredToBatch.${label}`); if (check.status !== "passed") throw new Error(`deferredToBatch.${label}.status must be passed`); nonempty(check.evidence, `deferredToBatch.${label}.evidence`); emptyBlockers(check.blockers, `deferredToBatch.${label}.blockers`); if (key === "targetedVerification") stringArray(check.commands, `deferredToBatch.${label}.commands`); }
  if (!d.iteration || d.iteration.status !== "passed" || d.iteration.fullRerun !== true) throw new Error("deferredToBatch.iteration must be passed with fullRerun true");
  nonempty(d.iteration.evidence, "deferredToBatch.iteration.evidence"); stringArray(d.iteration.rerunCommands, "deferredToBatch.iteration.rerunCommands"); emptyBlockers(d.iteration.blockers, "deferredToBatch.iteration.blockers");
  plainObject(d.changeSet, "deferredToBatch.changeSet"); if (d.changeSet.cumulativeFromBase !== true) throw new Error("deferredToBatch.changeSet.cumulativeFromBase must be true"); stringArray(d.changeSet.paths, "deferredToBatch.changeSet.paths");
  return { batchId: batch.batchId, metadataHash: batch.metadataHash, changeSetHash: sha(d.changeSet), changeSetPaths: [...d.changeSet.paths] };
}
function validateBatchClose(gate, batch, plan) {
  const close = gate.validationBatchClose; plainObject(close, "validationBatchClose");
  if (close.kind !== "validation-batch-close" || close.batchId !== batch.batchId || close.finalGoalId !== batch.finalGoalId) throw new Error("validationBatchClose identity does not match the final member");
  if (!Array.isArray(close.memberIds) || stable(close.memberIds) !== stable(batch.memberIds)) throw new Error("validationBatchClose.memberIds must exactly match the batch");
  plainObject(close.memberReceiptIds, "validationBatchClose.memberReceiptIds"); plainObject(close.memberMetadataHashes, "validationBatchClose.memberMetadataHashes"); plainObject(close.memberChangeSetHashes, "validationBatchClose.memberChangeSetHashes");
  const allPaths = new Set();
  for (const id of batch.memberIds.filter(id => id !== batch.finalGoalId)) { const member = plan.goals.find(goal => goal.id === id); if (member?.status !== "complete" || !member.completionVerification?.deferredToBatch) throw new Error(`validation batch member ${id} is not freshly deferred-complete`); const proof = member.completionVerification.deferredToBatch; if (close.memberReceiptIds[id] !== member.completionVerification.receiptId || close.memberMetadataHashes[id] !== proof.metadataHash || close.memberChangeSetHashes[id] !== proof.changeSetHash) throw new Error(`validationBatchClose proof mismatch for ${id}`); for (const item of proof.changeSetPaths) allPaths.add(item); }
  plainObject(close.unionChangeSet, "validationBatchClose.unionChangeSet"); if (close.unionChangeSet.cumulativeFromBase !== true) throw new Error("validationBatchClose.unionChangeSet.cumulativeFromBase must be true"); stringArray(close.unionChangeSet.paths, "validationBatchClose.unionChangeSet.paths"); for (const item of allPaths) if (!close.unionChangeSet.paths.includes(item)) throw new Error(`validationBatchClose union is missing ${item}`);
  nonempty(close.evidence, "validationBatchClose.evidence");
}
function currentGoal(plan, retry = false) { return plan.goals.find(g => g.status === "active") || plan.goals.find(g => g.status === "pending" || (retry && g.status === "failed")); }
function planStatus(plan) { if (plan.goals.every(g => ["complete", "superseded"].includes(g.status))) return "complete"; if (plan.goals.some(g => g.status === "active")) return "active"; if (plan.goals.some(g => ["failed", "blocked", "review_blocked"].includes(g.status))) return "blocked"; return "pending"; }
function goalSummary(plan, cwd, sid) { readLedger(cwd, sid); const counts = {}; for (const status of GOAL_STATUSES) counts[status] = plan.goals.filter(g => g.status === status).length; return { exists: true, status: planStatus(plan), intensity: plan.intensity, paths: { dir: ultragoalDir(cwd, sid), briefPath: briefPath(cwd, sid), goalsPath: planPath(cwd, sid), ledgerPath: ledgerPath(cwd, sid) }, hojeObjective: plan.hojeObjective, currentGoal: currentGoal(plan, true) || null, counts, goals: plan.goals, pipelineOverlap: plan.pipelineOverlap || null, validationBatches: plan.validationBatches || [] }; }

function ultragoalCommand(args, cwd) {
  const op = args[0]; args = args.slice(1); const sid = sessionId(args); const asJson = has(args, "--json");
  if (op === "create-goals") {
    let brief = flag(args, "--brief"); const briefFile = flag(args, "--brief-file"); if (briefFile) brief = fs.readFileSync(path.resolve(cwd, briefFile), "utf8"); if (has(args, "--from-stdin")) brief = fs.readFileSync(0, "utf8"); required(brief, "create-goals requires --brief, --brief-file, or --from-stdin");
    if (fs.existsSync(planPath(cwd, sid))) throw new Error("an ultragoal plan already exists for this session; clear ultragoal state before creating another");
    const goals = parseGoals(brief); const metadata = flag(args, "--goal-metadata-json") ? jsonArg(flag(args, "--goal-metadata-json"), cwd, "--goal-metadata-json") : null;
    const batchInput = flag(args, "--validation-batch-json") ? jsonArg(flag(args, "--validation-batch-json"), cwd, "--validation-batch-json") : [];
    const goalMode = flag(args, "--hoje-goal-mode") || "aggregate";
    if (metadata && batchInput.length) throw new Error("pipeline metadata and validation batches are mutually exclusive");
    if (batchInput.length && goalMode !== "aggregate") throw new Error("validation batches require aggregate goal mode");
    if (metadata) { const rows = Array.isArray(metadata) ? metadata : Object.values(metadata); for (const row of rows) { plainObject(row, "pipeline metadata"); const goal = goals.find(g => g.id === row.goalId || g.id === row.id); if (!goal) throw new Error(`pipeline metadata references unknown goal ${row.goalId || row.id}`); goal.pipelineMetadata = { ...row, metadataHash: sha(row) }; } }
    const batches = validateValidationBatches(batchInput, goals);
    for (const batch of batches) for (const id of batch.memberIds) goals.find(goal => goal.id === id).validationBatch = { batchId: batch.batchId, final: id === batch.finalGoalId, metadataHash: batch.metadataHash };
    const intensity = has(args, "--strict") ? "strict" : has(args, "--light") ? "light" : "standard";
    const plan = { version: 1, runtime: runtime.runtime, sourceGjcVersion: runtime.sourceGjcVersion, hojeObjective: "Complete the durable Hoje Goals plan under the original brief constraints; use ledger.jsonl as the audit trail.", brief, hojeGoalMode: goalMode, intensity, createdAt: now(), updatedAt: now(), goals, validationBatches: batches };
    atomicWrite(briefPath(cwd, sid), String(brief).endsWith("\n") ? brief : `${brief}\n`); writePlan(cwd, sid, plan); appendLedger(cwd, sid, "plan_created", { goalIds: goals.map(g => g.id), intensity });
    const stateFile = statePath(cwd, sid, "ultragoal");
    const state = { skill: "ultragoal", version: 1, session_id: sid, current_phase: "created", active: true, plan_path: planPath(cwd, sid), intensity, state_revision: 1, updated_at: now() };
    writeState(stateFile, state); updateActive(cwd, sid, "ultragoal", "created", true); audit(cwd, sid, "state_written", { skill: "ultragoal", revision: 1 });
    emit({ ok: true, message: `Created Hoje Goals plan with ${goals.length} goal(s).`, ...goalSummary(plan, cwd, sid) }, asJson); return;
  }
  if (op === "status") { const file = planPath(cwd, sid); emit(fs.existsSync(file) ? goalSummary(readPlan(cwd, sid), cwd, sid) : { exists: false, status: "missing" }, true); return; }
  const plan = readPlan(cwd, sid);
  if (op === "complete-goals") { const alreadyActive = plan.goals.find(goal => goal.status === "active"); const goal = alreadyActive || currentGoal(plan, has(args, "--retry-failed")); if (!goal) { emit(planStatus(plan) === "complete" ? "All Hoje Goals are complete" : "No schedulable goal remains"); return; } if (!alreadyActive) { goal.status = "active"; goal.updatedAt = now(); writePlan(cwd, sid, plan); appendLedger(cwd, sid, "goal_started", { goalId: goal.id }); } emit(`Active Hoje Goal: ${goal.id}\nTitle: ${goal.title}\nObjective: ${goal.objective}\nAggregate task: ${plan.hojeObjective}`); return; }
  if (op === "checkpoint") {
    const status = required(flag(args, "--status"), "checkpoint requires --status"); if (!GOAL_STATUSES.has(status)) throw new Error(`unsupported checkpoint status ${status}`); const goalId = flag(args, "--goal-id") || currentGoal(plan, true)?.id; required(goalId, "checkpoint requires --goal-id or a current goal"); const goal = plan.goals.find(g => g.id === goalId); if (!goal) throw new Error(`unknown goal ${goalId}`); const evidence = required(flag(args, "--evidence"), "checkpoint requires --evidence");
    if (["complete", "superseded"].includes(goal.status)) throw new Error(`goal ${goalId} is already terminal`);
    if (status === "complete") { if (goal.status !== "active") throw new Error(`goal ${goalId} must be active before completion`); if (plan.pipelineOverlap && !["joined", "rebaselined"].includes(plan.pipelineOverlap.status)) throw new Error("cannot complete while pipeline overlap is open or quarantined"); const gate = jsonArg(required(flag(args, "--quality-gate-json"), "complete checkpoint requires --quality-gate-json"), cwd, "--quality-gate-json"); const batch = plan.validationBatches.find(item => item.memberIds.includes(goalId)); let deferredProof = null; if (batch && goalId !== batch.finalGoalId) deferredProof = validateDeferredGate(gate, batch, goal); else if (batch) { validateGate(gate, cwd, "strict"); validateBatchClose(gate, batch, plan); } else if (plan.intensity === "light") validateLightGate(gate); else validateGate(gate, cwd, plan.intensity); const receipt = appendLedger(cwd, sid, "goal_checkpointed", { goalId, status, evidence, intensity: plan.intensity, qualityGateHash: sha(gate), qualityGateJson: gate }); goal.completionVerification = { receiptId: receipt.id, qualityGateHash: sha(gate), checkpointedAt: receipt.timestamp, ...(deferredProof ? { deferredToBatch: deferredProof } : {}) }; }
    else appendLedger(cwd, sid, "goal_checkpointed", { goalId, status, evidence });
    goal.status = status; goal.updatedAt = now(); if (status !== "complete") delete goal.completionVerification; writePlan(cwd, sid, plan); if (planStatus(plan) === "complete") { appendLedger(cwd, sid, "aggregate_completed", { goalIds: plan.goals.filter(g => g.status === "complete").map(g => g.id), planHash: sha(plan) }); updateActive(cwd, sid, "ultragoal", "complete", false); } else updateActive(cwd, sid, "ultragoal", status, true);
    emit({ ok: true, goal_id: goalId, status, run_status: planStatus(plan), next_goal: currentGoal(plan, true)?.id || null }, true); return;
  }
  if (op === "record-review-blockers") { const title = required(flag(args, "--title"), "record-review-blockers requires --title"); const objective = required(flag(args, "--objective"), "record-review-blockers requires --objective"); const id = `G${String(Math.max(0, ...plan.goals.map(g => Number(g.id.slice(1)) || 0)) + 1).padStart(3, "0")}`; plan.goals.push({ id, title, objective, status: "review_blocked", evidence: flag(args, "--evidence") || "review blocker", steering: { kind: "review_blocker" }, createdAt: now(), updatedAt: now() }); writePlan(cwd, sid, plan); appendLedger(cwd, sid, "review_blockers_recorded", { goalId: id, evidence: flag(args, "--evidence") || null }); emit({ ok: true, goal_id: id }, true); return; }
  if (op === "classify-blocker") { const classification = required(flag(args, "--classification"), "classify-blocker requires --classification"); if (!["resolvable", "human_blocked"].includes(classification)) throw new Error("classification must be resolvable or human_blocked"); const row = appendLedger(cwd, sid, "blocker_classified", { goalId: flag(args, "--goal-id") || currentGoal(plan, true)?.id || null, classification, evidence: required(flag(args, "--evidence"), "classify-blocker requires --evidence") }); emit(row, true); return; }
  if (op === "steer") { const kind = required(flag(args, "--kind"), "steer requires --kind"); const evidence = required(flag(args, "--evidence"), "steer requires --evidence"); const rationale = required(flag(args, "--rationale"), "steer requires --rationale"); let changed = [];
    if (kind !== "annotate_ledger" && plan.goals.some(goal => goal.completionVerification?.deferredToBatch)) throw new Error("cannot mutate a validation batch after a deferred member checkpoint");
    if (kind === "add_subgoal") { const id = `G${String(Math.max(0, ...plan.goals.map(g => Number(g.id.slice(1)) || 0)) + 1).padStart(3, "0")}`; plan.goals.push({ id, title: required(flag(args, "--title"), "add_subgoal requires --title"), objective: required(flag(args, "--objective"), "add_subgoal requires --objective"), status: "pending", steering: { kind }, createdAt: now(), updatedAt: now() }); changed = [id]; }
    else if (kind === "reorder_pending") { const order = jsonArg(required(flag(args, "--order-json"), "reorder_pending requires --order-json"), cwd, "--order-json"); const pending = new Map(plan.goals.filter(g => g.status === "pending").map(g => [g.id, g])); if (order.some(id => !pending.has(id)) || order.length !== pending.size) throw new Error("order-json must list every pending goal exactly once"); plan.goals = [...plan.goals.filter(g => g.status !== "pending"), ...order.map(id => pending.get(id))]; changed = order; }
    else if (kind === "revise_pending_wording") { const goal = plan.goals.find(g => g.id === flag(args, "--goal-id") && g.status === "pending"); if (!goal) throw new Error("revise_pending_wording requires a pending --goal-id"); if (flag(args, "--title")) goal.title = flag(args, "--title"); if (flag(args, "--objective")) goal.objective = flag(args, "--objective"); goal.updatedAt = now(); changed = [goal.id]; }
    else if (kind === "mark_blocked_superseded") { const goal = plan.goals.find(g => g.id === flag(args, "--goal-id") && ["blocked", "review_blocked", "failed"].includes(g.status)); if (!goal) throw new Error("mark_blocked_superseded requires a blocked/failed --goal-id"); goal.status = "superseded"; goal.updatedAt = now(); changed = [goal.id]; }
    else if (kind === "split_subgoal") { const goal = plan.goals.find(g => g.id === flag(args, "--goal-id") && g.status === "pending"); if (!goal) throw new Error("split_subgoal requires a pending --goal-id"); const replacements = jsonArg(required(flag(args, "--replacements-json"), "split_subgoal requires --replacements-json"), cwd, "--replacements-json"); goal.status = "superseded"; for (const row of replacements) { const id = `G${String(Math.max(0, ...plan.goals.map(g => Number(g.id.slice(1)) || 0)) + 1).padStart(3, "0")}`; plan.goals.push({ id, title: required(row.title, "replacement title required"), objective: required(row.objective, "replacement objective required"), status: "pending", steering: { kind, sourceGoalId: goal.id }, createdAt: now(), updatedAt: now() }); changed.push(id); } }
    else if (kind !== "annotate_ledger") throw new Error(`unsupported steer kind ${kind}`);
    writePlan(cwd, sid, plan); const row = appendLedger(cwd, sid, "plan_steered", { kind, changedGoalIds: changed, evidence, rationale }); emit(row, true); return; }
  if (op === "start-pipeline-overlap") { if (plan.hojeGoalMode !== "aggregate") throw new Error("pipeline overlap requires aggregate mode"); if (plan.validationBatches.length) throw new Error("pipeline overlap and validation batches are mutually exclusive"); if (plan.pipelineOverlap && plan.pipelineOverlap.status === "open") throw new Error("another pipeline overlap is already open"); const prior = plan.goals.find(g => g.id === flag(args, "--prior-goal-id")); const next = plan.goals.find(g => g.id === flag(args, "--next-goal-id")); if (!prior || !next || prior.status !== "active" || next.status !== "pending") throw new Error("pipeline overlap requires an active prior goal and pending next goal"); const a = prior.pipelineMetadata, b = next.pipelineMetadata; if (!a?.eligible || !b?.eligible || metadataDigest(a) !== a.metadataHash || metadataDigest(b) !== b.metadataHash || !(a.independentOf || []).includes(next.id) || !(b.independentOf || []).includes(prior.id)) throw new Error("pipeline goals need fresh mutual eligible independence metadata"); const targetsA = new Set([...(a.targets?.files || []), ...(a.targets?.surfaces || [])]); if ([...(b.targets?.files || []), ...(b.targets?.surfaces || [])].some(x => targetsA.has(x))) throw new Error("pipeline target sets overlap"); const reviewHandles = jsonArg(required(flag(args, "--review-handles-json"), "review handles required"), cwd, "--review-handles-json"); const qaHandles = jsonArg(required(flag(args, "--qa-handles-json"), "QA handles required"), cwd, "--qa-handles-json"); const implementationHandle = jsonArg(required(flag(args, "--implementation-handle-json"), "implementation handle required"), cwd, "--implementation-handle-json"); if (!Array.isArray(reviewHandles) || !reviewHandles.length || !Array.isArray(qaHandles) || !qaHandles.length || !implementationHandle || typeof implementationHandle !== "object" || !Object.keys(implementationHandle).length) throw new Error("pipeline overlap requires non-empty review, QA, and implementation handles"); const overlap = { id: `ovl-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, priorGoalId: prior.id, nextGoalId: next.id, status: "open", startedAt: now(), reviewHandles, qaHandles, implementationHandle, metadataHashes: { [prior.id]: a.metadataHash, [next.id]: b.metadataHash } }; plan.pipelineOverlap = overlap; writePlan(cwd, sid, plan); appendLedger(cwd, sid, "pipeline_overlap_started", overlap); emit(overlap, true); return; }
  if (op === "join-pipeline-overlap") { const overlap = plan.pipelineOverlap; if (!overlap || overlap.id !== flag(args, "--overlap-id") || overlap.status !== "open") throw new Error("matching open overlap not found"); const prior = plan.goals.find(goal => goal.id === overlap.priorGoalId), next = plan.goals.find(goal => goal.id === overlap.nextGoalId); if (metadataDigest(prior?.pipelineMetadata) !== overlap.metadataHashes[prior?.id] || metadataDigest(next?.pipelineMetadata) !== overlap.metadataHashes[next?.id]) throw new Error("pipeline metadata changed after overlap start"); const review = jsonArg(required(flag(args, "--review-result-json"), "review result required"), cwd, "--review-result-json"); const qa = jsonArg(required(flag(args, "--qa-result-json"), "QA result required"), cwd, "--qa-result-json"); blockersArray(review.blockers, "review blockers"); blockersArray(qa.blockers, "QA blockers"); nonempty(review.evidence, "pipeline review evidence"); nonempty(qa.evidence, "pipeline QA evidence"); if (review.status !== "passed" || qa.status !== "passed") throw new Error("pipeline review and QA status must be passed"); const blockers = [...review.blockers, ...qa.blockers]; overlap.status = blockers.length ? "quarantined" : "joined"; overlap.joinedAt = now(); overlap.blockers = blockers; overlap.reviewResult = review; overlap.qaResult = qa; writePlan(cwd, sid, plan); appendLedger(cwd, sid, "pipeline_overlap_joined", { overlapId: overlap.id, status: overlap.status, blockers }); emit(overlap, true); return; }
  if (op === "rebaseline-pipeline-overlap") { const overlap = plan.pipelineOverlap; if (!overlap || overlap.id !== flag(args, "--overlap-id") || overlap.status !== "quarantined") throw new Error("matching quarantined overlap not found"); const goal = plan.goals.find(g => g.id === required(flag(args, "--goal-id"), "rebaseline requires --goal-id")); if (!goal) throw new Error("rebaseline goal not found"); const targetState = jsonArg(required(flag(args, "--target-state-json"), "target state required"), cwd, "--target-state-json"); goal.pipelineMetadata = { ...targetState, metadataHash: sha(targetState) }; overlap.status = "rebaselined"; overlap.rebaselinedAt = now(); overlap.evidence = required(flag(args, "--evidence"), "rebaseline requires --evidence"); writePlan(cwd, sid, plan); appendLedger(cwd, sid, "pipeline_overlap_rebaselined", { overlapId: overlap.id, goalId: goal.id, evidence: overlap.evidence }); emit(overlap, true); return; }
  if (op === "review") { const qaRaw = flag(args, "--executor-qa-json") || flag(args, "--executor-qa"); const findings = []; let qa = null; try { qa = jsonArg(required(qaRaw, "review requires --executor-qa-json"), cwd, "--executor-qa-json"); validateExecutorQa(qa, cwd); } catch (error) { findings.push({ severity: "blocker", message: error.message }); } const strong = Boolean(flag(args, "--spec")); const verdict = findings.length ? "fail" : strong ? "pass" : "inconclusive: weak-contract"; if (flag(args, "--mode") === "review-start" && findings.length) { for (const finding of findings) { const id = `G${String(Math.max(0, ...plan.goals.map(g => Number(g.id.slice(1)) || 0)) + 1).padStart(3, "0")}`; plan.goals.push({ id, title: "Resolve Hoje review finding", objective: finding.message, status: "review_blocked", steering: { kind: "review_blocker" }, createdAt: now(), updatedAt: now() }); } writePlan(cwd, sid, plan); } emit({ verdict, contractStrength: strong ? "strong" : "thin-derived", cleanPassEligible: strong && !findings.length, findings }, true); return; }
  throw new Error(`unknown ultragoal operation ${op || "<missing>"}`);
}

function help() { emit(`Hoje native runtime ${runtime.runtimeVersion}\n\nCommands:\n  hoje runtime version|doctor\n  hoje state [deep-interview|ralplan|ultragoal] read|write|clear|handoff|doctor\n  hoje deep-interview --write --stage final --slug <slug> --spec <markdown-or-path> [--deliberate]\n  hoje ralplan <task> | --write ...\n  hoje ultragoal status|create-goals|complete-goals|checkpoint|review|steer|record-review-blockers|classify-blocker|start-pipeline-overlap|join-pipeline-overlap|rebaseline-pipeline-overlap`); }
function runtimeCommand(args) {
  if (args[0] === "version") { emit(`hoje-code/${manifest.version} runtime=${runtime.runtime}/${runtime.runtimeVersion} engine=node/${process.versions.node} source-gjc=${runtime.sourceGjcVersion}`); return; }
  if (args[0] === "doctor") { const requiredFiles = [__filename, path.join(PLUGIN_ROOT, "scripts", "hoje-runtime.js"), path.join(PLUGIN_ROOT, "runtime.json"), path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")]; const checks = { runtime: runtime.runtime, runtime_version: runtime.runtimeVersion, node: process.versions.node, node_supported: Number(process.versions.node.split(".")[0]) >= 18, writable_cwd: false, runtime_files: requiredFiles.every(file => fs.existsSync(file)), external_runtime_dependencies: [], session_id: sessionId(args), state_root: sessionRoot(process.cwd(), sessionId(args)) }; try { fs.accessSync(process.cwd(), fs.constants.R_OK | fs.constants.W_OK); checks.writable_cwd = true; } catch {} checks.ok = checks.node_supported && checks.writable_cwd && checks.runtime_files; emit(checks, true); if (!checks.ok) process.exitCode = 1; return; }
  throw new Error("runtime command must be version or doctor");
}

function main() {
  const args = process.argv.slice(2); const command = args.shift(); const cwd = process.cwd();
  if (!command || command === "--help" || command === "-h" || command === "help") return help();
  if (command === "--version" || command === "-v") return runtimeCommand(["version"]);
  if (command === "--smoke-test") return runtimeCommand(["doctor"]);
  if (command === "runtime") return runtimeCommand(args);
  const dispatch = () => { if (command === "state") return stateCommand(args, cwd); if (command === "deep-interview") return deepInterviewCommand(args, cwd); if (command === "ralplan") return ralplanCommand(args, cwd); if (command === "ultragoal") return ultragoalCommand(args, cwd); throw new Error(`unknown Hoje command ${command}`); };
  const readOnly = command === "state" && ["read", "doctor"].includes(MODES.has(args[0]) ? args[1] : args[0]) || command === "ultragoal" && (args[0] === "status" || args[0] === "review" && flag(args, "--mode") !== "review-start");
  if (["state", "deep-interview", "ralplan", "ultragoal"].includes(command) && !readOnly) return withSessionLock(cwd, sessionId(args), dispatch);
  return dispatch();
}

try { main(); } catch (error) { process.stderr.write(`hoje: ${error.message}\n`); process.exitCode = 1; }
