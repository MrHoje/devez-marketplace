#!/usr/bin/env python
"""Codex CLI 세션 로거. ~/.codex/sessions의 rollout-*.jsonl을 스캔해 새 turn을 기록.
Codex Stop hook에서 codex 종료 후 이 스캐너를 돌림.
log_metric의 분류기/insert/Supabase 설정 재사용. source='codex'.
상태파일(codex_state.json)로 이미 기록한 turn 추적 → 중복 방지, 재실행 안전.
"""
import glob
import json
import os
import time
from datetime import datetime, timezone

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

import log_metric as lm  # 같은 폴더 (scripts/)

SESS_DIR = os.path.join(os.path.expanduser("~"), ".codex", "sessions")
STATE_PATH = os.path.join(lm.CONFIG_DIR, "codex_state.json")
MAX_AGE_DAYS = 14

HOOKS_PATH = os.path.join(os.path.expanduser("~"), ".codex", "hooks.json")
PLUGIN_KEY = "Claudex-protocol@devez-marketplace"
CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude")

# 동시 스캐너 경합 방지: Stop마다 detached 스캐너가 떠서 같은 state를 읽고
# 같은 turn을 중복 insert(TOCTOU)하는 것을 락 파일로 직렬화.
LOCK_PATH = os.path.join(lm.CONFIG_DIR, "codex_scan.lock")
LOCK_STALE_SEC = 600  # 10분 넘은 락 = 죽은 프로세스 잔재로 보고 회수


