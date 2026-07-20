#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "plugins", "hoje-code", "runtime", "cli.js");
const launcher = path.join(repo, "plugins", "hoje-code", "scripts", "hoje-runtime.js");
const hook = path.join(repo, "plugins", "hoje-code", "scripts", "session-start.js");
const runtimeMetadata = JSON.parse(fs.readFileSync(path.join(repo, "plugins", "hoje-code", "runtime.json")));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoje-runtime-e2e-"));

function run(cwd, args, options = {}) {
  const result = spawnSync(process.execPath, [options.launcher ? launcher : cli, ...args], {
    cwd,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, HOJE_SESSION_ID: options.session || "e2e", ...(options.env || {}) },
  });
  if (options.fail) {
    assert.notEqual(result.status, 0, `expected failure: ${args.join(" ")}`);
  } else {
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function json(cwd, args, options) { return JSON.parse(run(cwd, args, options)); }
function workspace(name) { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; }
function writeJson(cwd, name, value) { const file = path.join(cwd, name); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); return file; }
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }

const fullGate = (cwd) => {
  writeJson(cwd, "cli-replay.json", { schemaVersion: 1, kind: "cli-replay", replaySafe: true, command: [process.execPath, "--version"], cwd: ".", env: { NO_COLOR: "1" }, timeoutMs: 30000, expectedExitCode: 0, recordedStdout: `${process.version}\n`, recordedStderr: "", invariants: [{ type: "substring", value: process.version }, { type: "not-substring", value: "error" }] });
  return {
    architectReview: { architectureStatus: "CLEAR", productStatus: "CLEAR", codeStatus: "CLEAR", recommendation: "APPROVE", evidence: "independent review passed", commands: ["node --check runtime/cli.js"], blockers: [] },
    executorQa: {
      status: "passed", e2eStatus: "passed", redTeamStatus: "passed", evidence: "real-surface and adversarial checks passed",
      e2eCommands: ["hoje runtime doctor"], redTeamCommands: ["invalid gate rejected", "unsafe replay rejected"], blockers: [],
      artifactRefs: [{ id: "A1", kind: "cli-replay", path: "cli-replay.json", description: "Node CLI replay proof" }],
      contractCoverage: [{ id: "C1", contractRef: "runtime", obligation: "native workflow executes", status: "covered", surfaceEvidenceRefs: ["S1"], adversarialCaseRefs: ["R1", "R2"] }],
      surfaceEvidence: [{ id: "S1", contractRef: "runtime", surface: "CLI", status: "covered", invocation: "node --version", verdict: "passed", artifactRefs: ["A1"] }],
      adversarialCases: [{ id: "R1", contractRef: "runtime", scenario: "invalid completion gate", expectedBehavior: "reject", verdict: "passed", artifactRefs: ["A1"] }, { id: "R2", contractRef: "runtime", scenario: "unsafe replay command", expectedBehavior: "reject", verdict: "passed", artifactRefs: ["A1"] }],
    },
    iteration: { status: "passed", fullRerun: true, evidence: "suite rerun clean", rerunCommands: ["node scripts/test-hoje-runtime.mjs"], blockers: [] },
  };
};

const lightGate = {
  selfReview: { status: "CLEAR", evidence: "bounded diff reviewed", commands: ["node --check file.js"], blockers: [] },
  verification: { status: "passed", evidence: "targeted behavior passed", commands: ["node test.js"], blockers: [] },
  iteration: { status: "passed", fullRerun: true, evidence: "targeted suite rerun", rerunCommands: ["node test.js"], blockers: [] },
};

const stateDir = workspace("state");
assert.ok(run(stateDir, ["runtime", "version"], { launcher: true }).includes(`runtime=hoje-native/${runtimeMetadata.runtimeVersion}`));
assert.equal(json(stateDir, ["runtime", "doctor"]).ok, true);
json(stateDir, ["state", "deep-interview", "write", "--input", JSON.stringify({ current_phase: "round-1", state: { rounds: [{ id: 1 }] } }), "--json"]);
assert.equal(json(stateDir, ["state", "deep-interview", "read", "--json"]).state.current_phase, "round-1");
json(stateDir, ["state", "deep-interview", "handoff", "--to", "ralplan", "--json"]);
assert.equal(json(stateDir, ["state", "ralplan", "read", "--json"]).state.handoff_from, "deep-interview");
json(stateDir, ["state", "deep-interview", "clear", "--force", "--json"]);

