#!/usr/bin/env python
"""Claude Code Stop hook: 프롬프트 분류 + Supabase 기록.
분류는 CF Worker(DeepSeek 대행, 유료키 서버측 보관)로 처리 → 실패 시 로컬 규칙 폴백.
의존성 없음(stdlib urllib/json). 비동기: hook은 worker를 detach 후 즉시 종료(블로킹 X).
런타임 설정/로그/상태는 repo 밖 ~/.model-stats/ 에 둠 (실키가 플러그인 repo에 안 실림).
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

# Windows: hook 실행 시 뜨는 콘솔 창 즉시 숨김(스크립트로 직접 실행될 때만).
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

CONFIG_DIR = os.environ.get("MODEL_STATS_HOME") or os.path.join(os.path.expanduser("~"), ".model-stats")
ENV_PATH = os.path.join(CONFIG_DIR, ".env")
LOG_PATH = os.path.join(CONFIG_DIR, "metric.log")

TABLE = "model_metrics"
HOOK_VERSION = "0.3.21"
SCHEMA_VERSION = "2.0"
PRICING_VERSION = "2026-07-11"

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


def normalize_effort(value):
    """Return the telemetry contract value without inventing an effort cohort."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace("-", "").replace("_", "")
    aliases = {
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "extrahigh": "xhigh",
        "max": "xhigh",
    }
    return aliases.get(normalized)


def read_claude_effort(hook):
    """Resolve Claude Code effort using runtime values before persisted settings."""
    for key in ("effort", "effort_level", "effortLevel"):
        effort = normalize_effort(hook.get(key))
        if effort:
            return effort

    effort = normalize_effort(os.environ.get("CLAUDE_CODE_EFFORT_LEVEL"))
    if effort:
        return effort

    cwd = hook.get("cwd") or ""
    candidates = []
    if cwd:
        candidates.extend([
            os.path.join(cwd, ".claude", "settings.local.json"),
            os.path.join(cwd, ".claude", "settings.json"),
        ])
    candidates.extend([
        os.path.join(os.path.expanduser("~"), ".claude", "settings.local.json"),
        os.path.join(os.path.expanduser("~"), ".claude", "settings.json"),
    ])
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as settings_file:
                effort = normalize_effort(json.load(settings_file).get("effortLevel"))
            if effort:
                return effort
        except (OSError, ValueError, AttributeError):
            continue
    return None


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
INTERRUPT_MARK = "[Request interrupted by user]"  # 사용자가 응답 중단 시 다음 user 항목에 삽입

# 다음 턴이 직전 턴을 재작업/부정하는 신호(성과 self-report 교차검증). 원본 outcome은 보존.
REWORK_KEYWORDS = [
    "다시", "again", "안 돼", "안돼", "안됨", "안 됨", "안 된", "안된",
    "틀렸", "틀림", "틀리", "왜 안", "왜안", "아직도", "여전히", "still",
    "안 고쳐", "못 고쳐", "안고쳐", "되돌려", "revert", "롤백", "rollback",
    "원래대로", "그게 아니", "안 바뀌", "안바뀌", "doesn't work", "not work",
    "그대로야", "그대로네", "여전", "실패했", "에러 나", "오류 나",
]


def is_rework(prompt):
    """다음 턴 프롬프트가 직전 턴 결과에 대한 재작업/불만 신호인가."""
    text = (prompt or "").lower()
    return any(k in text for k in REWORK_KEYWORDS)


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
        s = c.strip()
        return s != "" and INTERRUPT_MARK not in s  # interrupt 마커는 실제 프롬프트 아님
    if isinstance(c, list):
        txts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
        return any(t.strip() and INTERRUPT_MARK not in t for t in txts)
    return False