def _acquire_lock():
    os.makedirs(lm.CONFIG_DIR, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(LOCK_PATH) > LOCK_STALE_SEC:
                    os.remove(LOCK_PATH)
                    continue  # 회수 후 재시도
            except OSError:
                pass
            return False
        except OSError:
            return False
    return False


def _release_lock():
    try:
        os.remove(LOCK_PATH)
    except OSError:
        pass


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


def _delta_usage(cur_total, prev_total):
    """total_token_usage(세션 누적)의 turn 간 델타 = 이 turn의 실제 총 사용량.
    last_token_usage(마지막 API 호출)만 쓰면 tool 루프 turn의 출력이 누락되므로
    claude(turn 전체 누적)와 기준을 맞추기 위해 누적 델타로 계산."""
    d = {}
    for k in ("input_tokens", "output_tokens", "reasoning_output_tokens",
              "cached_input_tokens", "total_tokens"):
        d[k] = max(0, (cur_total.get(k, 0) or 0) - (prev_total.get(k, 0) or 0))
    return d


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
    effort = None
    cwd = None
    approval_mode = None
    sandbox_mode = None
    turns = []
    cur = None
    prev_total = {}  # 직전 turn까지의 total_token_usage 누적(델타 계산 기준점)
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
            effort = lm.normalize_effort(p.get("effort")) or effort
            cwd = p.get("cwd", cwd)
            approval_mode = p.get("approval_policy", approval_mode)
            sandbox = p.get("sandbox_policy")
            if isinstance(sandbox, dict):
                sandbox = sandbox.get("type") or sandbox.get("mode")
            if isinstance(sandbox, str):
                sandbox_mode = sandbox
            # Newer Codex rollouts can emit task_started before turn_context.
            # Keep the active turn synchronized instead of retaining None or
            # the preceding turn's model/effort values.
            if cur is not None:
                cur["model"] = model
                cur["effort"] = effort
                cur["cwd"] = cwd
                cur["approval_mode"] = approval_mode
                cur["sandbox_mode"] = sandbox_mode
        elif pt == "task_started":
            cur = {"start": ts, "end": ts, "model": model, "effort": effort, "cwd": cwd,
                   "approval_mode": approval_mode, "sandbox_mode": sandbox_mode,
                   "prompt": "", "response": "", "input_tokens": 0,
                   "output_tokens": 0, "tool_calls": 0, "usage": {},
                   "code_files": 0, "code_lines": 0, "reasoning_tokens": 0,
                   "cost_usd": 0.0, "interrupted": False,
                   "edit_events": 0, "cache_read": 0}
        elif cur is not None:
            if pt == "user_message":
                msg = p.get("message") or p.get("text") or ""
                s = msg if isinstance(msg, str) else json.dumps(msg)
                if lm.INTERRUPT_MARK in s:
                    # 프롬프트 있는 turn이면 그 turn이 중단된 것, 없으면 직전 완료 turn이 중단된 것
                    if cur.get("prompt"):
                        cur["interrupted"] = True
                    elif turns:
                        turns[-1]["interrupted"] = True
                else:
                    cur["prompt"] = s
            elif pt == "agent_message":
                m = p.get("message", "")
                if isinstance(m, str):
                    cur["response"] += m
            elif pt == "token_count":
                info = p.get("info") or {}
                tot = info.get("total_token_usage")
                if tot:
                    cur["_last_total"] = tot  # turn 종료 시 델타로 환산
                else:
                    lu = info.get("last_token_usage") or {}  # 구버전 fallback
                    if lu:
                        cur["input_tokens"] = lu.get("input_tokens", cur["input_tokens"]) or 0
                        cur["output_tokens"] = lu.get("output_tokens", cur["output_tokens"]) or 0
                        cur["reasoning_tokens"] = lu.get("reasoning_output_tokens", cur["reasoning_tokens"]) or 0
                        cur["cache_read"] = lu.get("cached_input_tokens", cur["cache_read"]) or 0
                        cur["usage"] = lu
                cur["model"] = model
            elif t == "response_item" and pt and "call" in pt:
                cur["tool_calls"] += 1
                blob = json.dumps(p)  # apply_patch 편집 감지(근사)
                if "apply_patch" in blob or "*** Update File" in blob or "*** Add File" in blob:
                    cur["edit_events"] += 1
                    cur["code_files"] += blob.count("*** Update File") + blob.count("*** Add File")
                    cur["code_lines"] += blob.count("\\n+")
            elif pt == "task_complete":
                cur["end"] = ts
                cur["duration_ms"] = p.get("duration_ms") or _dur_ms(cur["start"], ts)
                cur["ttft_ms"] = p.get("time_to_first_token_ms")
                lt = cur.pop("_last_total", None)
                if lt:  # total 누적 → turn 델타로 환산(claude와 동일 기준)
                    d = _delta_usage(lt, prev_total)
                    cur["input_tokens"] = d["input_tokens"]
                    cur["output_tokens"] = d["output_tokens"]
                    cur["reasoning_tokens"] = d["reasoning_output_tokens"]
                    cur["cache_read"] = d["cached_input_tokens"]
                    cur["usage"] = d
                    prev_total = lt
                cur["cost_usd"] = round(lm.cost_codex(cur.get("usage") or {}, cur.get("model")), 6)
                turns.append(cur)
                cur = None
    return session_id, turns


def run():
    if not _acquire_lock():
        lm.log("codex scan skipped: another scanner active")
        return
    try:
        _run_locked()
    finally:
        _release_lock()


def _run_locked():
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
            # 성과 신호: 중단됐거나(자기 턴), 다음 턴이 재작업/불만이면(배치라 즉시 판정)
            signal = ("interrupted" if tn.get("interrupted")
                      else "reworked" if (i + 1 < len(turns) and lm.is_rework(turns[i + 1].get("prompt", "")))
                      else None)
            cwd = tn.get("cwd") or ""
            row = {
                "source": "codex",
                "occurred_at": tn.get("end") or tn.get("start"),
                "session_id": sid,
                "project": os.path.basename(cwd.rstrip("/\\")) if cwd else None,
                "model": tn.get("model"),
                "effort": lm.normalize_effort(tn.get("effort")),
                "category": cls["category"],
                "difficulty": cls["difficulty"],
                "difficulty_llm": cls.get("difficulty_llm"),
                "domain": cls.get("domain"),
                "outcome": cls.get("outcome"),
                "input_tokens": tn["input_tokens"],
                "output_tokens": tn["output_tokens"],
                "tool_calls": tn["tool_calls"],
                "duration_ms": tn.get("duration_ms"),
                "ttft_ms": tn.get("ttft_ms"),
                "cost_usd": tn.get("cost_usd"),
                "code_files": tn.get("code_files"),
                "code_lines": tn.get("code_lines"),
                "reasoning_tokens": tn.get("reasoning_tokens"),
                "approval_mode": tn.get("approval_mode"),
                "sandbox_mode": tn.get("sandbox_mode"),
                "outcome_signal": signal,
                "raw": {"reason": cls["reason"], "usage": tn.get("usage"), "turn": i,
                        "quality": {
                            "interrupted": tn.get("interrupted"),
                            "edit_events": tn.get("edit_events"),
                            "cache_read": tn.get("cache_read"),
                        }},
            }
            lm.insert(env, row)
            new += 1
        state[sid] = len(turns)
    save_state(state)
    lm.log(f"codex scan done: {new} new turns ({len(files)} files seen)")


def _spawn_detached():
    """스캔은 느림(턴별 분류 호출). Stop hook 타임아웃 방지 위해 백그라운드로 분리 후 즉시 반환."""
    import subprocess
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        # NO_WINDOW만(DETACHED 조합 금지 — NO_WINDOW 무시돼 손자 콘솔이 새 창 띄움)
        kwargs["creationflags"] = 0x08000000 | 0x00000200  # NO_WINDOW | NEW_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([lm.real_pyw(), "-X", "utf8", os.path.abspath(__file__), "--run"], **kwargs)


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
