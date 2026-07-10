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

import log_metric as lm  # 같은 폴더 (scripts/)

SESS_DIR = os.path.join(os.path.expanduser("~"), ".codex", "sessions")
STATE_PATH = os.path.join(lm.CONFIG_DIR, "codex_state.json")
MAX_AGE_DAYS = 14


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


if __name__ == "__main__":
    run()
