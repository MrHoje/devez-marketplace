#!/usr/bin/env node
/** Sync the latest published Gajae-Code workflow skills into hoje-code. */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAJAE_REPO = "Yeachan-Heo/gajae-code";
const NPM_PACKAGE = "@gajae-code/coding-agent";
const SOURCE_BASE = "packages/coding-agent/src/defaults/gjc/skills";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SCRIPT_DIR, "../plugins/hoje-code");
const SKILLS_DIR = path.join(PLUGIN_DIR, "skills");
const MARKETPLACE_PATH = path.resolve(SCRIPT_DIR, "../.claude-plugin/marketplace.json");
const RUNTIME_PATH = path.join(PLUGIN_DIR, "runtime.json");

const SKILL_MAP = [
  { source: "deep-interview/SKILL.md", target: "hoje-ask/SKILL.md", name: "hoje-ask" },
  { source: "ralplan/SKILL.md", target: "hoje-plan/SKILL.md", name: "hoje-plan" },
  { source: "ultragoal/SKILL.md", target: "hoje-goals/SKILL.md", name: "hoje-goals" },
  {
    source: "deep-interview/auto-answer-uncertain.md",
    target: "hoje-ask-auto-answer/SKILL.md",
    name: "hoje-ask-auto-answer",
    description: "Internal read-only helper that resolves an uncertain Hoje Ask answer.",
  },
  {
    source: "deep-interview/auto-research-greenfield.md",
    target: "hoje-ask-greenfield/SKILL.md",
    name: "hoje-ask-greenfield",
    description: "Internal read-only helper that researches greenfield Hoje Ask options.",
  },
  {
    source: "deep-interview/lateral-review-panel.md",
    target: "hoje-ask-panel/SKILL.md",
    name: "hoje-ask-panel",
    description: "Internal read-only lateral review persona for Hoje Ask.",
  },
  {
    source: "ultragoal/ai-slop-cleaner.md",
    target: "hoje-goals-slop-cleaner/SKILL.md",
    name: "hoje-goals-slop-cleaner",
    description: "Internal read-only AI slop detector for the Hoje Goals completion gate.",
  },
  {
    source: "ultragoal/pipeline-validation-contracts.md",
    target: "hoje-goals-pipeline-validation/SKILL.md",
    name: "hoje-goals-pipeline-validation",
    description: "Internal Hoje Goals pipeline overlap and validation-batch contracts.",
  },
];