def _ms_between(a, b):
    try:
        t0 = datetime.fromisoformat((a or "").replace("Z", "+00:00"))
        t1 = datetime.fromisoformat((b or "").replace("Z", "+00:00"))
        return int((t1 - t0).total_seconds() * 1000)
    except Exception:
        return None


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
    prompt_id = user_e.get("promptId")  # 서브에이전트 턴 귀속 키

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
    interrupted = False   # 사용자가 이 턴 응답을 중단했는가(불만족/오작동 신호)
    thinking_blocks = 0   # thinking 블록 수(내용은 transcript에 redacted라 길이/토큰 측정 불가)
    edit_events = 0       # 편집 tool_use 총 횟수(재편집 계산용)
    cache_read = 0        # 캐시 히트 토큰 총합
    cache_write = 0       # 캐시 생성 토큰 총합
    active_ms = 0         # 순수 모델 생성시간(직전 항목~assistant 간격 합; 도구/승인 대기 제외)
    prev_ts = user_ts
    usage_by_id = {}      # message.id별 최종 usage(분할/스트리밍 스냅샷 중복 → 마지막이 최종값). 루프 후 합산

    for e in entries[ui + 1:]:
        ets = e.get("timestamp")
        if e.get("type") == "user":
            # 응답 중간에 낀 interrupt 마커 감지(다음 실제 프롬프트 전까지)
            cc = e.get("message", {}).get("content")
            s = cc if isinstance(cc, str) else (
                " ".join(b.get("text", "") for b in cc if isinstance(b, dict) and b.get("type") == "text")
                if isinstance(cc, list) else "")
            if INTERRUPT_MARK in s:
                interrupted = True
            if ets:
                prev_ts = ets  # tool_result 등도 다음 생성시간 기준점
            continue
        if e.get("type") != "assistant":
            if ets:
                prev_ts = ets
            continue
        msg = e.get("message", {})
        model = msg.get("model", model)
        mid = msg.get("id")
        usage = msg.get("usage", {}) or {}
        if usage:
            # 같은 id의 분할/스트리밍 항목은 마지막(최종) usage로 덮어씀 → id당 1회만 반영
            usage_by_id[mid if mid is not None else id(e)] = (usage, model)
        content = msg.get("content", [])
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict):
                    if b.get("type") == "tool_use":
                        tool_calls += 1
                        name = b.get("name")
                        if name in EDIT_TOOLS:
                            edit_events += 1
                        f, ln = _code_metric(name, b.get("input") or {})
                        if f:
                            edited_files.add(f)
                        code_lines += ln
                    elif b.get("type") == "text":
                        resp_text_parts.append(b.get("text", ""))
                    elif b.get("type") == "thinking":
                        thinking_blocks += 1
        if ets:
            d = _ms_between(prev_ts, ets)
            if d and d > 0:
                active_ms += d
            last_ts = ets
            prev_ts = ets

    for _u, _m in usage_by_id.values():
        usage_raw = _u
        _ctx = (_u.get("input_tokens", 0)
                + _u.get("cache_read_input_tokens", 0)
                + _u.get("cache_creation_input_tokens", 0))
        if _ctx:
            input_tokens = _ctx  # 마지막 응답의 컨텍스트 크기
        output_tokens += _u.get("output_tokens", 0) or 0
        cache_read += _u.get("cache_read_input_tokens", 0) or 0
        cache_write += _u.get("cache_creation_input_tokens", 0) or 0
        cost_usd += cost_claude(_u, _m)

    duration_ms = _ms_between(user_ts, last_ts)

    return {
        "prompt": prompt,
        "response": "\n".join(resp_text_parts),
        "user_ts": user_ts,  # 턴 멱등키(같은 프롬프트 턴 재기록 방지)
        "prompt_id": prompt_id,  # 서브에이전트 파일 promptId 매칭용
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "tool_calls": tool_calls,
        "duration_ms": duration_ms,
        "usage_raw": usage_raw,
        "cost_usd": round(cost_usd, 6),
        "code_files": len(edited_files),
        "code_lines": code_lines,
        "_edited": edited_files,  # 서브와 합집합 계산용(직렬화 전 제거)
        "reasoning_tokens": 0,
        "interrupted": interrupted,
        "thinking_blocks": thinking_blocks,
        "edit_events": edit_events,
        "re_edits": max(0, edit_events - len(edited_files)),  # 같은 파일 반복 편집 = 시행착오 신호
        "cache_read": cache_read,
        "cache_write": cache_write,
        "active_ms": active_ms,
    }


