#!/usr/bin/env bun
/**
 * gajae-code 최신 버전을 hoje-code에 동기화하는 스크립트
 * 
 * 사용법:
 *   bun run scripts/sync-gajae.ts              # 최신 릴리스 확인 및 동기화
 *   bun run scripts/sync-gajae.ts --version v0.9.0  # 특정 버전 지정
 *   bun run scripts/sync-gajae.ts --check-only      # 새 버전 있는지만 확인
 */

const GAJAE_REPO = "Yeachan-Heo/gajae-code";
const GAJAE_SKILLS_BASE = "packages/coding-agent/src/defaults/gjc/skills";
const GAJAE_FRAGMENTS_BASE = "packages/coding-agent/src/defaults/gjc/skill-fragments";

const PLUGIN_DIR = `${import.meta.dirname}/../plugins/hoje-code`;
const SKILLS_DIR = `${PLUGIN_DIR}/skills`;

const SKILL_MAP: Record<string, { source: string; target: string; type: string }> = {
  "hoje-ask":              { source: `${GAJAE_SKILLS_BASE}/deep-interview/SKILL.md`,              target: "hoje-ask/SKILL.md",              type: "main" },
  "hoje-plan":             { source: `${GAJAE_SKILLS_BASE}/ralplan/SKILL.md`,                     target: "hoje-plan/SKILL.md",             type: "main" },
  "hoje-goals":            { source: `${GAJAE_SKILLS_BASE}/ultragoal/SKILL.md`,                   target: "hoje-goals/SKILL.md",            type: "main" },
  "hoje-ask-auto-answer":  { source: `${GAJAE_FRAGMENTS_BASE}/<deploy>/auto-answer-uncertain.md`, target: "hoje-ask-auto-answer/SKILL.md",  type: "fragment" },
  "hoje-ask-greenfield":   { source: `${GAJAE_FRAGMENTS_BASE}/<deploy>/auto-research-greenfield.md`, target: "hoje-ask-greenfield/SKILL.md", type: "fragment" },
  "hoje-ask-panel":        { source: `${GAJAE_FRAGMENTS_BASE}/<deploy>/lateral-review-panel.md`,  target: "hoje-ask-panel/SKILL.md",        type: "fragment" },
  "hoje-goals-slop-cleaner": { source: `${GAJAE_FRAGMENTS_BASE}/ultragoal/ai-slop-cleaner.md`,    target: "hoje-goals-slop-cleaner/SKILL.md", type: "fragment" },
};

const ADAPT_RULES: [RegExp, string][] = [
  [/\.gjc\//g, ".hoje/"],
  [/\bgjc\b(?!\.)/g, "hoje"],
  [/\bGJC\b/g, "Hoje-Code"],
  [/\/skill:deep-interview\b/g, "/skill:hoje-ask"],
  [/\/skill:ralplan\b/g, "/skill:hoje-plan"],
  [/\/skill:ultragoal\b/g, "/skill:hoje-goals"],
  [/\/skill:team\b/g, "/skill:hoje-team"],
  [/kind: "skill-fragment"/g, 'hidden: true'],
  [/skill-fragments\//g, "skills/"],
];

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  body: string;
}

async function getLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${GAJAE_REPO}/releases/latest`);
  if (!res.ok) throw new Error(`Failed to fetch latest release: ${res.status}`);
  return res.json();
}

async function getReleaseByTag(tag: string): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${GAJAE_REPO}/releases/tags/${tag}`);
  if (!res.ok) throw new Error(`Failed to fetch release ${tag}: ${res.status}`);
  return res.json();
}

async function fetchRaw(url: string): Promise<string> {
  const rawUrl = url.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/");
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${rawUrl}: ${res.status}`);
  return res.text();
}

function adaptContent(content: string): string {
  let result = content;
  for (const [pattern, replacement] of ADAPT_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

async function getCurrentVersion(): Promise<string | null> {
  try {
    const mf = await Bun.file(`${import.meta.dirname}/../.claude-plugin/marketplace.json`).text();
    const json = JSON.parse(mf);
    return json.version || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-only");
  const versionArg = args.find(a => a.startsWith("--version="))?.split("=")[1] || args.find(a => a.startsWith("-v="))?.split("=")[1];

  console.log(`🔍 Checking ${GAJAE_REPO} for updates...`);

  let release: GitHubRelease;
  if (versionArg) {
    release = await getReleaseByTag(versionArg);
  } else {
    release = await getLatestRelease();
  }

  console.log(`📦 Latest release: ${release.tag_name} (${release.published_at})`);
  console.log(`   ${release.html_url}`);

  if (checkOnly) {
    const currentVer = await getCurrentVersion();
    console.log(`   Current hoje-code reference: gajae-code ${currentVer ? `v${currentVer}` : "unknown"}`);
    process.exit(0);
  }

  // Fetch each skill file
  for (const [skillName, mapping] of Object.entries(SKILL_MAP)) {
    const targetPath = `${SKILLS_DIR}/${mapping.target}`;
    const sourceUrl = `https://github.com/${GAJAE_REPO}/blob/main/${mapping.source}`;

    console.log(`   Fetching ${skillName}...`);
    try {
      const raw = await fetchRaw(sourceUrl);
      const adapted = adaptContent(raw);

      // Ensure target directory exists
      const targetDir = targetPath.replace(/\/[^/]+$/, "");
      await Bun.write(targetPath, adapted);
      console.log(`      ✓ ${mapping.target}`);
    } catch (err) {
      console.error(`      ✗ Failed: ${err}`);
    }
  }

  // Update marketplace version
  const mfPath = `${import.meta.dirname}/../.claude-plugin/marketplace.json`;
  const mf = JSON.parse(await Bun.file(mfPath).text());
  const verTag = release.tag_name.replace(/^v/, "");
  mf.version = verTag;
  await Bun.write(mfPath, JSON.stringify(mf, null, 2) + "\n");
  console.log(`   ✓ Updated marketplace.json version to ${verTag}`);

  console.log(`\n✅ Sync complete! Review changes and commit:
   git add -A
   git commit -m "sync: gajae-code ${release.tag_name}"
   git push`);
}

main().catch(err => {
  console.error("❌", err.message);
  process.exit(1);
});
