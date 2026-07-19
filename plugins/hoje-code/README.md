# hoje-code

Claude Code에서 독립적으로 실행되는 요구사항 인터뷰, 합의 계획, 내구성 목표 실행 플러그인입니다. Gajae-Code의 최신 공개 워크플로우를 동기화 기준으로 삼지만 실행 엔진·상태·역할 에이전트는 모두 플러그인에 포함합니다.

## 포함 기능

| 공개 스킬 | 역할 |
|---|---|
| `/hoje-code:hoje-ask` | 모호성 점수 기반 심층 인터뷰와 명세 작성 |
| `/hoje-code:hoje-plan` | Planner → Architect → Critic 합의 계획 |
| `/hoje-code:hoje-goals` | 내구성 있는 멀티 골 실행과 품질 게이트 |

내부 헬퍼 스킬 5개와 역할 에이전트 `planner`, `architect`, `critic`, `executor`, `executor-qa`도 함께 번들됩니다. 사용자 전역 에이전트 설정에 의존하지 않습니다.

## 독립 런타임

- 엔진: Node.js 18 이상과 표준 라이브러리만 사용
- 상태: `.hoje/_session-{sessionid}/`
- 세션 환경변수: `HOJE_SESSION_ID`
- 런처: `bin/hoje`, `bin/hoje.ps1`, `bin/hoje.cmd`
- 외부 `gjc`, `@gajae-code/coding-agent`, Bun, tmux 불필요
- 원자적 상태 쓰기, SHA-256 상태 증명, hash-chain 감사 ledger, 세션 격리, 체크포인트 품질 게이트를 자체 구현

```sh
hoje runtime version
hoje runtime doctor
```

Hoje Ask의 모호성 임계치는 `HOJE_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD`, `HOJE_CONFIG_DIR/config.json`, 프로젝트 `.hoje/config.json` 순으로 해석하며 기본값은 `0.2`입니다. 설정 키는 `hoje.deepInterview.ambiguityThreshold`입니다.

## 실행 강도

| 모드 | 용도 | 검증 계약 |
|---|---|---|
| `--light` | 2개 이하 파일·200줄 미만의 저위험 로컬 변경 | 직접 구현/자체 리뷰 허용, compact gate |
| `--standard` | 기본값, 일반 기능·다중 파일 작업 | 독립 Architect + Executor QA gate |
| `--strict` | 보안·결제·마이그레이션·호환성 등 고위험 작업 | 전체 독립 검토와 확대된 회귀/적대 테스트 |

작업 범위나 위험도가 커지면 실행 중 상위 모드로 승격합니다. 어떤 모드도 증거, 전체 재실행, 빈 blocker, durable receipt 요건은 생략하지 않습니다.

## 권장 파이프라인

```text
/hoje-code:hoje-ask "아이디어"
  → /hoje-code:hoje-plan
  → /hoje-code:hoje-goals [--light|--standard|--strict]
```

병렬 작업은 Claude Code의 번들 Agent 역할로 처리하므로 별도 Team/tmux 런타임이 필요 없습니다.

## 최신화와 검증

```sh
node scripts/sync-gajae.mjs --check-only
node scripts/sync-gajae.mjs --verify
claude plugin validate --strict plugins/hoje-code
```

동기화 스크립트는 npm 최신 버전에 대응하는 Git 태그에서 원본 8개 워크플로우 문서를 읽고 Hoje 네이티브 계약을 결정적으로 적용합니다. 현재 동기화 기준은 Gajae-Code v0.11.3이며, 이는 소스 비교 기준일 뿐 실행 의존성이 아닙니다.

## 원본 매핑

| hoje-code | Gajae-Code v0.11.3 |
|---|---|
| `hoje-ask` | `skills/deep-interview/SKILL.md` |
| `hoje-plan` | `skills/ralplan/SKILL.md` |
| `hoje-goals` | `skills/ultragoal/SKILL.md` |
| `hoje-ask-auto-answer` | `skills/deep-interview/auto-answer-uncertain.md` |
| `hoje-ask-greenfield` | `skills/deep-interview/auto-research-greenfield.md` |
| `hoje-ask-panel` | `skills/deep-interview/lateral-review-panel.md` |
| `hoje-goals-slop-cleaner` | `skills/ultragoal/ai-slop-cleaner.md` |
| `hoje-goals-pipeline-validation` | `skills/ultragoal/pipeline-validation-contracts.md` |
