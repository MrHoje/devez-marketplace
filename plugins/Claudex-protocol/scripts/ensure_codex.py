#!/usr/bin/env python
"""Claude Code SessionStart hook: Codex(~/.codex/hooks.json) Stop 배열에 codex_scan.py를
멱등 주입. 이미 있으면 스킵. Codex가 설치돼 있을 때만 동작.
주의: Codex는 새 hook을 최초 1회 '신뢰' 승인 요구함(보안). 그 1번은 불가피.
stdout 비움(컨텍스트 오염 금지). 실패해도 조용히 종료.
"""
import json
import os
import sys

if os.name == "nt" and __name__ == "__main__":
    try:
        import ctypes
        k = ctypes.windll.kernel32
        _w = k.GetConsoleWindow()
        # 우리가 단독 소유한 콘솔일 때만 숨긴다. codex 는 훅을 '터미널 콘솔 상속'으로 스폰하므로
        # GetConsoleWindow() 가 사용자의 외부 터미널을 가리킨다 — 그때 SW_HIDE 하면 그 터미널 창이
        # 통째로 숨겨진다(응답-종료 시 창 최소화). 콘솔에 붙은 프로세스가 우리 하나뿐(=우리가 만든
        # 콘솔)일 때만 안전하게 숨긴다. claude 는 con=0(콘솔 없음)이라 애초에 no-op.
        if _w and k.GetConsoleProcessList((ctypes.c_uint * 8)(), 8) <= 1:
            ctypes.windll.user32.ShowWindow(_w, 0)  # SW_HIDE
    except Exception:
        pass

CODEX_DIR = os.path.join(os.path.expanduser("~"), ".codex")
HOOKS_PATH = os.path.join(CODEX_DIR, "hooks.json")
SCAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex_scan.py")

# 고정 런처: 버전 안 박힌 안정 경로 → codex 훅 명령이 업데이트마다 안 바뀜 → Codex 재신뢰 불필요.
CONFIG_DIR = os.environ.get("MODEL_STATS_HOME") or os.path.join(os.path.expanduser("~"), ".model-stats")
LAUNCHER = os.path.join(CONFIG_DIR, "codex_hook.py")


def _write_launcher():
    """codex_scan.py 실행 런처를 고정 경로(~/.model-stats/codex_hook.py)에 기록.
    버전 비고정: 실행 시 플러그인 캐시에서 '가장 높은 버전'의 codex_scan.py 를 동적으로 찾아 돈다.
    → 플러그인 업데이트 시 claude 재시작/ensure_codex 재실행 없이도 최신 코드가 즉시 반영된다.
      (예전엔 런처가 특정 버전 경로에 박혀 있어, 새 버전 ensure_codex 가 돌기 전까지 외부 codex 가
       옛 버전 코드를 계속 실행 — 예: 구버전의 SW_HIDE 로 외부 터미널이 최소화되는 창.)
    SCAN(이 함수를 돌린 버전 경로)은 캐시 glob 이 비었을 때의 폴백으로만 박아둔다."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    base = os.path.dirname(os.path.dirname(os.path.dirname(SCAN)))  # .../<marketplace>/<plugin>
    content = (
        "import os, sys, runpy, glob\n"
        "_base = " + json.dumps(base) + "\n"
        "_pin = " + json.dumps(SCAN) + "\n"
        "def _pick():\n"
        "    cands = [c for c in glob.glob(os.path.join(_base, '*', 'scripts', 'codex_scan.py')) if os.path.exists(c)]\n"
        "    def _ver(p):\n"
        "        v = os.path.basename(os.path.dirname(os.path.dirname(p)))\n"
        "        try:\n"
        "            return tuple(int(x) for x in v.split('.'))\n"
        "        except Exception:\n"
        "            return ()\n"
        "    if cands:\n"
        "        return max(cands, key=_ver)\n"
        "    return _pin if os.path.exists(_pin) else None\n"
        "_t = _pick()\n"
        "if _t:\n"
        "    sys.path.insert(0, os.path.dirname(_t))  # codex_scan의 log_metric import 가능하게\n"
        "    runpy.run_path(_t, run_name='__main__')\n"
    )
    cur = None
    try:
        with open(LAUNCHER, encoding="utf-8") as f:
            cur = f.read()
    except Exception:
        pass
    if cur != content:
        with open(LAUNCHER, "w", encoding="utf-8") as f:
            f.write(content)


def _is_ours(group):
    for h in group.get("hooks", []) if isinstance(group, dict) else []:
        c = str(h.get("command", ""))
        if "codex_hook.py" in c or "codex_scan.py" in c:  # 신규 런처 + 구버전 직접경로
            return True
    return False


def main():
    if not os.path.isdir(CODEX_DIR):
        return  # Codex 미설치
    try:
        _write_launcher()
    except Exception:
        return
    py = "pythonw" if os.name == "nt" else "python"  # 콘솔 없음(win) / 이식성
    cmd = f'{py} -X utf8 "{LAUNCHER.replace(os.sep, "/")}"'  # 고정 명령(불변)

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

    kept = [g for g in stop if not _is_ours(g)]
    already = [g for g in stop if _is_ours(g)]
    # 이미 정확히 현재 cmd 1개면 파일 안 건드림(불필요한 재신뢰 방지)
    if (len(already) == 1 and len(kept) == len(stop) - 1
            and already[0].get("hooks", [{}])[0].get("command") == cmd):
        return

    hooks["Stop"] = kept + [{"hooks": [{"type": "command", "command": cmd}]}]
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
