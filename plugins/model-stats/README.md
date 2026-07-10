# model-stats

Claude Code + Codex 프롬프트 계측 플러그인. 매 턴을 **로컬 규칙**으로 종류/난이도 분류(무 API)해
Supabase에 집계. 회사·집 여러 머신 데이터를 한 곳에 모아 모델별 비교.

- 저장은 **통계만** — 프롬프트 본문 미저장.
- 분류: 키워드 규칙 + tool_calls/output_tokens/duration 점수. API/프록시 불필요.
- source로 `claude-code` / `codex` 구분.

## 설치 — 사실상 원클릭

```
/plugin install model-stats@devez-marketplace
```

- **Claude Code**: 설치만으로 동작. Stop hook 자동 등록, Supabase URL/anon 키는 스크립트에 내장(무설정).
- **Codex**: Claude `SessionStart` hook이 `~/.codex/hooks.json`에 `codex_scan.py`를 자동 주입(멱등).
  Codex가 새 hook을 **최초 1회 신뢰 승인**만 요구함(보안상 불가피). 그 1번 승인하면 이후 자동.
- **Supabase 스키마**: 공유 프로젝트엔 이미 적용됨. 새 프로젝트 쓸 때만 `schema.sql` 1회 실행.

### 덮어쓰기(선택)
다른 Supabase/키 쓰려면 `~/.model-stats/.env` 생성(`scripts/.env.example` 참고) 또는
환경변수 `SUPABASE_URL`/`SUPABASE_KEY`. `MODEL_STATS_HOME`로 설정 폴더 위치 변경.

우선순위: `.env` > 환경변수 > 내장 기본값.

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
