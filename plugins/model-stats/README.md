# model-stats

Claude Code + Codex 프롬프트 계측 플러그인. 매 턴을 **로컬 규칙**으로 종류/난이도 분류(무 API)해
Supabase에 집계. 회사·집 여러 머신 데이터를 한 곳에 모아 모델별 비교.

- 저장은 **통계만** — 프롬프트 본문 미저장.
- 분류: 키워드 규칙 + tool_calls/output_tokens/duration 점수. API/프록시 불필요.
- source로 `claude-code` / `codex` 구분.

## 설치

```
/plugin install model-stats@devez-marketplace
```

### 1. Supabase 준비 (최초 1회)
프로젝트 SQL Editor에 `schema.sql` 붙여 실행 (테이블 + RLS insert/select 정책).

### 2. 키 설정 (머신마다)
`scripts/.env.example`를 `~/.model-stats/.env`로 복사 후 채움:
```
SUPABASE_URL=https://<프로젝트>.supabase.co
SUPABASE_KEY=<anon 키>
```
환경변수 `SUPABASE_URL`/`SUPABASE_KEY`로 대체 가능. `MODEL_STATS_HOME`로 설정 폴더 위치 변경 가능.

### 3. Claude Code — 자동
플러그인 켜면 `hooks/hooks.json`의 Stop hook 자동 등록. 이후 매 턴 기록.

### 4. Codex — 수동 등록 (선택)
플러그인 hook은 Claude Code에만 붙음. Codex도 계측하려면 `~/.codex/hooks.json`의
`Stop` 배열에 아래 추가:
```json
{ "hooks": [ { "type": "command",
  "command": "python \"<플러그인경로>/scripts/codex_scan.py\"" } ] }
```
`<플러그인경로>` = 설치된 model-stats 폴더. Codex 종료 후 세션 rollout을 스캔해 신규 turn 기록.

## 조회
- `/model-stats` — 터미널 집계표 (source×model, 난이도 분포).
- 웹 대시보드는 별도 (anon select 정책 필요 — schema.sql 포함).

## 파일
| 경로 | 역할 |
|---|---|
| `hooks/hooks.json` | Claude Code Stop hook 등록 |
| `scripts/log_metric.py` | Claude 턴 파싱 + 분류 + insert (detached worker) |
| `scripts/codex_scan.py` | Codex rollout 스캔 + insert |
| `commands/model-stats.md` | `/model-stats` 집계 커맨드 |
| `schema.sql` | Supabase 테이블 + RLS |
| `DESIGN.md` | 확장 설계(스레드/재수정률 등, 미구현) |

## 요구
- `python` PATH에 있어야 함(stdlib만 사용, 추가 의존성 없음).