const CONTENT_RULES = [
  [/\/skill:deep-interview\b/g, "/hoje-code:hoje-ask"],
  [/\/skill:ralplan\b/g, "/hoje-code:hoje-plan"],
  [/\/skill:ultragoal\b/g, "/hoje-code:hoje-goals"],
  [/\/skill:team\b/g, "/hoje-code:hoje-goals --strict"],
  [/(?<![\w.])gjc team\b/g, "hoje ultragoal complete-goals"],
  [/(?<![\w.])gjc (?=(?:state|ralplan|ultragoal|skills|--version|--smoke-test)\b)/g, "hoje "],
  [/`auto-answer-uncertain\.md`/g, "`/hoje-code:hoje-ask-auto-answer`"],
  [/`auto-research-greenfield\.md`/g, "`/hoje-code:hoje-ask-greenfield`"],
  [/`lateral-review-panel\.md`/g, "`/hoje-code:hoje-ask-panel`"],
  [/`pipeline-validation-contracts` fragment/g, "`/hoje-code:hoje-goals-pipeline-validation` internal skill"],
  [/`ai-slop-cleaner`, an internal Ultragoal sub-skill/g, "`/hoje-code:hoje-goals-slop-cleaner`, an internal Ultragoal skill"],
  [/`skill-fragments\/ultragoal\/pipeline-validation-contracts\.md`/g, "`/hoje-code:hoje-goals-pipeline-validation`"],
  [/`skill-fragments\/ultragoal\/ai-slop-cleaner\.md`/g, "`/hoje-code:hoje-goals-slop-cleaner`"],
  [/`kind: "skill-fragment"`/g, "an internal Hoje-Code plugin skill"],
  [/a an internal Hoje-Code plugin skill/g, "an internal Hoje-Code plugin skill"],
  [/Preserve the GJC `ask` tool path for native interaction; do not introduce parallel structured-question transport into this skill/g, "Use Claude Code's `AskUserQuestion` tool for native interaction and persist Hoje workflow state explicitly through `hoje state`"],
  [/`ask`/g, "`AskUserQuestion`"],
  [/goal\(\{"op":"get"\}\)/g, "TaskList"],
  [/goal\(\{"op":"create","objective":"<printed aggregate or per-story objective>"\}\)/g, "TaskCreate(subject=<printed objective>, status=in_progress)"],
  [/goal\(\{"op":"complete"\}\)/g, "TaskUpdate(status=completed)"],
  [/goal\(\{"op":"drop"\}\)/g, "TaskUpdate(status=completed, description=superseded)"],
  [/goal\(\{"op":"resume"\}\)/g, "TaskUpdate(status=in_progress)"],
  [/goal\(\{"op":"pause"\}\)/g, "TaskUpdate(status=pending)"],
  [/goal\(\{"op":"create"[^)]*\}\)/g, "TaskCreate(subject=<printed objective>, status=in_progress)"],
  [/goal\(\{"op":"(?:get|complete|drop|resume|pause)"[^)]*\}\)/g, "TaskList/TaskUpdate as appropriate"],
  [/unified goal-tool surface/g, "Claude task bridge"],
  [/inline goal state/g, "inline Claude task state"],
  [/\.gjc\//g, ".hoje/"],
  [/\.gjc\b/g, ".hoje"],
  [/GJC_SESSION_ID/g, "HOJE_SESSION_ID"],
  [/GJC_CONFIG_DIR/g, "HOJE_CONFIG_DIR"],
  [/GJC_CODING_AGENT_DIR/g, "HOJE_CODING_AGENT_DIR"],
  [/GJC_RALPLAN_ARTIFACT/g, "HOJE_RALPLAN_ARTIFACT"],
  [/GJC_/g, "HOJE_"],
  [/gjcObjectiveAliases/g, "hojeObjectiveAliases"],
  [/gjcObjective/g, "hojeObjective"],
  [/\bgjc\./g, "hoje."],
  [/--gjc-goal-mode/g, "--hoje-goal-mode"],
  [/JSON key `gjc`/g, "JSON key `hoje`"],
  [/\bGJC\b/g, "Hoje"],
  [/\bUltragoal\b/g, "Hoje Goals"],
  [/\bRalplan\b/g, "Hoje Plan"],
  [/\bDeep Interview\b/g, "Hoje Ask"],
];

function parseVersionArg(args) {
  const inline = args.find((arg) => arg.startsWith("--version=") || arg.startsWith("-v="));
  if (inline) return inline.split("=", 2)[1]?.replace(/^v/, "");
  const index = args.findIndex((arg) => arg === "--version" || arg === "-v");
  return index >= 0 ? args[index + 1]?.replace(/^v/, "") : undefined;
}

async function getLatestVersion() {
  const encoded = encodeURIComponent(NPM_PACKAGE);
  const response = await fetch(`https://registry.npmjs.org/${encoded}/latest`);
  if (!response.ok) throw new Error(`Failed to fetch npm latest metadata: ${response.status}`);
  const metadata = await response.json();
  if (!metadata.version) throw new Error("npm latest metadata has no version");
  return metadata.version;
}

async function fetchSource(version, source) {
  const url = `https://raw.githubusercontent.com/${GAJAE_REPO}/v${version}/${SOURCE_BASE}/${source}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${source} from v${version}: ${response.status}`);
  return response.text();
}