const lockDir = workspace("stale-lock"); fs.mkdirSync(path.join(lockDir, ".hoje", "_locks"), { recursive: true }); fs.writeFileSync(path.join(lockDir, ".hoje", "_locks", "e2e.lock"), JSON.stringify({ pid: 2147483647, createdAt: "2000-01-01T00:00:00.000Z" }));
json(lockDir, ["state", "deep-interview", "write", "--input", JSON.stringify({ current_phase: "recovered-lock" }), "--json"]); assert.equal(fs.existsSync(path.join(lockDir, ".hoje", "_locks", "e2e.lock")), false);

const askDir = workspace("ask");
assert.equal(json(askDir, ["state", "deep-interview", "doctor", "--json"]).ambiguity_threshold, 0.2);
json(askDir, ["state", "deep-interview", "write", "--input", JSON.stringify({ current_phase: "interviewing", state: {} }), "--json"], { env: { HOJE_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD: "0.15" } });
assert.equal(json(askDir, ["state", "deep-interview", "read", "--json"]).state.state.threshold, 0.15);
const askReceipt = json(askDir, ["deep-interview", "--write", "--stage", "final", "--slug", "native-runtime", "--spec", "# Specification\nIndependent runtime.", "--deliberate", "--json"]);
assert.ok(fs.existsSync(askReceipt.path)); assert.equal(askReceipt.handoff, "ralplan");
assert.equal(json(askDir, ["state", "ralplan", "read", "--json"]).state.source_spec_path, askReceipt.path);

const planDir = workspace("plan");
const seeded = run(planDir, ["ralplan", "Build independent runtime", "--deliberate"]);
const runId = seeded.match(/run_id=([^\s]+)/)?.[1];
assert.ok(runId);
const receipt = json(planDir, ["ralplan", "--write", "--stage", "planner", "--stage_n", "1", "--run-id", runId, "--artifact", "# Plan\nVerify runtime.", "--json"]);
assert.equal(receipt.stage, "planner");
json(planDir, ["ralplan", "--write", "--stage", "final", "--stage_n", "2", "--run-id", runId, "--artifact", "# Final\nApproved.", "--json"]);
assert.ok(fs.existsSync(path.join(path.dirname(receipt.path), "pending-approval.md")));

const lightDir = workspace("light");
json(lightDir, ["ultragoal", "create-goals", "--light", "--brief", "@goal: Small change\nVerify it.", "--json"]);
run(lightDir, ["ultragoal", "complete-goals"]);
run(lightDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "done", "--quality-gate-json", JSON.stringify({}), "--json"], { fail: true });
json(lightDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "done", "--quality-gate-json", writeJson(lightDir, "light-gate.json", lightGate), "--json"]);
assert.equal(json(lightDir, ["ultragoal", "status", "--json"]).status, "complete");

const idempotentDir = workspace("idempotent"); const idempotentPlan = json(idempotentDir, ["ultragoal", "create-goals", "--brief", "@goal: Once\nA", "--json"]); run(idempotentDir, ["ultragoal", "complete-goals"]); run(idempotentDir, ["ultragoal", "complete-goals"]);
assert.equal(fs.readFileSync(idempotentPlan.paths.ledgerPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.event === "goal_started").length, 1);

const strictDir = workspace("strict");
json(strictDir, ["ultragoal", "create-goals", "--strict", "--brief", "@goal: High risk\nVerify strictly.", "--json"]); run(strictDir, ["ultragoal", "complete-goals"]);
const shallowStrict = fullGate(strictDir); shallowStrict.executorQa.adversarialCases = shallowStrict.executorQa.adversarialCases.slice(0, 1); shallowStrict.executorQa.redTeamCommands = shallowStrict.executorQa.redTeamCommands.slice(0, 1); shallowStrict.executorQa.contractCoverage[0].adversarialCaseRefs = ["R1"];
run(strictDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "shallow", "--quality-gate-json", writeJson(strictDir, "shallow-strict.json", shallowStrict), "--json"], { fail: true });
json(strictDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "strict pass", "--quality-gate-json", writeJson(strictDir, "strict-gate.json", fullGate(strictDir)), "--json"]);

