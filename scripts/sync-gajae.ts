#!/usr/bin/env bun
/** Sync the latest published Gajae-Code workflow skills into hoje-code. */

const GAJAE_REPO = "Yeachan-Heo/gajae-code";
const NPM_PACKAGE = "@gajae-code/coding-agent";
const SOURCE_BASE = "packages/coding-agent/src/defaults/gjc/skills";
const PLUGIN_DIR = `${import.meta.dirname}/../plugins/hoje-code`;
const SKILLS_DIR = `${PLUGIN_DIR}/skills`;
const MARKETPLACE_PATH = `${import.meta.dirname}/../.claude-plugin/marketplace.json`;

type SkillMapping = {
  source: string;
  target: string;
  name: string;
  description?: string;
};

const SKILL_MAP: SkillMapping[] = [
  { source: "deep-interview/SKILL.md", target: "hoje-ask/SKILL.md", name: "hoje-ask" },
  { source: "ralplan/SKILL.md", target: "hoje-plan/SKILL.md", name: "hoje-plan" },
  { source: "ultragoal/SKILL.md", target: "hoje-goals/SKILL.md", name: "hoje-goals" },
  {
    source: "deep-interview/auto-answer-uncertain.md",
    target: "hoje-ask-auto-answer/SKILL.md",
    name: "hoje-ask-auto-answer",
    description: "Internal read-only helper that resolves an uncertain Deep Interview answer.",
  },
  {
    source: "deep-interview/auto-research-greenfield.md",
    target: "hoje-ask-greenfield/SKILL.md",
    name: "hoje-ask-greenfield",
    description: "Internal read-only helper that researches greenfield Deep Interview options.",
  },
  {
    source: "deep-interview/lateral-review-panel.md",
    target: "hoje-ask-panel/SKILL.md",
    name: "hoje-ask-panel",
    description: "Internal read-only lateral review persona for Deep Interview.",
  },
  {
    source: "ultragoal/ai-slop-cleaner.md",
    target: "hoje-goals-slop-cleaner/SKILL.md",
    name: "hoje-goals-slop-cleaner",
    description: "Internal read-only AI slop detector for the Ultragoal completion gate.",
  },
  {
    source: "ultragoal/pipeline-validation-contracts.md",
    target: "hoje-goals-pipeline-validation/SKILL.md",
    name: "hoje-goals-pipeline-validation",
    description: "Internal Ultragoal pipeline overlap and validation-batch contracts.",
  },
];

const CONTENT_RULES: [RegExp, string][] = [
  [/\/skill:deep-interview\b/g, "/hoje-code:hoje-ask"],
  [/\/skill:ralplan\b/g, "/hoje-code:hoje-plan"],
  [/\/skill:ultragoal\b/g, "/hoje-code:hoje-goals"],
  [/\/skill:team\b/g, "hoje team"],
  [/(?<![\w.])gjc (?=(?:state|ralplan|ultragoal|team|skills|--version|--smoke-test)\b)/g, "hoje "],
  [/`auto-answer-uncertain\.md`/g, "`/hoje-code:hoje-ask-auto-answer`"],
  [/`auto-research-greenfield\.md`/g, "`/hoje-code:hoje-ask-greenfield`"],
  [/`lateral-review-panel\.md`/g, "`/hoje-code:hoje-ask-panel`"],
  [/`pipeline-validation-contracts` fragment/g, "`/hoje-code:hoje-goals-pipeline-validation` internal skill"],
  [/`ai-slop-cleaner`, an internal Ultragoal sub-skill/g, "`/hoje-code:hoje-goals-slop-cleaner`, an internal Ultragoal skill"],
  [/`skill-fragments\/ultragoal\/pipeline-validation-contracts\.md`/g, "`/hoje-code:hoje-goals-pipeline-validation`"],
  [/`skill-fragments\/ultragoal\/ai-slop-cleaner\.md`/g, "`/hoje-code:hoje-goals-slop-cleaner`"],
  [/`kind: "skill-fragment"`/g, "an internal Hoje-Code plugin skill"],
  [/a an internal Hoje-Code plugin skill/g, "an internal Hoje-Code plugin skill"],
  [/Preserve the GJC `ask` tool path for native interaction; do not introduce parallel structured-question transport into this skill/g, "Use Claude Code's `AskUserQuestion` tool for native interaction and persist GJC workflow state explicitly through `hoje state`"],
  [/`ask`/g, "`AskUserQuestion`"],
  [/goal\(\{"op":"get"\}\)/g, "TaskList"],
  [/goal\(\{"op":"create","objective":"<printed aggregate or per-story objective>"\}\)/g, "TaskCreate(subject=<printed objective>, status=in_progress)"],
  [/goal\(\{"op":"complete"\}\)/g, "TaskUpdate(status=completed)"],
  [/goal\(\{"op":"drop"\}\)/g, "TaskUpdate(status=completed, description=superseded)"],
  [/goal\(\{"op":"resume"\}\)/g, "TaskUpdate(status=in_progress)"],
  [/goal\(\{"op":"pause"\}\)/g, "TaskUpdate(status=pending)"],
  [/unified goal-tool surface/g, "Claude task bridge"],
  [/inline goal state/g, "inline Claude task state"],
];

