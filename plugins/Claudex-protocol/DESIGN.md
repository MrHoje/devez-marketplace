# model-stats — 설계

codex vs claude 비교용 프롬프트 계측 플러그인. Claude Code hook으로 매 프롬프트를
분류(종류/난이도/도메인)하고, 재수정 횟수·주제 전환·모델 귀속·토큰/시간 등을 집계해
Supabase로 올려 회사·집 여러 머신 데이터를 한 곳에 모은다.

> codex는 **Claude Code 안의 MCP**로 연결(옵션 1). 사용자 프롬프트는 항상 메인 Claude가
> 받고, codex는 메인이 위임할 때만 툴로 실행 → 모델 귀속은 hook이 아니라 **턴 종료 후
> 툴콜 로그**로 판정한다.

---

## 1. 구성요소

| 파일 | 트리거 | 역할 |
|---|---|---|
| `scripts/classify.js` | `UserPromptSubmit` | 프롬프트 분류(haiku) + 스레드 매칭 + 이전 턴 해결여부 판정. pending 기록. |
| `scripts/finalize.js` | `Stop` | 방금 턴 transcript 파싱 → 모델 귀속 + 자동지표. turn/thread 확정 → 로컬 append + 업로드 킥. |
| `scripts/upload.js` | finalize가 백그라운드 호출 / `SessionEnd` | 미전송 레코드 Supabase upsert. |
| `scripts/reclassify.js` | 수동/배치 | 오프라인 등으로 미분류된 레코드 재분류(로컬 본문 사용). |
| `commands/model-stats.md` | `/model-stats` | Supabase 집계 뷰(모델별/난이도별 표). |
| `.claude-plugin/plugin.json` | — | 매니페스트. |
| `hooks/hooks.json` | — | hook 등록(`${CLAUDE_PLUGIN_ROOT}` 사용). |

---

## 2. 데이터 모델

### 로컬 (진실원본, append-only)
- `data/turns.jsonl` — 턴 단위 이벤트(불변). 프롬프트 본문은 **여기만**(업로드 X).
- `data/threads.json` — 스레드 상태(가변). 세션별 열린 스레드 + attempts + resolved.
- `data/pending/<session_id>.json` — classify가 쓰고 finalize가 소비하는 임시 인계.
- `data/config.local.json` — `machine_id`, 키(gitignore). repo에 절대 커밋 금지.

### Supabase (사본, 메타데이터만 — 본문 없음)

**turns** (append, `id` PK)
```
id uuid, ts timestamptz, machine_id text, session_id text,
thread_id text, attempt int, new_topic bool,
task_type text, difficulty text, domain text,
handled_by text,           -- claude | codex | mixed
tokens_out int, latency_ms int, tool_calls int, files_touched int
```

**threads** (upsert by `thread_id`, 가변 — 비교 핵심 지표)
```
thread_id text PK, machine_id text, session_id text,
task_type text, difficulty text, domain text,
handled_by text,           -- 스레드 전체 지배 모델
attempts int,              -- 재수정 횟수(= attempts-1)
resolved bool,             -- 최종 해결여부 (null=미정)
first_ts, last_ts timestamptz,
tokens_out_sum int, latency_ms_sum int
```

업로드는 **메타만**. `prompt_text`는 로컬 `turns.jsonl`에만 남긴다(재분류·감사용).

---

## 3. 분류 (classify.js, haiku)

입력 stdin(Claude Code 제공): `{ session_id, transcript_path, cwd, prompt }`.

1. `prompt` 앞 500자 컷.
2. 아주 짧은 이어짐("계속","ㅇㅇ","그리고?") → haiku 스킵, 직전 스레드 유지(규칙 앞단 컷).
3. `threads.json`에서 이 세션의 **열린 스레드 요약 1줄씩** 로드.
4. haiku 1회 호출 → JSON:
```json
{
  "task_type": "bug_fix|new_feature|deep_reasoning|refactor|question|other",
  "difficulty": "high|mid|low",
  "domain": "frontend|backend|infra|db|test|docs|other",
  "thread_match": "<열린 thread_id 또는 null>",
  "new_topic": true,
  "prev_thread_resolved": "true|false|unknown"
}
```
5. 스레드 상태 갱신:
   - `thread_match` 있으면 그 스레드 `attempts++` (재수정), `new_topic=false`.
   - 없으면 새 `thread_id`(uuid) 생성, `attempts=1`.
   - `prev_thread_resolved`로 **직전 열린 스레드**의 `resolved` 확정.
6. pending 기록: `{ id, ts, session_id, thread_id, attempt, new_topic,
   task_type, difficulty, domain, prompt_text }` → `pending/<session_id>.json`.

### 난이도 기준 (few-shot으로 haiku에 심음)
- **low**: 오타/문구/단순 설정값/한 줄 수정/자명한 질문.
- **mid**: 함수 단위 구현·수정, 다중 파일이나 패턴 명확, 일반 버그.
- **high**: 아키텍처 결정, 원인 불명 버그(디버깅 필요), 알고리즘/동시성, 대규모 리팩터, 깊은 추론.

