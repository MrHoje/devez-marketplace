#!/usr/bin/env node

const fs = require("node:fs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const raw = typeof payload.session_id === "string" ? payload.session_id : "";
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
    if (!safe) throw new Error("SessionStart payload has no valid session_id");

    const sessionId = `claude-${safe}`;
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      fs.appendFileSync(
        envFile,
        `export GJC_SESSION_ID='${sessionId}'\nexport HOJE_SESSION_ID='${sessionId}'\n`,
        "utf8",
      );
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `Hoje-Code runtime initialized for ${sessionId}. Use the pinned hoje launcher for workflow state commands.`,
        },
      }),
    );
  } catch (error) {
    process.stderr.write(`hoje-code SessionStart: ${error.message}\n`);
    process.exitCode = 1;
  }
});