function parseVersionArg(args: string[]): string | undefined {
  const inline = args.find((arg) => arg.startsWith("--version=") || arg.startsWith("-v="));
  if (inline) return inline.split("=", 2)[1]?.replace(/^v/, "");
  const index = args.findIndex((arg) => arg === "--version" || arg === "-v");
  return index >= 0 ? args[index + 1]?.replace(/^v/, "") : undefined;
}

async function getLatestVersion(): Promise<string> {
  const encoded = encodeURIComponent(NPM_PACKAGE);
  const response = await fetch(`https://registry.npmjs.org/${encoded}/latest`);
  if (!response.ok) throw new Error(`Failed to fetch npm latest metadata: ${response.status}`);
  const metadata = (await response.json()) as { version?: string };
  if (!metadata.version) throw new Error("npm latest metadata has no version");
  return metadata.version;
}

async function fetchSource(version: string, source: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${GAJAE_REPO}/v${version}/${SOURCE_BASE}/${source}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${source} from v${version}: ${response.status}`);
  return response.text();
}

function adaptMainSkill(content: string, name: string): string {
  let result = content.replace(/^name:\s*[^\r\n]+/m, `name: ${name}`);
  if (!/^disable-model-invocation:/m.test(result)) {
    result = result.replace(/^(description:[^\r\n]+)$/m, "$1\ndisable-model-invocation: true");
  }
  const frontmatterEnd = result.indexOf("\n---", 4);
  if (frontmatterEnd < 0) throw new Error(`Invalid frontmatter for ${name}`);
  const insertionPoint = frontmatterEnd + 4;
  const compatibility = `

## Hoje-Code Claude compatibility

These rules override conflicting GJC-harness transport instructions below:

- Run backend workflow commands through \`hoje\`. The bundled launcher selects the pinned Gajae-Code runtime and supplies the current Claude session id.
- Keep GJC runtime state and configuration names unchanged: \`.gjc/\`, \`GJC_SESSION_ID\`, \`GJC_CONFIG_DIR\`, \`GJC_CODING_AGENT_DIR\`, and JSON key \`gjc\` are backend contracts.
- Use Claude Code's \`AskUserQuestion\` for upstream question operations. Never pass GJC-only \`deepInterview\` or \`workflowGate\` metadata to that tool; persist required answer, scoring, and approval state through the documented \`hoje state ...\` legacy path.
- Use Claude Code's Agent tool for upstream subagent operations and its resume handle when continuity is required.
- Use Claude Code tasks as the inline UX bridge: create one aggregate task, keep it \`in_progress\` during intermediate story checkpoints, and mark it \`completed\` only after the final durable receipt. Durable \`goals.json\` and \`ledger.jsonl\` remain authoritative.
- Invoke internal helpers through their namespaced Hoje-Code skills. They are hidden from the user command menu but remain model-invocable.
`;
  return `${result.slice(0, insertionPoint)}${compatibility}${result.slice(insertionPoint)}`;
}