const pipelineDir = workspace("pipeline");
const metadata = [
  { goalId: "G001", eligible: true, independentOf: ["G002"], targets: { files: ["a.js"], surfaces: ["cli-a"] } },
  { goalId: "G002", eligible: true, independentOf: ["G001"], targets: { files: ["b.js"], surfaces: ["cli-b"] } },
];
json(pipelineDir, ["ultragoal", "create-goals", "--brief", "@goal: First\nA\n@goal: Second\nB", "--goal-metadata-json", writeJson(pipelineDir, "metadata.json", metadata), "--json"]);
run(pipelineDir, ["ultragoal", "complete-goals"]);
const overlap = json(pipelineDir, ["ultragoal", "start-pipeline-overlap", "--prior-goal-id", "G001", "--next-goal-id", "G002", "--review-handles-json", JSON.stringify([{ id: "architect-1" }]), "--qa-handles-json", JSON.stringify([{ id: "qa-1" }]), "--implementation-handle-json", JSON.stringify({ id: "executor-2" }), "--json"]);
assert.equal(overlap.status, "open");
assert.equal(json(pipelineDir, ["ultragoal", "join-pipeline-overlap", "--overlap-id", overlap.id, "--review-result-json", JSON.stringify({ status: "passed", evidence: "reviewed frozen change set", blockers: [] }), "--qa-result-json", JSON.stringify({ status: "passed", evidence: "tested frozen change set", blockers: [] }), "--json"]).status, "joined");
const gateFile = writeJson(pipelineDir, "full-gate.json", fullGate(pipelineDir));
json(pipelineDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "first done", "--quality-gate-json", gateFile, "--json"]);
run(pipelineDir, ["ultragoal", "complete-goals"]);
json(pipelineDir, ["ultragoal", "checkpoint", "--goal-id", "G002", "--status", "complete", "--evidence", "second done", "--quality-gate-json", gateFile, "--json"]);
assert.equal(json(pipelineDir, ["ultragoal", "status", "--json"]).status, "complete");
const planBeforeReview = fs.readFileSync(json(pipelineDir, ["ultragoal", "status", "--json"]).paths.goalsPath, "utf8");
assert.equal(json(pipelineDir, ["ultragoal", "review", "--spec", gateFile, "--executor-qa-json", writeJson(pipelineDir, "qa.json", fullGate(pipelineDir).executorQa), "--mode", "review-only", "--json"]).verdict, "pass");
assert.equal(fs.readFileSync(json(pipelineDir, ["ultragoal", "status", "--json"]).paths.goalsPath, "utf8"), planBeforeReview);
const unsafeQa = fullGate(pipelineDir).executorQa; writeJson(pipelineDir, "cli-replay.json", { schemaVersion: 1, kind: "cli-replay", replaySafe: true, command: [process.execPath, "-e", "require('node:fs').rmSync('x')"], expectedExitCode: 0, recordedStdout: "" });
assert.equal(json(pipelineDir, ["ultragoal", "review", "--spec", gateFile, "--executor-qa-json", writeJson(pipelineDir, "unsafe-qa.json", unsafeQa), "--mode", "review-only", "--json"]).verdict, "fail");
for (const [surface, kind, artifactName, content] of [
  ["api", "api-package-test-report", "api-report.txt", "API consumer test passed\n"],
  ["algorithm", "property-test-report", "property-report.txt", "Boundary properties passed\n"],
  ["tui", "pty-transcript", "pty.log", "\x1b[32mTUI passed\x1b[0m\n"],
]) {
  fs.writeFileSync(path.join(pipelineDir, artifactName), content); const qa = fullGate(pipelineDir).executorQa;
  qa.artifactRefs = [{ id: "A1", kind, path: artifactName, description: `${surface} proof` }]; qa.surfaceEvidence[0] = { id: "S1", contractRef: "runtime", surface, status: "covered", invocation: `test ${surface}`, verdict: "passed", artifactRefs: ["A1"] };
  assert.equal(json(pipelineDir, ["ultragoal", "review", "--spec", gateFile, "--executor-qa-json", writeJson(pipelineDir, `${surface}-qa.json`, qa), "--mode", "review-only", "--json"]).verdict, "pass");
}
const png = Buffer.alloc(192); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); for (let index = 8; index < png.length; index++) png[index] = index % 251; fs.writeFileSync(path.join(pipelineDir, "screen.png"), png); fs.writeFileSync(path.join(pipelineDir, "automation.json"), '{"steps":["open","verify"]}\n');
const guiQa = fullGate(pipelineDir).executorQa; guiQa.artifactRefs = [{ id: "A1", kind: "screenshot", path: "screen.png", description: "non-uniform PNG" }, { id: "A2", kind: "automation-transcript", path: "automation.json", description: "GUI automation" }]; guiQa.surfaceEvidence[0] = { id: "S1", contractRef: "runtime", surface: "gui", status: "covered", invocation: "open and verify", verdict: "passed", artifactRefs: ["A1", "A2"] };
assert.equal(json(pipelineDir, ["ultragoal", "review", "--spec", gateFile, "--executor-qa-json", writeJson(pipelineDir, "gui-qa.json", guiQa), "--mode", "review-only", "--json"]).verdict, "pass");

