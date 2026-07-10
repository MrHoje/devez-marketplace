#!/usr/bin/env python
"""Claude Code Stop hook: 프롬프트 분류 + Supabase 기록.
분류는 CF Worker(DeepSeek 대행, 유료키 서버측 보관)로 처리 → 실패 시 로컬 규칙 폴백.
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

# Windows: hook 실행 시 뜨는 콘솔 창 즉시 숨김(스크립트로 직접 실행될 때만).
if os.name == "nt" and __name__ == "__main__":
    try:
        import ctypes
        _w = ctypes.windll.kernel32.GetConsoleWindow()
        if _w:
            ctypes.windll.user32.ShowWindow(_w, 0)  # SW_HIDE
    except Exception:
        pass

CONFIG_DIR = os.environ.get("MODEL_STATS_HOME") or os.path.join(os.path.expanduser("~"), ".model-stats")
ENV_PATH = os.path.join(CONFIG_DIR, ".env")
LOG_PATH = os.path.join(CONFIG_DIR, "metric.log")

TABLE = "model_metrics"

# 무설정 동작용 기본값(anon 키 = insert/select 전용, 통계만 — 프롬프트 본문 미저장).
# ~/.model-stats/.env 나 환경변수(SUPABASE_URL/SUPABASE_KEY)로 덮어쓰기 가능.
DEFAULT_URL = "https://juaikaqmbulgxpleasoh.supabase.co"
DEFAULT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1YWlrYXFtYnVsZ3hwbGVhc29oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MTk3MTUsImV4cCI6MjA5OTE5NTcxNX0.JMCTx-VwhZj-h_5RhclD6OQQm94iLq7-6WdoTXE_SNs"

# 분류 대행 CF Worker(DeepSeek 키는 Worker 시크릿에만 존재). URL/토큰은 비밀 아님.
DEFAULT_WORKER_URL = "https://model-stats-classify.fng15.workers.dev"
DEFAULT_WORKER_TOKEN = "ms_9f2c7a1e4b8d3056f1a2c9e7d4b60831"

CATEGORIES = [
    "simple_bug", "mystery_bug", "feature", "refactor",
    "deep_reasoning", "research", "config_ops", "question",
]
DIFFICULTIES = ["하", "중", "상", "최상"]
DOMAINS = ["frontend", "backend", "database", "devops", "infra", "data", "mobile", "other"]
OUTCOMES = ["success", "partial", "fail", "na"]

# 모델 단가 (USD / 1M tokens): (input, output). cache_read=input*0.1, cache_write=input*1.25
PRICING = {
    "opus": (15.0, 75.0),
    "sonnet": (3.0, 15.0),
    "haiku": (1.0, 5.0),
    "gpt-5.6-sol": (10.0, 30.0),
    "gpt-5.6-luna": (5.0, 15.0),
    "gpt-5.6": (10.0, 30.0),
    "gpt-5.4-mini": (0.6, 1.8),
    "mini": (0.6, 1.8),
    "gpt-5": (10.0, 30.0),
}
DEFAULT_PRICE = (5.0, 15.0)


def log(msg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass


def con_diag(tag):
    """진단: 이 프로세스에 콘솔창 있는지/보이는지 기록(깜빡임 범인 추적용)."""
    try:
        if os.name != "nt":
            return
        import ctypes
        h = ctypes.windll.kernel32.GetConsoleWindow()
        vis = ctypes.windll.user32.IsWindowVisible(h) if h else 0
        log(f"diag {tag} con={h} vis={vis} exe={os.path.basename(sys.executable)}")
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
    for k in ("SUPABASE_URL", "SUPABASE_KEY", "MODEL_STATS_WORKER_URL", "MODEL_STATS_WORKER_TOKEN"):
        if not d.get(k) and os.environ.get(k):
            d[k] = os.environ[k]
    d["SUPABASE_URL"] = d.get("SUPABASE_URL") or DEFAULT_URL
    d["SUPABASE_KEY"] = d.get("SUPABASE_KEY") or DEFAULT_KEY
    d["MODEL_STATS_WORKER_URL"] = d.get("MODEL_STATS_WORKER_URL") or DEFAULT_WORKER_URL
    d["MODEL_STATS_WORKER_TOKEN"] = d.get("MODEL_STATS_WORKER_TOKEN") or DEFAULT_WORKER_TOKEN
    return d


# ---------- 비용 ----------
def price_for(model):
    m = (model or "").lower()
    for k, v in PRICING.items():
        if k in m:
            return v
    return DEFAULT_PRICE


def cost_claude(usage, model):
    pin, pout = price_for(model)
    inp = usage.get("input_tokens", 0) or 0
    cr = usage.get("cache_read_input_tokens", 0) or 0
    cw = usage.get("cache_creation_input_tokens", 0) or 0
    outp = usage.get("output_tokens", 0) or 0
    return (inp * pin + cr * pin * 0.1 + cw * pin * 1.25 + outp * pout) / 1e6


def cost_codex(usage, model):
    pin, pout = price_for(model)
    total_in = usage.get("input_tokens", 0) or 0
    cached = usage.get("cached_input_tokens", 0) or 0
    noncached = max(0, total_in - cached)
    outp = usage.get("output_tokens", 0) or 0
    return (noncached * pin + cached * pin * 0.1 + outp * pout) / 1e6


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


EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Update"}


def _code_metric(name, inp):
    if name not in EDIT_TOOLS:
        return None, 0
    path = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
    lines = 0
    if "content" in inp and isinstance(inp["content"], str):
        lines = inp["content"].count("\n") + 1
    elif "new_string" in inp and isinstance(inp["new_string"], str):
        lines = inp["new_string"].count("\n") + 1
    elif isinstance(inp.get("edits"), list):
        for ed in inp["edits"]:
            s = ed.get("new_string", "") if isinstance(ed, dict) else ""
            lines += s.count("\n") + 1
    return path, lines


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
    cost_usd = 0.0
    edited_files = set()
    code_lines = 0

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
            cost_usd += cost_claude(usage, model)
        content = msg.get("content", [])
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict):
                    if b.get("type") == "tool_use":
                        tool_calls += 1
                        f, ln = _code_metric(b.get("name"), b.get("input") or {})
                        if f:
                            edited_files.add(f)
                        code_lines += ln
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
        "cost_usd": round(cost_usd, 6),
        "code_files": len(edited_files),
        "code_lines": code_lines,
        "reasoning_tokens": 0,
    }


# ---------- 분류: CF Worker(DeepSeek 대행) 우선, 실패 시 로컬 규칙 ----------
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


def _classify_rule(prompt):
    text = (prompt or "").lower()
    for c, kws in CATEGORY_KEYWORDS:
        if any(k.lower() in text for k in kws):
            return c
    return "unknown"


def _judge_worker(prompt, response, env):
    """CF Worker에 분류 요청 → {category,difficulty_llm,domain,outcome}. 실패 시 None."""
    if not (prompt or "").strip():
        return None
    url = env.get("MODEL_STATS_WORKER_URL")
    token = env.get("MODEL_STATS_WORKER_TOKEN")
    if not url or not token:
        return None
    body = {"prompt": (prompt or "")[:1500], "response": (response or "")[:1500]}
    try:
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {token}",
                     "User-Agent": "model-stats/0.3"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode())
        cat = j.get("category") if j.get("category") in CATEGORIES else None
        if not cat:
            return None
        return {
            "category": cat,
            "difficulty_llm": j.get("difficulty") if j.get("difficulty") in DIFFICULTIES else None,
            "domain": j.get("domain") if j.get("domain") in DOMAINS else None,
            "outcome": j.get("outcome") if j.get("outcome") in OUTCOMES else None,
        }
    except Exception as ex:
        log(f"worker judge fail: {ex}")
        return None


def _workload_difficulty(metrics, category):
    tc = metrics.get("tool_calls", 0) or 0
    out = metrics.get("output_tokens", 0) or 0
    dur = metrics.get("duration_ms") or 0
    score = 0
    score += 2 if tc >= 20 else 1 if tc >= 8 else 0
    score += 2 if out >= 20000 else 1 if out >= 4000 else 0
    score += 1 if dur >= 300000 else 0
    if category in ("mystery_bug", "deep_reasoning"):
        score += 1
    return "최상" if score >= 4 else "상" if score >= 3 else "중" if score >= 1 else "하"


def classify(prompt, response, metrics, env=None):
    env = env or load_env()
    j = _judge_worker(prompt, response, env)
    if j:
        cat = j["category"]
        dif_llm = j.get("difficulty_llm")
        domain = j.get("domain")
        outcome = j.get("outcome")
        src = "worker"
    else:
        cat = _classify_rule(prompt)
        dif_llm = None
        domain = None
        outcome = None
        src = "rule"

    dif = _workload_difficulty(metrics, cat)
    tc = metrics.get("tool_calls", 0) or 0
    out = metrics.get("output_tokens", 0) or 0
    dur = metrics.get("duration_ms") or 0
    return {
        "category": cat,
        "difficulty": dif,
        "difficulty_llm": dif_llm,
        "domain": domain,
        "outcome": outcome,
        "reason": f"{src} tc={tc} out={out} dur={dur}",
    }


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


# ---------- worker(detached) ----------
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

    cls = classify(data["prompt"], data["response"], data, env)
    cwd = hook.get("cwd", "")
    row = {
        "source": "claude-code",
        "session_id": hook.get("session_id"),
        "project": os.path.basename(cwd.rstrip("/\\")) if cwd else None,
        "model": data["model"],
        "category": cls["category"],
        "difficulty": cls["difficulty"],
        "difficulty_llm": cls.get("difficulty_llm"),
        "domain": cls.get("domain"),
        "outcome": cls.get("outcome"),
        "input_tokens": data["input_tokens"],
        "output_tokens": data["output_tokens"],
        "tool_calls": data["tool_calls"],
        "duration_ms": data["duration_ms"],
        "cost_usd": data.get("cost_usd"),
        "code_files": data.get("code_files"),
        "code_lines": data.get("code_lines"),
        "reasoning_tokens": data.get("reasoning_tokens"),
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
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--worker", tmp], **kwargs
    )


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--worker":
        con_diag("lm-worker")
        run_worker(sys.argv[2])
    else:
        con_diag("lm-parent")
        try:
            hook = json.loads(sys.stdin.read() or "{}")
        except Exception:
            hook = {}
        try:
            spawn_worker(hook)
        except Exception as ex:
            log(f"spawn fail: {ex}")
    sys.exit(0)
