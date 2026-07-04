# hoje-code

gajae-code의 핵심 워크플로우 스킬을 Claude Code에서 사용할 수 있도록 포팅한 플러그인.

## 스킬

| 스킬 | 원본 (gajae-code) | 설명 |
|------|-------------------|------|
| `hoje-ask` | `deep-interview` | 모호성 점수 기반 소크라테스식 인터뷰 |
| `hoje-plan` | `ralplan` | 모호 요청 차단 + 합의 플래닝 |
| `hoje-goals` | `ultragoal` | @goal 기반 순차 실행 + 품질 게이트 |

## 권장 파이프라인

```
/hoje-code:hoje-ask "아이디어" → 스펙 → /hoje-code:hoje-plan → 계획 → /hoje-code:hoje-goals → 실행
```

## 최신화 가이드

### 기준 버전
- **gajae-code v0.8.1** 기준으로 포팅됨
- 원본 레포: https://github.com/Yeachan-Heo/gajae-code
- gajae-code 워크플로우 스킬 위치: `packages/coding-agent/src/defaults/gjc/skills/`
- gajae-code 내부 프래그먼트: `packages/coding-agent/src/defaults/gjc/skill-fragments/`

### 스킬 매핑

| hoje-code | gajae-code 원본 | 타입 |
|-----------|----------------|------|
| `skills/hoje-ask/SKILL.md` | `skills/deep-interview/SKILL.md` | 메인 스킬 |
| `skills/hoje-plan/SKILL.md` | `skills/ralplan/SKILL.md` | 메인 스킬 |
| `skills/hoje-goals/SKILL.md` | `skills/ultragoal/SKILL.md` | 메인 스킬 |
| `skills/hoje-ask-auto-answer/SKILL.md` | `skill-fragments/<deploy>/auto-answer-uncertain.md` | 내부 프래그먼트 |
| `skills/hoje-ask-greenfield/SKILL.md` | `skill-fragments/<deploy>/auto-research-greenfield.md` | 내부 프래그먼트 |
| `skills/hoje-ask-panel/SKILL.md` | `skill-fragments/<deploy>/lateral-review-panel.md` | 내부 프래그먼트 |
| `skills/hoje-goals-slop-cleaner/SKILL.md` | `skill-fragments/ultragoal/ai-slop-cleaner.md` | 내부 프래그먼트 |

### 최신화 방법

1. gajae-code 레포의 최신 릴리스 확인: https://github.com/Yeachan-Heo/gajae-code/releases
2. 위 매핑 테이블의 원본 파일들을 최신 버전으로 읽기
3. 아래 적응 규칙에 따라 hoje-code에 맞게 변환:

#### 적응 규칙 (필수)
| 원본 (gajae) | 변경 (hoje-code) |
|-------------|-----------------|
| `.gjc/` | `.hoje/` |
| `gjc` (CLI 명령어) | `hoje` |
| `GJC` | `Hoje-Code` |
| `/skill:deep-interview` | `/skill:hoje-ask` |
| `/skill:ralplan` | `/skill:hoje-plan` |
| `/skill:ultragoal` | `/skill:hoje-goals` |
| `/skill:team` | (미포함, 필요 시 추가) |
| 영문 설명/프롬프트 | 한국어로 유지 또는 번역 |
| `skill-fragments/` 경로 | `skills/` 내 subdirectory로 배치 |
| `kind: "skill-fragment"` | `hidden: true`로 대체 |

4. `marketplace.json`의 version bump
5. 커밋 및 푸시
