#!/bin/bash
# Hermes 루틴 등록 스크립트
# gajae-code 최신 릴리스를 확인하고 hoje-code 스킬을 동기화합니다.
# 사용법: bash scripts/setup-hermes-routine.sh

HERMES_CMD="${HERMES_CMD:-hermes}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

$HERMES_CMD cron create "0 0 * * *" \
  "## Task: Sync hoje-code with latest gajae-code

### Step 1: Check latest gajae-code release
1. Use GitHub API to check latest release: https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest
2. Extract tag_name (e.g. v0.9.0)
3. Read current version from $REPO_DIR/.claude-plugin/marketplace.json (field: version)

### Step 2: Compare versions
4. If current version >= latest release tag, respond with '[SILENT]' and stop (no update needed)
5. If newer version exists, proceed to sync

### Step 3: Sync using the sync script
6. cd $REPO_DIR
7. Run: bun run scripts/sync-gajae.ts --version={latest_tag}
8. Check if there are changes: git status --porcelain

### Step 4: Create PR if changes exist
9. If changes exist:
   - git add -A
   - git commit -m \"sync: gajae-code {latest_tag}\"
   - git push origin main
   - gh pr create --base main --head main --title \"sync: gajae-code {latest_tag}\" --body \"gajae-code {latest_tag} 자동 동기화. 상세 매핑은 plugins/hoje-code/README.md 참고.\" --label sync
10. Report the result via the delivery target (PR number or 'up to date').

### Important notes
- Do NOT modify the sync script or marketplace.json manually
- If the sync script fails, report the error and stop
- The repo is at: $REPO_DIR
- Default branch: main" \
  --name "gajae-code-sync" \
  --deliver local \
  --workdir "$REPO_DIR"