function adaptContent(content: string, mapping: SkillMapping): string {
  let result = content.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of CONTENT_RULES) result = result.replace(pattern, replacement);
  if (mapping.name === "hoje-goals") {
    result = result.replace(
      /3\. Call `TaskList`\.\n4\. If no active GJC goal exists,[^\n]+/,
      "3. Call `TaskList` and locate the aggregate task for this run.\n4. If it does not exist, create it with `TaskCreate(subject=<printed payload objective>)` and mark it `in_progress`. Reuse the same task for every intermediate story. If a different stale aggregate task exists, mark it completed as superseded before creating the new aggregate task.",
    );
    result = result.replace(
      /- Use only the Claude task bridge from the agent loop:[\s\S]*?- In aggregate mode, intermediate and final story checkpoints update durable `goals\.json` state and append receipt proof to `ledger\.jsonl`; the final story checkpoint creates the final aggregate receipt before the agent may call `TaskUpdate\(status=completed\)`\./,
      "- Use `TaskList`, `TaskCreate`, and `TaskUpdate` only as the Claude UX bridge. Keep exactly one aggregate task `in_progress` across intermediate stories.\n- For back-to-back runs, complete any stale aggregate task as superseded before creating the next one. Never replace a different active user task.\n- Mark the aggregate task `completed` only after the durable final aggregate receipt exists.\n- In aggregate mode, intermediate and final story checkpoints update durable `goals.json` state and append receipt proof to `ledger.jsonl`; those artifacts, not task state, prove completion.",
    );
    result = result.replace(/inline goal-tool state/g, "inline Claude task state");
  }
  if (mapping.description) {
    result = `---\nname: ${mapping.name}\ndescription: ${mapping.description}\nuser-invocable: false\n---\n\n${result}`;
  } else {
    result = adaptMainSkill(result, mapping.name);
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

async function updateVersion(version: string): Promise<void> {
  const marketplace = JSON.parse(await Bun.file(MARKETPLACE_PATH).text());
  const entry = marketplace.plugins?.find((plugin: { name?: string }) => plugin.name === "hoje-code");
  if (!entry) throw new Error("hoje-code marketplace entry not found");
  entry.version = version;
  await Bun.write(MARKETPLACE_PATH, `${JSON.stringify(marketplace, null, 2)}\n`);

  const manifestPath = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
  if (await Bun.file(manifestPath).exists()) {
    const manifest = JSON.parse(await Bun.file(manifestPath).text());
    manifest.version = version;
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const checkOnly = args.includes("--check-only");
  const version = parseVersionArg(args) ?? (await getLatestVersion());
  console.log(`Gajae-Code npm latest/source tag: v${version}`);

  if (checkOnly) return;

  const mismatches: string[] = [];
  for (const mapping of SKILL_MAP) {
    const expected = adaptContent(await fetchSource(version, mapping.source), mapping);
    const targetPath = `${SKILLS_DIR}/${mapping.target}`;
    if (verify) {
      const actual = await Bun.file(targetPath).exists() ? await Bun.file(targetPath).text() : "";
      if (actual.replace(/\r\n/g, "\n") !== expected) mismatches.push(mapping.target);
    } else {
      await Bun.write(targetPath, expected);
      console.log(`updated ${mapping.target}`);
    }
  }

  if (verify) {
    if (mismatches.length) throw new Error(`Out of sync: ${mismatches.join(", ")}`);
    console.log(`Verified ${SKILL_MAP.length} skills against Gajae-Code v${version}`);
    return;
  }

  await updateVersion(version);
  console.log(`Synced ${SKILL_MAP.length} skills and set hoje-code version to ${version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
