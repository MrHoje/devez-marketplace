#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pluginRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
const runtimeVersion = manifest.version;
const runtimePackage = `@gajae-code/coding-agent@${runtimeVersion}`;

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.match(/gjc\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

function sessionId() {
  const configured = process.env.GJC_SESSION_ID?.trim() || process.env.HOJE_SESSION_ID?.trim();
  if (configured && /^[A-Za-z0-9._-]{1,128}$/.test(configured)) return configured;
  const digest = crypto.createHash("sha256").update(path.resolve(process.cwd())).digest("hex").slice(0, 20);
  return `hoje-shell-${digest}`;
}

function resolveRunner() {
  const installedVersion = commandVersion("gjc");
  if (installedVersion === runtimeVersion) return { command: "gjc", prefix: [], source: "global" };

  const bun = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (!bun.error && bun.status === 0) {
    return {
      command: "bunx",
      prefix: ["--bun", "--package", runtimePackage, "gjc"],
      source: installedVersion ? `bunx (global gjc is ${installedVersion})` : "bunx",
    };
  }

  throw new Error(
    `Hoje-Code requires Bun to run its pinned ${runtimePackage} backend. Install Bun from https://bun.sh and retry.`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const runner = resolveRunner();
  const env = { ...process.env, GJC_SESSION_ID: sessionId() };

  if (args[0] === "runtime" && args[1] === "version") {
    process.stdout.write(`hoje-code/${manifest.version} backend=gjc/${runtimeVersion} source=${runner.source}\n`);
    return 0;
  }

  const forwarded = args[0] === "runtime" && args[1] === "doctor" ? ["--smoke-test"] : args;
  const result = spawnSync(runner.command, [...runner.prefix, ...forwarded], {
    stdio: "inherit",
    env,
    windowsHide: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`hoje: ${error.message}\n`);
  process.exitCode = 1;
}
