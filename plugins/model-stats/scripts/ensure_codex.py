#!/usr/bin/env python
"""Claude Code SessionStart hook: Codex(~/.codex/hooks.json) Stop 배열에 codex_scan.py를
멱등 주입. 이미 있으면 스킵. Codex가 설치돼 있을 때만 동작.
주의: Codex는 새 hook을 최초 1회 '신뢰' 승인 요구함(보안). 그 1번은 불가피.
stdout 비움(컨텍스트 오염 금지). 실패해도 조용히 종료.
"""
import json
import os
import sys

CODEX_DIR = os.path.join(os.path.expanduser("~"), ".codex")
HOOKS_PATH = os.path.join(CODEX_DIR, "hooks.json")
SCAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex_scan.py")


def main():
    if not os.path.isdir(CODEX_DIR):
        return  # Codex 미설치
    cmd = f'python "{SCAN.replace(os.sep, "/")}"'

    data = {"hooks": {}}
    if os.path.exists(HOOKS_PATH):
        try:
            with open(HOOKS_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return  # 파싱 실패 시 남의 파일 안 건드림
    if not isinstance(data, dict):
        return
    hooks = data.setdefault("hooks", {})
    stop = hooks.setdefault("Stop", [])
    if not isinstance(stop, list):
        return

    # 이미 codex_scan.py 참조하는 항목 있으면 스킵(경로 달라도 파일명으로 판정)
    def has_scan(group):
        for h in group.get("hooks", []) if isinstance(group, dict) else []:
            if "codex_scan.py" in str(h.get("command", "")):
                return True
        return False

    if any(has_scan(g) for g in stop):
        return

    stop.append({"hooks": [{"type": "command", "command": cmd}]})
    try:
        with open(HOOKS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
