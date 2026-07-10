#!/usr/bin/env python
"""Codex CLI 세션 로거. ~/.codex/sessions의 rollout-*.jsonl을 스캔해 새 turn을 기록.
Codex Stop hook에서 codex 종료 후 이 스캐너를 돌림.
log_metric의 분류기/insert/Supabase 설정 재사용. source='codex'.
상태파일(codex_state.json)로 이미 기록한 turn 추적 → 중복 방지, 재실행 안전.
"""
import glob
import json
import os
from datetime import datetime, timezone

if os.name == "nt" and __name__ == "__main__":
    try:
        import ctypes
        _w = ctypes.windll.kernel32.GetConsoleWindow()
        if _w:
            ctypes.windll.user32.ShowWindow(_w, 0)  # SW_HIDE
    except Exception:
        pass

import log_metric as lm  # 같은 폴더 (scripts/)

SESS_DIR = os.path.join(os.path.expanduser("~"), ".codex", "sessions")
STATE_PATH = os.path.join(lm.CONFIG_DIR, "codex_state.json")
MAX_AGE_DAYS = 14

HOOKS_PATH = os.path.join(os.path.expanduser("~"), ".codex", "hooks.json")
PLUGIN_KEY = "model-stats@devez-marketplace"
CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")


def _claude_plugin_disabled():
    """Claude에서 이 플러그인이 '설치됐지만 비활성'이면 True. 확신 못하면 False(=유지, fail-safe).
    settings의 enabledPlugins + installed_plugins.json 조합으로 판정."""
    read_any = False
    enabled = False
    for name in ("settings.json", "settings.local.json"):
        p = os.path.join(CLAUDE_DIR, name)
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
            read_any = True
            if (d.get("enabledPlugins") or {}).get(PLUGIN_KEY) is True:
                enabled = True
        except FileNotFoundError:
            continue
        except Exception:
            return False  # 파싱 실패 → 판단 불가 → 유지
    if not read_any or enabled:
        return False  # 설정 못 읽음 or 활성 → 유지
    # 활성 아님 확인됨. 설치목록에 있으면(=설치됨+비활성) 확정.
    try:
        with open(os.path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"), encoding="utf-8") as f:
            inst = json.load(f)
        return PLUGIN_KEY in (inst.get("plugins") or {})
    except Exception:
        return False  # 설치목록 못 읽음 → 확신 불가 → 유지


def _remove_self_from_codex():
    """~/.codex/hooks.json Stop에서 codex_scan.py 참조 항목 제거."""
    try:
        with open(HOOKS_PATH, encoding="utf-8") as f:
            d = json.load(f)
        stop = (d.get("hooks") or {}).get("Stop") or []
        def _ours(g):
            for h in (g.get("hooks", []) if isinstance(g, dict) else []):
                c = str(h.get("command", ""))
                if "codex_scan.py" in c or "codex_hook.py" in c:
                    return True
            return False
        kept = [g for g in stop if not _ours(g)]
        if len(kept) != len(stop):
            d["hooks"]["Stop"] = kept
            with open(HOOKS_PATH, "w", encoding="utf-8") as f:
                json.dump(d, f, indent=2, ensure_ascii=False)
            return True
    except Exception as e:
        lm.log(f"codex self-remove fail: {e}")
    return False


def load_state():
    try:
        return json.load(open(STATE_PATH, encoding="utf-8"))
    except Exception:
        return {}


def save_state(s):
    try:
        os.makedirs(lm.CONFIG_DIR, exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(s, f)
    except Exception as e:
        lm.log(f"codex state save fail: {e}")


def _dur_ms(start, end):
    try:
        t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
        return int((t1 - t0).total_seconds() * 1000)
    except Exception:
        return None


def parse_turns(path):
    """rollout 파일 → (session_id, [turn,...]). turn = task_started~task_complete 구간."""
    session_id = None
    model = None
    cwd = None
    turns = []
    cur = None
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        p = e.get("payload") or {}
        pt = p.get("type") if isinstance(p, dict) else None
        ts = e.get("timestamp")

        if t == "session_meta":
            session_id = p.get("session_id") or p.get("id")
            cwd = p.get("cwd", cwd)
        elif t == "turn_context":
            model = p.get("model", model)
            cwd = p.get("cwd", cwd)
        elif pt == "task_started":
            cur = {"start": ts, "end": ts, "model": model, "cwd": cwd,
                   "prompt": "", "response": "", "input_tokens": 0,
                   "output_tokens": 0, "tool_calls": 0, "usage": {},
                   "code_files": 0, "code_lines": 0, "reasoning_tokens": 0,
                   "cost_usd": 0.0}
        elif cur is not None:
            if pt == "user_message":
                msg = p.get("message") or p.get("text") or ""
                cur["prompt"] = msg if isinstance(msg, str) else json.dumps(msg)
            elif pt == "agent_message":
                m = p.get("message", "")
                if isinstance(m, str):
                    cur["response"] += m
            elif pt == "token_count":
                lu = (p.get("info") or {}).get("last_token_usage") or {}
                if lu:
                    cur["input_tokens"] = lu.get("input_tokens", cur["input_tokens"]) or 0
                    cur["output_tokens"] = lu.get("output_tokens", cur["output_tokens"]) or 0
                    cur["reasoning_tokens"] = lu.get("reasoning_output_tokens", cur["reasoning_tokens"]) or 0
                    cur["usage"] = lu
                cur["model"] = model
            elif t == "response_item" and pt and "call" in pt:
                cur["tool_calls"] += 1
                blob = json.dumps(p)  # apply_patch 편집 감지(근사)
                if "apply_patch" in blob or "*** Update File" in blob or "*** Add File" in blob:
                    cur["code_files"] += blob.count("*** Update File") + blob.count("*** Add File")
                    cur["code_lines"] += blob.count("\\n+")
            elif pt == "task_complete":
                cur["end"] = ts
                cur["duration_ms"] = _dur_ms(cur["start"], ts)
                cur["cost_usd"] = round(lm.cost_codex(cur.get("usage") or {}, cur.get("model")), 6)
                turns.append(cur)
                cur = None
    return session_id, turns


def run():
    # 플러그인이 Claude에서 비활성화됐으면 codex 훅 자기제거 후 종료(고아 훅 정리)
    if _claude_plugin_disabled():
        if _remove_self_from_codex():
            lm.log("plugin disabled in Claude → removed own codex Stop hook")
        return
    env = lm.load_env()
    if not env.get("SUPABASE_URL"):
        lm.log("codex scan: no supabase config"); return
    state = load_state()
    cutoff = None
    try:
        cutoff = (datetime.now(timezone.utc).timestamp()) - MAX_AGE_DAYS * 86400
    except Exception:
        pass
    files = glob.glob(os.path.join(SESS_DIR, "**", "rollout-*.jsonl"), recursive=True)
    new = 0
    for path in files:
        try:
            if cutoff and os.path.getmtime(path) < cutoff:
                continue
        except OSError:
            continue
        try:
            sid, turns = parse_turns(path)
        except Exception as e:
            lm.log(f"codex parse fail {os.path.basename(path)}: {e}"); continue
        if not sid or not turns:
            continue
        done = state.get(sid, 0)
        if len(turns) <= done:
            continue
        for i in range(done, len(turns)):
            tn = turns[i]
            if not tn.get("prompt"):
                continue
            cls = lm.classify(tn["prompt"], tn["response"], tn, env)
            cwd = tn.get("cwd") or ""
            row = {
                "source": "codex",
                "created_at": tn.get("end") or tn.get("start"),  # 턴 실제 시각(배치 insert라도 실제시각 유지)
                "session_id": sid,
                "project": os.path.basename(cwd.rstrip("/\\")) if cwd else None,
                "model": tn.get("model"),
                "category": cls["category"],
                "difficulty": cls["difficulty"],
                "difficulty_llm": cls.get("difficulty_llm"),
                "domain": cls.get("domain"),
                "outcome": cls.get("outcome"),
                "input_tokens": tn["input_tokens"],
                "output_tokens": tn["output_tokens"],
                "tool_calls": tn["tool_calls"],
                "duration_ms": tn.get("duration_ms"),
                "cost_usd": tn.get("cost_usd"),
                "code_files": tn.get("code_files"),
                "code_lines": tn.get("code_lines"),
                "reasoning_tokens": tn.get("reasoning_tokens"),
                "raw": {"reason": cls["reason"], "usage": tn.get("usage"), "turn": i},
            }
            lm.insert(env, row)
            new += 1
        state[sid] = len(turns)
    save_state(state)
    lm.log(f"codex scan done: {new} new turns ({len(files)} files seen)")


def _spawn_detached():
    """스캔은 느림(턴별 분류 호출). Stop hook 타임아웃 방지 위해 백그라운드로 분리 후 즉시 반환."""
    import subprocess
    import sys
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--run"], **kwargs)


if __name__ == "__main__":
    import sys
    if "--run" in sys.argv:
        lm.con_diag("cs-run")
        run()
    else:
        lm.con_diag("cs-parent")
        try:
            _spawn_detached()
        except Exception as e:
            lm.log(f"codex spawn fail: {e}")
    raise SystemExit(0)