def parse_subagents(transcript_path, prompt_id):
    """이 턴(prompt_id)에 속한 서브에이전트 transcript를 모델별로 정확히 합산.
    최신 구조: <project>/<session>.jsonl + <project>/<session>/subagents/agent-*.jsonl
    서브 파일의 promptId == 메인 사람턴 promptId 인 파일만 귀속(정확 매칭)."""
    agg = {"output_tokens": 0, "tool_calls": 0, "cost_usd": 0.0,
           "code_lines": 0, "input_tokens": 0, "count": 0,
           "_edited": set(), "breakdown": []}
    if not prompt_id or not transcript_path:
        return agg
    subdir = os.path.join(os.path.splitext(transcript_path)[0], "subagents")
    if not os.path.isdir(subdir):
        return agg
    for p in sorted(glob.glob(os.path.join(subdir, "*.jsonl"))):
        pid = None
        model = None
        out = 0
        tc = 0
        cost = 0.0
        lines = 0
        inp = 0
        files = set()
        usage_by_id = {}  # message.id별 최종 usage(분할/스트리밍 중복 방지)
        try:
            with open(p, encoding="utf-8") as f:
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
                    if pid is None:
                        pid = e.get("promptId")
                    if e.get("type") != "assistant":
                        continue
                    msg = e.get("message", {})
                    model = msg.get("model", model)
                    mid = msg.get("id")
                    usage = msg.get("usage", {}) or {}
                    if usage:
                        usage_by_id[mid if mid is not None else id(e)] = (usage, model)
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict) and b.get("type") == "tool_use":
                                tc += 1
                                ff, ln = _code_metric(b.get("name"), b.get("input") or {})
                                if ff:
                                    files.add(ff)
                                lines += ln
        except Exception as ex:
            log(f"subagent read fail {os.path.basename(p)}: {ex}")
            continue
        for _u, _m in usage_by_id.values():  # id당 최종 usage만 합산
            out += _u.get("output_tokens", 0) or 0
            cost += cost_claude(_u, _m)
            _ctx = (_u.get("input_tokens", 0)
                    + _u.get("cache_read_input_tokens", 0)
                    + _u.get("cache_creation_input_tokens", 0))
            if _ctx:
                inp = _ctx
        if pid != prompt_id:  # 다른 턴에서 생성된 서브에이전트 → 제외
            continue
        agg["output_tokens"] += out
        agg["tool_calls"] += tc
        agg["cost_usd"] += cost
        agg["code_lines"] += lines
        agg["input_tokens"] += inp
        agg["_edited"] |= files
        agg["count"] += 1
        agg["breakdown"].append({
            "agentId": os.path.basename(p)[len("agent-"):-len(".jsonl")]
                       if os.path.basename(p).startswith("agent-") else os.path.basename(p),
            "model": model, "output_tokens": out, "tool_calls": tc,
            "cost_usd": round(cost, 6),
        })
    return agg


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
def prepare_contract_row(row):
    """Populate contract fields that are measured or deterministically derived."""
    raw = row.get("raw") if isinstance(row.get("raw"), dict) else {}
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}

    if row.get("cached_input_tokens") is None:
        cached = usage.get("cached_input_tokens")
        if cached is None:
            cached = usage.get("cache_read_input_tokens")
        if cached is not None:
            row["cached_input_tokens"] = cached
    if row.get("cache_creation_input_tokens") is None:
        cache_creation = usage.get("cache_creation_input_tokens")
        if cache_creation is not None:
            row["cache_creation_input_tokens"] = cache_creation

    # These parsers inspect the full turn, so absence is a measured zero.
    for field in ("tool_calls", "code_files", "code_lines"):
        if row.get(field) is None:
            row[field] = 0

    row.setdefault("schema_version", SCHEMA_VERSION)
    row.setdefault("hook_version", HOOK_VERSION)
    row.setdefault("os", "windows" if os.name == "nt" else os.name)
    row.setdefault("collection_status", "partial" if row.get("outcome_signal") == "interrupted" else "complete")
    if row.get("cost_usd") is not None:
        row.setdefault("pricing_version", PRICING_VERSION)

    if not row.get("occurred_at"):
        row["occurred_at"] = row.get("created_at") or datetime.now(timezone.utc).isoformat()
    if not row.get("conversation_id") and row.get("session_id"):
        row["conversation_id"] = row["session_id"]

    turn_key = raw.get("turn")
    if turn_key is None:
        turn_key = raw.get("user_ts")
    if turn_key is not None and row.get("session_id"):
        stable_turn_id = f"{row['session_id']}:{turn_key}"
        row.setdefault("turn_id", stable_turn_id)
        row.setdefault("event_id", stable_turn_id)
        if isinstance(turn_key, int):
            row.setdefault("sequence_no", turn_key)
    return row


def insert(env, row):
    row = prepare_contract_row(row)
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
        if ex.code == 409:  # unique 충돌 = 이미 기록된 turn(중복 방어선 작동)
            log(f"insert dup skipped: {row.get('session_id')} turn={ (row.get('raw') or {}).get('turn') }")
        else:
            log(f"insert HTTPError {ex.code}: {ex.read().decode()[:300]}")
    except Exception as ex:
        log(f"insert error: {ex}")