const batchDir = workspace("batch");
const batch = [{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002"], finalGoalId: "G002" }];
json(batchDir, ["ultragoal", "create-goals", "--brief", "@goal: Batch one\nA\n@goal: Batch final\nB", "--validation-batch-json", writeJson(batchDir, "batch.json", batch), "--json"]);
run(batchDir, ["ultragoal", "complete-goals"]);
const deferred = { deferredToBatch: { kind: "validation-batch-deferred", batchId: "VB001", memberGoalId: "G001", targetedVerification: { status: "passed", evidence: "targeted tests", commands: ["node test-a.js"], blockers: [] }, cleaner: { status: "passed", evidence: "no blocking slop", blockers: [] }, iteration: { status: "passed", fullRerun: true, evidence: "rerun passed", rerunCommands: ["node test-a.js"], blockers: [] }, changeSet: { cumulativeFromBase: true, paths: ["a.js"] } } };
json(batchDir, ["ultragoal", "checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "deferred", "--quality-gate-json", writeJson(batchDir, "deferred.json", deferred), "--json"]);
const deferredGoal = json(batchDir, ["ultragoal", "status", "--json"]).goals.find(goal => goal.id === "G001");
run(batchDir, ["ultragoal", "complete-goals"]);
const closeGate = fullGate(batchDir);
closeGate.validationBatchClose = { kind: "validation-batch-close", batchId: "VB001", finalGoalId: "G002", memberIds: ["G001", "G002"], memberReceiptIds: { G001: deferredGoal.completionVerification.receiptId }, memberMetadataHashes: { G001: deferredGoal.completionVerification.deferredToBatch.metadataHash }, memberChangeSetHashes: { G001: deferredGoal.completionVerification.deferredToBatch.changeSetHash }, unionChangeSet: { cumulativeFromBase: true, paths: ["a.js", "b.js"] }, evidence: "all members covered" };
json(batchDir, ["ultragoal", "checkpoint", "--goal-id", "G002", "--status", "complete", "--evidence", "batch closed", "--quality-gate-json", writeJson(batchDir, "close-gate.json", closeGate), "--json"]);
assert.equal(json(batchDir, ["ultragoal", "status", "--json"]).status, "complete");

const steerDir = workspace("steer");
json(steerDir, ["ultragoal", "create-goals", "--brief", "@goal: One\nA\n@goal: Two\nB", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "revise_pending_wording", "--goal-id", "G002", "--title", "Two revised", "--evidence", "finding", "--rationale", "clarity", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "add_subgoal", "--title", "Three", "--objective", "C", "--evidence", "finding", "--rationale", "coverage", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "reorder_pending", "--order-json", JSON.stringify(["G003", "G001", "G002"]), "--evidence", "dependency", "--rationale", "order", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "split_subgoal", "--goal-id", "G002", "--replacements-json", JSON.stringify([{ title: "Two A", objective: "A" }, { title: "Two B", objective: "B" }]), "--evidence", "split", "--rationale", "isolation", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "annotate_ledger", "--evidence", "note", "--rationale", "audit", "--json"]);
json(steerDir, ["ultragoal", "classify-blocker", "--classification", "resolvable", "--evidence", "agent can fix", "--json"]);
const blocked = json(steerDir, ["ultragoal", "record-review-blockers", "--title", "Review issue", "--objective", "Fix it", "--evidence", "review", "--json"]);
json(steerDir, ["ultragoal", "steer", "--kind", "mark_blocked_superseded", "--goal-id", blocked.goal_id, "--evidence", "obsolete", "--rationale", "replaced", "--json"]);

const envFile = path.join(root, "hook-env.sh");
const hookResult = spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: "abc/123" }), encoding: "utf8", env: { ...process.env, CLAUDE_ENV_FILE: envFile } });
assert.equal(hookResult.status, 0, hookResult.stderr);
assert.match(fs.readFileSync(envFile, "utf8"), /^export HOJE_SESSION_ID='claude-abc-123'\n$/);

