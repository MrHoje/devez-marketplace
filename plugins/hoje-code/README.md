# hoje-code

Gajae-Code의 핵심 워크플로우를 Claude Code에서 실행하는 플러그인입니다. 공개 스킬 진입점은 Hoje-Code 이름을 사용하고, 상태·검증 런타임은 버전 고정된 GJC 백엔드를 사용합니다.

## 포함 기능

| 스킬 | 역할 |
|---|---|
| `/hoje-code:hoje-ask` | 모호성 점수 기반 심층 인터뷰와 명세 작성 |
| `/hoje-code:hoje-plan` | Planner → Architect → Critic 합의 계획 |
| `/hoje-code:hoje-goals` | 내구성 있는 멀티 골 실행과 품질 게이트 |

5개 내부 헬퍼 스킬은 `user-invocable: false`로 숨기고 메인 워크플로우에서만 호출합니다.

## 런타임

- 기준 버전: `@gajae-code/coding-agent` **v0.11.3**
- `bin/hoje`, `bin/hoje.ps1`, `bin/hoje.cmd`가 정확히 같은 버전의 전역 `gjc`를 우선 사용합니다.
- 전역 버전이 없거나 다르면 Bun을 통해 고정 버전을 실행합니다.
- SessionStart 훅이 Claude 세션별 `GJC_SESSION_ID`를 자동 설정합니다.
- GJC 백엔드 계약인 `.gjc/`, `GJC_*` 환경변수, `gjc` 설정 키는 의도적으로 유지합니다.

런타임 확인:

```sh
hoje runtime version
hoje runtime doctor
```

## 권장 파이프라인

```text
/hoje-code:hoje-ask "아이디어"
  → /hoje-code:hoje-plan
  → /hoje-code:hoje-goals
```

`team`은 tmux와 GJC 대화형 세션을 요구하므로 공개 플러그인 스킬로 포함하지 않습니다. 필요한 경우 명시적으로 `hoje team`을 사용합니다.

## 최신화와 검증

```sh
bun run scripts/sync-gajae.ts --check-only
bun run scripts/sync-gajae.ts --verify
claude plugin validate --strict plugins/hoje-code
```

동기화 스크립트는 npm `latest` 버전의 Git 태그에서 원본 8개 파일을 읽고 Claude 호환 규칙을 결정적으로 적용합니다. 릴리스 페이지보다 npm 배포가 앞서는 경우에도 최신 패키지를 기준으로 합니다.

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
