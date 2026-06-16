# hoje-code

gajae-code의 핵심 워크플로우 스킬을 Claude Code에서 사용할 수 있도록 포팅한 플러그인.

## 스킬

| 스킬 | 원본 | 설명 |
|------|------|------|
| `deep-ask` | deep-interview | 모호성 점수 기반 소크라테스식 인터뷰 |
| `gate-plan` | ralplan | 모호 요청 차단 + 합의 플래닝 |
| `run-goals` | ultragoal | @goal 기반 순차 실행 + 품질 게이트 |

## 권장 파이프라인

```
/deep-ask "아이디어" → 스펙 → /gate-plan → 계획 → /run-goals → 실행
```