const tamperStateDir = workspace("tamper-state");
const stateWrite = json(tamperStateDir, ["state", "deep-interview", "write", "--input", JSON.stringify({ current_phase: "safe" }), "--json"]);
const tamperedState = JSON.parse(fs.readFileSync(stateWrite.state_path, "utf8")); tamperedState.current_phase = "forged"; fs.writeFileSync(stateWrite.state_path, JSON.stringify(tamperedState));
run(tamperStateDir, ["state", "deep-interview", "read", "--json"], { fail: true });

const tamperPlanDir = workspace("tamper-plan");
const createdPlan = json(tamperPlanDir, ["ultragoal", "create-goals", "--brief", "@goal: Protected\nA", "--json"]);
const tamperedPlan = JSON.parse(fs.readFileSync(createdPlan.paths.goalsPath, "utf8")); tamperedPlan.goals[0].status = "complete"; fs.writeFileSync(createdPlan.paths.goalsPath, JSON.stringify(tamperedPlan));
run(tamperPlanDir, ["ultragoal", "status", "--json"], { fail: true });
json(tamperPlanDir, ["state", "ultragoal", "clear", "--force", "--json"]);
assert.equal(json(tamperPlanDir, ["ultragoal", "status", "--json"]).status, "missing");
json(tamperPlanDir, ["ultragoal", "create-goals", "--brief", "@goal: Recovered\nA", "--json"]);

const tamperLedgerDir = workspace("tamper-ledger");
const ledgerPlan = json(tamperLedgerDir, ["ultragoal", "create-goals", "--brief", "@goal: Ledger\nA", "--json"]);
const ledgerLines = fs.readFileSync(ledgerPlan.paths.ledgerPath, "utf8").trim().split(/\r?\n/); const firstRow = JSON.parse(ledgerLines[0]); firstRow.event = "forged"; ledgerLines[0] = JSON.stringify(firstRow); fs.writeFileSync(ledgerPlan.paths.ledgerPath, `${ledgerLines.join("\n")}\n`);
run(tamperLedgerDir, ["ultragoal", "status", "--json"], { fail: true });

for (const relative of ["runtime", "scripts/hoje-runtime.js", "scripts/session-start.js", "bin", "hooks"]) {
  const target = path.join(repo, "plugins", "hoje-code", relative);
  const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).map(name => path.join(target, name)).filter(file => fs.statSync(file).isFile()) : [target];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /@gajae-code\/coding-agent|\bBun\b|\bbunx\b|GJC_SESSION_ID/);
}

const skillText = walk(path.join(repo, "plugins", "hoje-code", "skills")).filter(file => file.endsWith(".md")).map(file => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(skillText, /\.gjc\/|GJC_|goal\(\{|hoje team|skill-fragments\/|\bbunx\b|\bbun\b|(?<!hoje )deep-interview --write/);
const skillFrontmatter = (name) => fs.readFileSync(path.join(repo, "plugins", "hoje-code", "skills", name, "SKILL.md"), "utf8").split(/\r?\n---\r?\n/, 1)[0];
assert.doesNotMatch(skillFrontmatter("hoje-goals"), /^disable-model-invocation:/m);
for (const name of ["hoje-ask", "hoje-plan"]) assert.match(skillFrontmatter(name), /^disable-model-invocation:\s*true$/m);
for (const role of ["planner", "architect", "critic", "executor", "executor-qa"]) assert.ok(fs.existsSync(path.join(repo, "plugins", "hoje-code", "agents", `${role}.md`)));
const manifestVersion = JSON.parse(fs.readFileSync(path.join(repo, "plugins", "hoje-code", ".claude-plugin", "plugin.json"))).version;
assert.equal(manifestVersion, runtimeMetadata.runtimeVersion);

console.log(`Hoje runtime E2E passed: ${root}`);