function adaptMainSkill(content, name) {
  let result = content.replace(/^name:\s*[^\r\n]+/m, `name: ${name}`);
  if (name === "hoje-goals") {
    result = result.replace(/^disable-model-invocation:[^\r\n]*\r?\n/m, "");
  } else if (!/^disable-model-invocation:/m.test(result)) {
    result = result.replace(/^(description:[^\r\n]+)$/m, "$1\ndisable-model-invocation: true");
  }
  if (name === "hoje-goals" && !/^argument-hint:/m.test(result)) {
    result = result.replace(
      /^(description:[^\r\n]+)$/m,
      '$1\nargument-hint: "[--light|--standard|--strict] <approved plan or execution brief>"',
    );
  }
  const frontmatterEnd = result.indexOf("\n---", 4);
  if (frontmatterEnd < 0) throw new Error(`Invalid frontmatter for ${name}`);
  const insertionPoint = frontmatterEnd + 4;
  const roleContract =
    name === "hoje-plan"
      ? `
- Role agents are bundled by this plugin. Whenever the workflow says to launch Planner, Architect, or Critic, call the Agent tool with \`subagent_type\` \`hoje-code:planner\`, \`hoje-code:architect\`, or \`hoje-code:critic\`. Never depend on user-global agent definitions.
`
      : name === "hoje-goals"
        ? `
- Role agents are bundled by this plugin. Use \`hoje-code:executor\` for implementation, \`hoje-code:executor-qa\` for the read-only QA/red-team lane, \`hoje-code:architect\` for architecture/product/code review, \`hoje-code:critic\` for plan critique, and \`hoje-code:planner\` for plan repair. Never depend on user-global agent definitions.
`
        : `
- Role agents are bundled by this plugin. Use \`hoje-code:architect\` for read-only research/review personas and \`hoje-code:planner\` for bounded planning. Never depend on user-global agent definitions.
`;
  const askContract = name === "hoje-ask" ? `
- Resolve Phase 0 settings with \`hoje state deep-interview doctor --json\`. The native runtime reads \`HOJE_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD\`, then \`HOJE_CONFIG_DIR/config.json\` or \`.hoje/config.json\` at key \`hoje.deepInterview.ambiguityThreshold\`, and otherwise uses \`0.2\`.
- Persist final specs only with \`hoje deep-interview --write --stage final --slug <slug> --spec <markdown-or-path> [--deliberate] --json\`.
` : "";
  const intensityProfiles =
    name === "hoje-goals"
      ? `
### Execution intensity

Resolve one profile before execution. An explicit flag wins; otherwise choose the lowest safe profile and state it in one short line.

- \`--light\`: for one local, low-risk goal expected to touch at most 2 files and fewer than 200 net lines. The leader may implement and self-review directly. Subagents, pipeline overlap, validation batches, slop cleanup, and independent review lanes are optional. Run targeted verification and emit the compact light gate: \`selfReview: { status: "CLEAR", evidence, commands, blockers: [] }\`, \`verification: { status: "passed", evidence, commands, blockers: [] }\`, and \`iteration: { status: "passed", fullRerun: true, evidence, rerunCommands, blockers: [] }\`.
- \`--standard\` (default): upstream behavior. Delegate implementation at 3+ files, about 200+ net lines, cross-layer scope, or when parallel slices are genuinely independent. Run the full cleanup, review, QA/red-team, rerun, and checkpoint loop.
- \`--strict\`: for security/auth, payments, destructive data paths, migrations, concurrency, public API compatibility, production infrastructure, or explicit maximum assurance. Delegate every non-trivial implementation slice, broaden regression/adversarial coverage, and use independent review lanes. Pipeline overlap remains allowed only with valid runtime metadata.

Every profile keeps durable receipts, empty blockers, explicit evidence, and a full verification rerun. Standard and strict require independent \`architectReview\` and \`executorQa\`; light uses the native compact gate. If a light task grows beyond its boundary or touches a high-risk surface, promote it before continuing.
`
      : "";
  const compatibility = `

## Hoje-Code Claude compatibility

These rules override conflicting upstream transport instructions below:

- Run workflow commands through the bundled \`hoje\` launcher. It invokes the Hoje-native Node runtime and never requires Gajae-Code or Bun.
- Use Hoje-native state contracts: \`.hoje/\`, \`HOJE_SESSION_ID\`, \`HOJE_CONFIG_DIR\`, \`HOJE_CODING_AGENT_DIR\`, and JSON key \`hoje\`.
- Use Claude Code's \`AskUserQuestion\` for question operations. Do not pass upstream-only \`deepInterview\` or \`workflowGate\` metadata to that tool; persist required answer, scoring, and approval state through \`hoje state ...\`.
- Use Claude Code's Agent tool for upstream subagent operations and its resume handle when continuity is required.
- Use Claude Code tasks as the inline UX bridge: create one aggregate task, keep it \`in_progress\` during intermediate story checkpoints, and mark it \`completed\` only after the final durable receipt. Durable \`goals.json\` and \`ledger.jsonl\` remain authoritative.
- Invoke internal helpers through their namespaced Hoje-Code skills. They are hidden from the user command menu but remain model-invocable.
- In user-facing prose, say Hoje Ask, Hoje Plan, and Hoje Goals. Lower-level command names such as \`ralplan\` and \`ultragoal\` are CLI compatibility aliases only.
${roleContract}${askContract}${intensityProfiles}
`;
  return `${result.slice(0, insertionPoint)}${compatibility}${result.slice(insertionPoint)}`;
}

