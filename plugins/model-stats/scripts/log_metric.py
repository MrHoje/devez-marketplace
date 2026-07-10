#!/usr/bin/env python
"""Claude Code Stop hook: 프롬프트 분류(로컬 규칙) + Supabase 기록.
의존성 없음(stdlib urllib/json). 비동기: hook은 worker를 detach 후 즉시 종료(블로킹 X).
런타임 설정/로그/상태는 repo 밖 ~/.model-stats/ 에 둠 (실키가 플러그인 repo에 안 실림).
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from datetime import datetime, timezone

CONFIG_DIR = os.environ.get("MODEL_STATS_HOME") or os.path.join(os.path.expanduser("~"), ".model-stats")
ENV_PATH = os.path.join(CONFIG_DIR, ".env")
LOG_PATH = os.path.join(CONFIG_DIR, "metric.log")

TABLE = "model_metrics"

# 무설정 동작용 기본값(anon 키 = insert/select 전용, 통계만 — 프롬프트 본문 미저장).
# ~/.model-stats/.env 나 환경변수(SUPABASE_URL/SUPABASE_KEY)로 덮어쓰기 가능.
DEFAULT_URL = "https://juaikaqmbulgxpleasoh.supabase.co"
DEFAULT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1YWlrYXFtYnVsZ3hwbGVhc29oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MTk3MTUsImV4cCI6MjA5OTE5NTcxNX0.JMCTx-VwhZj-h_5RhclD6OQQm94iLq7-6WdoTXE_SNs"

CATEGORIES = [
    "simple_bug", "mystery_bug", "feature", "refactor",
    "deep_reasoning", "research", "config_ops", "question",
]
DIFFICULTIES = ["하", "중", "상", "최상"]


def log(msg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass


def load_env():
    d = {}
    try:
        with open(ENV_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    for k in ("SUPABASE_URL", "SUPABASE_KEY"):
        if not d.get(k) and os.environ.get(k):
            d[k] = os.environ[k]
    # 최종 폴백: 내장 기본값(무설정 동작)
    d["SUPABASE_URL"] = d.get("SUPABASE_URL") or DEFAULT_URL
    d["SUPABASE_KEY"] = d.get("SUPABASE_KEY") or DEFAULT_KEY
    return d


# ---------- transcript 파싱 ----------
def blocks_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
        return "\n".join(out)
    return ""


def is_human_user(entry):
    if entry.get("type") != "user":
        return False
    c = entry.get("message", {}).get("content")
    if isinstance(c, str):
        return c.strip() != ""
    if isinstance(c, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in c)
    return False


def parse_transcript(path):
    """마지막 사람 프롬프트~응답 끝 구간에서 지표 추출."""
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if not isinstance(e, dict):
                continue
            if e.get("isSidechain"):
                continue
            entries.append(e)

    ui = -1
    for i in range(len(entries) - 1, -1, -1):
        if is_human_user(entries[i]):
            ui = i
            break
    if ui < 0:
        return None

    user_e = entries[ui]
    prompt = blocks_text(user_e.get("message", {}).get("content"))
    user_ts = user_e.get("timestamp")

    model = None
    input_tokens = 0
    output_tokens = 0
    tool_calls = 0
    resp_text_parts = []
    last_ts = user_ts
    usage_raw = {}

    for e in entries[ui + 1:]:
        if e.get("type") != "assistant":
            continue
        msg = e.get("message", {})
        model = msg.get("model", model)
        usage = msg.get("usage", {}) or {}
        if usage:
            usage_raw = usage
            ctx = (usage.get("input_tokens", 0)
                   + usage.get("cache_read_input_tokens", 0)
                   + usage.get("cache_creation_input_tokens", 0))
            if ctx:
                input_tokens = ctx
            output_tokens += usage.get("output_tokens", 0) or 0
        content = msg.get("content", [])
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict):
                    if b.get("type") == "tool_use":
                        tool_calls += 1
                    elif b.get("type") == "text":
                        resp_text_parts.append(b.get("text", ""))
        if e.get("timestamp"):
            last_ts = e["timestamp"]

    duration_ms = None
    try:
        t0 = datetime.fromisoformat(user_ts.replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
        duration_ms = int((t1 - t0).total_seconds() * 1000)
    except Exception:
        pass

    return {
        "prompt": prompt,
        "response": "\n".join(resp_text_parts),
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "tool_calls": tool_calls,
        "duration_ms": duration_ms,
        "usage_raw": usage_raw,
    }


# ---------- 로컬 규칙 기반 분류 (API/프록시 불필요, Claude Code + Codex 공용) ----------
CATEGORY_KEYWORDS = [
    ("mystery_bug", ["원인", "왜 안", "안되", "안 되", "재현", "간헐", "가끔", "이상하", "weird", "flaky", "race condition"]),
    ("simple_bug", ["버그", "오류", "에러", "error", "고쳐", "수정", "안됨", "깨졌", "깨짐", "exception", "null", "undefined", "typo", "오타", "fix", "bug"]),
    ("refactor", ["리팩", "refactor", "정리", "개선", "cleanup", "rename", "이름 바꿔", "구조 바꿔", "중복 제거"]),
    ("feature", ["추가", "구현", "만들", "기능", "feature", "implement", "새로", "붙여", "연동"]),
    ("config_ops", ["설정", "배포", "deploy", "config", "환경변수", "설치", "install", "빌드", "build", " ci ", "docker", "권한", "패키지"]),
    ("deep_reasoning", ["설계", "아키텍처", "architecture", "전략", "왜 이렇게", "trade-off", "고민", "접근법"]),
    ("research", ["조사", "분석", "알아봐", "찾아", "research", "investigate", "비교", "어떻게 동작", "파악"]),
    ("question", ["뭐", "어떻게", "알려", "what", "how", "why", "explain", "설명", "차이", "?"]),
]


def classify(prompt, response, metrics):
    text = (prompt or "").lower()
    cat = "unknown"
    for c, kws in CATEGORY_KEYWORDS:
        if any(k.lower() in text for k in kws):
            cat = c
            break

    tc = metrics.get("tool_calls", 0) or 0
    out = metrics.get("output_tokens", 0) or 0
    dur = metrics.get("duration_ms") or 0
    score = 0
    score += 2 if tc >= 20 else 1 if tc >= 8 else 0
    score += 2 if out >= 20000 else 1 if out >= 4000 else 0
    score += 1 if dur >= 300000 else 0
    if cat in ("mystery_bug", "deep_reasoning"):
        score += 1
    dif = "최상" if score >= 4 else "상" if score >= 3 else "중" if score >= 1 else "하"

    return {"category": cat, "difficulty": dif,
            "reason": f"heuristic tc={tc} out={out} dur={dur}"}


# ---------- Supabase insert ----------
def insert(env, row):
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_KEY")
    if not url or not key:
        log("no supabase config; skip insert")
        return
    endpoint = url.rstrip("/") + f"/rest/v1/{TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        req = urllib.request.Request(
            endpoint, data=json.dumps(row).encode(), headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            log(f"insert ok {r.status} cat={row.get('category')} dif={row.get('difficulty')} model={row.get('model')}")
    except urllib.error.HTTPError as ex:
        log(f"insert HTTPError {ex.code}: {ex.read().decode()[:300]}")
    except Exception as ex:
        log(f"insert error: {ex}")


# ---------- worker ----------
def run_worker(tmp):
    try:
        with open(tmp, encoding="utf-8") as f:
            hook = json.load(f)
    except Exception as ex:
        log(f"worker read fail: {ex}")
        return
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass

    env = load_env()
    tpath = hook.get("transcript_path")
    if not tpath or not os.path.exists(tpath):
        log(f"no transcript: {tpath}")
        return

    data = parse_transcript(tpath)
    if not data or not data.get("prompt"):
        log("no human prompt found")
        return

    cls = classify(data["prompt"], data["response"], data)
    cwd = hook.get("cwd", "")
    row = {
        "source": "claude-code",
        "session_id": hook.get("session_id"),
        "project": os.path.basename(cwd.rstrip("/\\")) if cwd else None,
        "model": data["model"],
        "category": cls["category"],
        "difficulty": cls["difficulty"],
        "input_tokens": data["input_tokens"],
        "output_tokens": data["output_tokens"],
        "tool_calls": data["tool_calls"],
        "duration_ms": data["duration_ms"],
        "raw": {"reason": cls.get("reason"), "usage": data["usage_raw"]},
    }
    insert(env, row)


def spawn_worker(hook):
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="metric_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(hook, f)
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED | NEW_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--worker", tmp], **kwargs
    )


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--worker":
        run_worker(sys.argv[2])
    else:
        try:
            hook = json.loads(sys.stdin.read() or "{}")
        except Exception:
            hook = {}
        try:
            spawn_worker(hook)
        except Exception as ex:
            log(f"spawn fail: {ex}")
    sys.exit(0)