def patch_signal(env, sid, user_ts, signal):
    """직전 턴(session_id+raw.user_ts) 행에 outcome_signal 소급 기록.
    이미 값이 있으면(interrupted 등) 덮지 않음(outcome_signal=is.null 조건)."""
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_KEY")
    if not url or not key or not sid or not user_ts:
        return
    endpoint = (url.rstrip("/") + f"/rest/v1/{TABLE}"
                + "?session_id=eq." + urllib.parse.quote(str(sid), safe="")
                + "&raw->>user_ts=eq." + urllib.parse.quote(str(user_ts), safe="")
                + "&outcome_signal=is.null")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        req = urllib.request.Request(
            endpoint, data=json.dumps({"outcome_signal": signal}).encode(),
            headers=headers, method="PATCH")
        with urllib.request.urlopen(req, timeout=30) as r:
            log(f"patch signal ok {r.status} {sid} {user_ts} -> {signal}")
    except Exception as ex:
        log(f"patch signal error: {ex}")


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

    # 멱등: 같은 세션의 같은 프롬프트 턴(user_ts)은 한 번만 기록
    # (인터럽트 후 재개, 세션 재개 등으로 Stop이 같은 턴에 재발화하는 경우 방어)
    sid = hook.get("session_id")
    state_path = os.path.join(CONFIG_DIR, "claude_state.json")
    state = {}
    try:
        state = json.load(open(state_path, encoding="utf-8"))
    except Exception:
        pass
    prev = state.get(sid)
    prev_ts = prev.get("user_ts") if isinstance(prev, dict) else prev  # 하위호환(구버전 문자열)
    if sid and data.get("user_ts") and prev_ts == data["user_ts"]:
        log(f"skip already-logged turn: {sid} {data['user_ts']}")
        return

    # 직전 턴 소급 보정: 현재 프롬프트가 직전 턴 결과에 대한 재작업/불만 신호면 표시
    if isinstance(prev, dict) and prev.get("user_ts") and is_rework(data["prompt"]):
        patch_signal(env, sid, prev["user_ts"], "reworked")

    # 서브에이전트(사이드체인) 정확 합산: 같은 promptId 파일만 귀속, 모델별 비용.
    # classify 전에 합산 → 난이도(작업량 기반)에도 서브 작업량이 반영됨.
    sub = parse_subagents(tpath, data.get("prompt_id"))
    if sub["count"]:
        data["output_tokens"] += sub["output_tokens"]
        data["tool_calls"] += sub["tool_calls"]
        data["cost_usd"] = round(data["cost_usd"] + sub["cost_usd"], 6)
        data["code_lines"] += sub["code_lines"]
        data["code_files"] = len(data.get("_edited", set()) | sub["_edited"])
        log(f"subagents merged: n={sub['count']} +out={sub['output_tokens']} "
            f"+tc={sub['tool_calls']} +cost={round(sub['cost_usd'], 6)}")

    cls = classify(data["prompt"], data["response"], data, env)
    cwd = hook.get("cwd", "")
    row = {
        "source": "claude-code",
        "session_id": hook.get("session_id"),
        "project": os.path.basename(cwd.rstrip("/\\")) if cwd else None,
        "model": data["model"],
        "effort": read_claude_effort(hook),
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
        "outcome_signal": ("interrupted" if data.get("interrupted") else None),  # reworked는 다음 턴 소급
        "raw": {"reason": cls.get("reason"), "usage": data["usage_raw"], "user_ts": data.get("user_ts"),
                "subagents": sub["breakdown"], "subagent_input_tokens": sub["input_tokens"],
                "quality": {
                    "interrupted": data.get("interrupted"),
                    "re_edits": data.get("re_edits"),
                    "edit_events": data.get("edit_events"),
                    "thinking_blocks": data.get("thinking_blocks"),
                    "cache_read": data.get("cache_read"),
                    "cache_write": data.get("cache_write"),
                    "active_ms": data.get("active_ms"),
                }},
    }
    insert(env, row)
    if sid and data.get("user_ts"):
        state[sid] = {"user_ts": data["user_ts"]}  # 다음 턴 소급 보정 기준
        try:
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception:
            pass


def real_pyw():
    """워커용 인터프리터. venv 셔틀(pythonw 간판, 실제 python.exe 콘솔) 우회해
    실제 바이너리 옆의 진짜 pythonw.exe를 직접 사용 — 콘솔창 생성 원천 차단."""
    exe = sys.executable
    try:
        if os.name == "nt":
            import ctypes
            b = ctypes.create_unicode_buffer(512)
            ctypes.windll.kernel32.GetModuleFileNameW(None, b, 512)
            real = b.value or exe
            cand = os.path.join(os.path.dirname(real), "pythonw.exe")
            if os.path.exists(cand):
                return cand
    except Exception:
        pass
    return exe


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
        # NO_WINDOW만 사용(DETACHED와 조합하면 NO_WINDOW가 무시돼 손자 콘솔앱이 새 창 띄움).
        # NO_WINDOW의 숨김 콘솔을 자식 체인이 상속 → 어떤 단계도 창 안 뜸.
        kwargs["creationflags"] = 0x08000000 | 0x00000200  # NO_WINDOW | NEW_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(
        [real_pyw(), "-X", "utf8", os.path.abspath(__file__), "--worker", tmp], **kwargs
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