function adaptContent(content, mapping) {
  let result = content.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of CONTENT_RULES) result = result.replace(pattern, replacement);
  result = result.replace(/red-team/gi, "HOJE_RED_TEAM");
  result = result.replace(/\btmux\b/gi, "Claude Agent");
  result = result.replace(/\bTeam\b/g, "Hoje Goals strict mode");
  result = result.replace(/\bteam\b/g, "Hoje Goals strict mode");
  result = result.replace(/HOJE_RED_TEAM/g, "red-team");
  result = result.replace(/Hoje Goals strict mode-mode/g, "implicit strict-mode");
  result = result.replace(/bun test(?::[A-Za-z0-9_-]+)?/g, "node --test");
  result = result.replace(/\bbun\b/g, "node");
  result = result.replace(/gjc read\|status/g, "hoje state read|hoje ultragoal status");
  result = result.replace(/`node --version`, `node --version`, deterministic `node\/node -e/g, "`node --version`, deterministic `node -e");
  if (mapping.name === "hoje-goals") {
    result = result.replace(
      /4\. If no active Hoje goal exists,[^\n]+/,
      "4. Use `TaskList` to locate this run's aggregate task. If absent, create it with `TaskCreate(subject=<printed objective>, status=in_progress)`. Complete only this plugin's stale aggregate task as superseded before creating a replacement; never modify an unrelated active user task.",
    );
    result = result.replace(
      /3\. Call `TaskList`\.\n4\. If no active GJC goal exists,[^\n]+/,
      "3. Call `TaskList` and locate the aggregate task for this run.\n4. If it does not exist, create it with `TaskCreate(subject=<printed payload objective>)` and mark it `in_progress`. Reuse the same task for every intermediate story. If a different stale aggregate task exists, mark it completed as superseded before creating the new aggregate task.",
    );
    result = result.replace(
      /- Use only the Claude task bridge from the agent loop:[\s\S]*?- In aggregate mode, intermediate and final story checkpoints update durable `goals\.json` state and append receipt proof to `ledger\.jsonl`; the final story checkpoint creates the final aggregate receipt before the agent may call `TaskUpdate\(status=completed\)`\./,
      "- Use `TaskList`, `TaskCreate`, and `TaskUpdate` only as the Claude UX bridge. Keep exactly one aggregate task `in_progress` across intermediate stories.\n- For back-to-back runs, complete any stale aggregate task as superseded before creating the next one. Never replace a different active user task.\n- Mark the aggregate task `completed` only after the durable final aggregate receipt exists.\n- In aggregate mode, intermediate and final story checkpoints update durable `goals.json` state and append receipt proof to `ledger.jsonl`; those artifacts, not task state, prove completion.",
    );
    result = result.replace(/inline goal-tool state/g, "inline Claude task state");
    result = result.replace(
      /A successful complete checkpoint is story completion,[^\n]+/,
      "A successful complete checkpoint is story completion, not automatic run completion. Read the JSON response: continue when `next_goal` is non-null; finish only when `run_status` is `complete`. `hoje ultragoal complete-goals` remains the supported manual next-story command.",
    );
    result = result.replace(
      /or the equivalent runtime `createUltragoalPlan\(\{ goalMetadata \}\)` input/g,
      "using the same command with a JSON file path",
    );
    result = result.replace(/Hoje Goals strict mode launch remains explicit; Hoje Goals does not auto-launch Hoje Goals strict mode/g, "Bundled Agent delegation remains explicit; Hoje Goals does not auto-launch workers");
    result = result.replace(/Use ultragoal and Hoje Goals strict mode together/g, "Use Hoje Goals with bundled Agent roles");
    result = result.replace(/Use Hoje Goals and Hoje Goals strict mode together/g, "Use Hoje Goals with bundled Agent roles");
    result = result.replace(/Hoje Goals strict mode is the single-worker Claude Agent execution engine/g, "a bundled executor Agent is the implementation lane");
    result = result.replace(/Hoje Goals strict mode evidence/g, "bundled Agent evidence");
    result = result.replace(/strict Hoje Goals-mode rule/g, "implicit strict-mode rule");
    result = result.replace(/hidden Hoje Goals strict mode scheduling/g, "hidden worker scheduling");
  }
  if (mapping.name === "hoje-plan") {
    result = result.replace(/--to <(?:team|Hoje Goals strict mode)\|ultragoal>/g, "--to ultragoal");
    result = result.replace(/Approve execution via Hoje Goals strict mode/g, "Approve Hoje Goals strict execution");
  }
  if (mapping.name === "hoje-ask") {
    result = result.replace(/(?<!deep-interview )hoje state write/g, "hoje state deep-interview write");
    result = result.replace(/(?<!deep-interview )hoje state read/g, "hoje state deep-interview read");
    result = result.replace(/(?<!hoje )deep-interview --write/g, "hoje deep-interview --write");
    result = result.replace(
      /When calling `AskUserQuestion`, SHOULD include optional structured metadata[^\n]+/,
      "Claude's `AskUserQuestion` transport does not accept Hoje workflow metadata. After each answer, persist the answered shell and scoring enrichment explicitly with `hoje state deep-interview write --input '<json>' --json`.",
    );
    result = result.replace(
      /When `deepInterview` ask metadata is present,[^\n]+/,
      "Persist every answered shell and scoring enrichment explicitly through `hoje state deep-interview write`; Claude question transport does not mutate Hoje state.",
    );
    result = result.replace(
      /4\. \*\*Initialize state\*\* via `hoje state deep-interview write`:/,
      "4. **Initialize state** via `hoje state deep-interview write --input '<the JSON below>' --json`:",
    );
    result = result.replace(
      /Implementation handoff defaults to `\/hoje-code:hoje-goals`; `\/hoje-code:hoje-goals --strict` is reserved for when tmux-based interactive worker parallelization is genuinely required, and `hoje ultragoal complete-goals` is a native tmux runtime command used only when the Team workflow explicitly requires the CLI runtime\./g,
      "Implementation handoff defaults to `/hoje-code:hoje-goals`; use `--strict` for high-risk work. Parallel execution uses the plugin's bundled Agent roles and never requires tmux.",
    );
  }
  if (mapping.name === "hoje-goals-pipeline-validation") {
    result += `

## Hoje-native validation-batch JSON

The non-final gate contains only \`deferredToBatch\` with \`kind\`, \`batchId\`, \`memberGoalId\`, passed \`targetedVerification\`, passed \`cleaner\`, passed \`iteration\` with \`fullRerun: true\`, and \`changeSet: { cumulativeFromBase: true, paths: [...] }\`. Each check includes evidence and an empty blockers array; verification checks also include commands.

The final full gate adds \`validationBatchClose\` with \`kind: "validation-batch-close"\`, matching \`batchId\`, \`finalGoalId\`, ordered \`memberIds\`, maps named \`memberReceiptIds\`, \`memberMetadataHashes\`, and \`memberChangeSetHashes\`, plus \`unionChangeSet: { cumulativeFromBase: true, paths: [...] }\` and non-empty \`evidence\`. Map keys cover each non-final member. The runtime rejects missing, stale, out-of-order, or uncovered proof.
`;
  }
  if (mapping.description) {
    result = `---\nname: ${mapping.name}\ndescription: ${mapping.description}\nuser-invocable: false\n---\n\n${result}`;
  } else {
    result = adaptMainSkill(result, mapping.name);
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

async function versionContractErrors(version) {
  const errors = [];
  const runtime = JSON.parse(await fs.readFile(RUNTIME_PATH, "utf8"));
  if (runtime.sourceGjcVersion !== version) errors.push(`runtime.json sourceGjcVersion=${runtime.sourceGjcVersion ?? "missing"}`);

  const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, ".claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(await fs.readFile(MARKETPLACE_PATH, "utf8"));
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "hoje-code");
  if (!entry) errors.push("hoje-code marketplace entry missing");
  else if (entry.version !== manifest.version) {
    errors.push(`plugin version mismatch: manifest=${manifest.version}, marketplace=${entry.version}`);
  }
  return errors;
}

async function updateSourceVersion(version) {
  const runtime = JSON.parse(await fs.readFile(RUNTIME_PATH, "utf8"));
  runtime.sourceGjcVersion = version;
  await fs.writeFile(RUNTIME_PATH, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const checkOnly = args.includes("--check-only");
  const version = parseVersionArg(args) ?? (await getLatestVersion());
  console.log(`Gajae-Code npm latest/source tag: v${version}`);

  if (checkOnly) return;

  const mismatches = [];
  for (const mapping of SKILL_MAP) {
    const expected = adaptContent(await fetchSource(version, mapping.source), mapping);
    const targetPath = `${SKILLS_DIR}/${mapping.target}`;
    if (verify) {
      const actual = await fs.readFile(targetPath, "utf8").catch(() => "");
      if (actual.replace(/\r\n/g, "\n") !== expected) mismatches.push(mapping.target);
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, expected, "utf8");
      console.log(`updated ${mapping.target}`);
    }
  }

  if (verify) {
    mismatches.push(...(await versionContractErrors(version)));
    if (mismatches.length) throw new Error(`Out of sync: ${mismatches.join(", ")}`);
    console.log(`Verified ${SKILL_MAP.length} skills against Gajae-Code v${version}`);
    return;
  }

  await updateSourceVersion(version);
  console.log(`Synced ${SKILL_MAP.length} skills from upstream Gajae-Code ${version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
