#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pluginRoot = path.resolve(__dirname, "..");

function main() {
  const args = process.argv.slice(2);
  const cli = path.join(pluginRoot, "runtime", "cli.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env: process.env,
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