### 블로킹
classify는 **동기**로 haiku 왕복(~300ms) 후 exit 0 (stdout 비움 — 컨텍스트 오염 금지).
pending 순서 보장 목적. 네트워크 업로드만 finalize에서 백그라운드로 뺀다.
오프라인이면 `task_type:"unclassified"`, `needs_reclassify:true`로 기록하고 넘어감.

---

## 4. 확정 (finalize.js, Stop hook)

입력 stdin: `{ session_id, transcript_path, stop_hook_active }`.

1. `pending/<session_id>.json` 로드(없으면 종료).
2. `transcript_path` JSONL에서 **방금 턴** 파싱:
   - `handled_by`: codex MCP 툴콜(`mcp__codex__*`) 있으면 `codex`, Claude 자체 편집만 있으면 `claude`, 둘 다면 `mixed`.
   - `tokens_out`: assistant 메시지 `usage.output_tokens` 합.
   - `latency_ms`: user 턴 ts → 마지막 assistant ts.
   - `tool_calls`: tool_use 개수.
   - `files_touched`: Edit/Write/MultiEdit distinct 경로 수(주의: codex 내부 편집은 안 잡힘 → 한계 명시).
3. 병합 → `turns.jsonl` append(`uploaded:false`).
4. `threads.json`의 해당 스레드 집계 갱신(tokens/latency 합, handled_by 지배값).
5. `upload.js` 백그라운드 fork(비블로킹).
6. `pending` 삭제.

---

## 5. 스레드 / 주제전환 / 해결 판정

- **주제 전환** = classify가 `new_topic:true` + 새 `thread_id` 발급하는 순간.
- **재수정 횟수** = `thread.attempts - 1` (결정적, haiku 추정 아님).
- **resolved**:
  - 같은 스레드 재프롬프트 → 직전 턴 미해결(재시도 필요).
  - 새 주제인데 직전 스레드 성공 신호 없음 → 직전 스레드 `resolved=false`(포기 전환).
  - 성공 신호("됐다/해결/좋아") → `resolved=true`.
  - 세션 종료 시 열린 스레드 → 마지막 신호로 마감, 애매하면 `null`.
- **주제 복귀** = 닫힌 thread_id 재등장(= "아까 그거 아직 안 됨").

---

## 6. 집계 (SQL, /model-stats)

핵심 비교 지표(threads 기준):
| 지표 | SQL 개요 |
|---|---|
| 1턴 해결률 | `avg(attempts=1 AND resolved)` group by handled_by |
| 평균 재수정 | `avg(attempts-1)` group by handled_by |
| 난이도별 성공률 | group by handled_by, difficulty → `avg(resolved)` |
| task_type별 강점 | group by handled_by, task_type → `avg(resolved)` |
| 가성비 | `sum(tokens)/count(resolved)` group by handled_by |
| 위임률 | codex/mixed thread 비율 |

---

## 7. 시크릿 / 설정

- `ANTHROPIC_API_KEY`(haiku), `SUPABASE_URL`, `SUPABASE_ANON_KEY`(또는 service key) — **환경변수 우선**,
  없으면 `data/config.local.json`(gitignore). repo·hooks.json·scripts에 하드코딩 금지.
- `machine_id`(office/home) — `config.local.json`에 머신마다 1회 설정.
- `.gitignore`: `data/config.local.json`, `data/turns.jsonl`, `data/threads.json`, `data/pending/`.

---

## 8. 오프라인 내성

- 로컬 `turns.jsonl` = 진실원본. Supabase는 사본.
- classify haiku 실패 → `unclassified` + `needs_reclassify` 플래그(본문 로컬 보존).
- 업로드 실패 → `uploaded:false` 유지, 다음 기회 재시도. upsert `id`라 중복 무해.
- `reclassify.js`가 미분류/미전송 로컬 레코드 훑어 재처리.

---

## 9. 크로스플랫폼 / 배포

- hook `command`는 전부 `node ${CLAUDE_PLUGIN_ROOT}/scripts/*.js` (win/mac 공통). 셸스크립트 금지.
- `marketplace.json`에 `model-stats` 항목 추가 → `/plugin install model-stats@devez-marketplace`.
- 플러그인 끄면 hook 미등록(다음 세션부터) → 비용 0, 데이터 보존.

---

## 10. 열린 리스크

- **codex 내부 편집 불가시성**: files_touched 등 codex 실작업 상세는 transcript에 안 남을 수 있음. 귀속(handled_by)까지만 신뢰, 파일수는 참고치.
- **비교 공정성**: 실사용 로그라 A/B 아님(쉬운 건 claude, 어려운 건 codex 편향 가능). `difficulty` 층화로 보정.
- **resolved 지연**: 다음 프롬프트/세션종료로 소급 확정 → 실시간 값엔 `null` 존재.
- **classify 300ms 블로킹**: 매 프롬프트 지연 감수. 거슬리면 detached+race-guard로 전환.

---

## 빌드 순서(제안)

1. 스캐폴드(plugin.json, hooks.json, .gitignore, config 샘플).
2. classify.js (분류 + 스레드) — 로컬만, Supabase 전.
3. finalize.js (귀속 + 자동지표) — transcript 파서.
4. upload.js + Supabase 스키마(SQL).
5. /model-stats 뷰.
6. marketplace.json 등록 → 회사/집 설치 검증.
