# devez-marketplace

Claude Code 플러그인 마켓플레이스

## 플러그인 목록

| 플러그인 | 버전 | 설명 |
|---------|------|------|
| `hoje-code` | **v0.13.1** 🔥 | 독립형 deep-ask, gate-plan, run-goals 워크플로우 |

## 설치 방법

### 1. 마켓플레이스 등록

`~/.claude/plugins/known_marketplaces.json`에 추가:

```json
"hoje": {
  "source": {
    "source": "git",
    "url": "https://github.com/MrHoje/devez-marketplace.git"
  }
}
```

### 2. 플러그인 설치

Claude Code에서:
```
/plugin install hoje-code@hoje
```

## 포함 스킬

| 스킬 | 설명 |
|------|------|
| `hoje-ask` | 소크라테스식 심층 인터뷰 + 수학적 모호성 게이팅 (재진입/체크포인트 지원) |
| `hoje-plan` | Planner→Architect→Critic 합의 계획 수립 (ADR, RALPLAN-DR 구조) |
| `hoje-goals` | @goal 블록 기반 순차 실행 + 품질 게이트 + ledger 감사 |
| `hoje-ask-auto-answer` | (내부) 모호성 기반 자동 응답 프래그먼트 |
| `hoje-ask-greenfield` | (내부) 그린필드 조사 프래그먼트 |
| `hoje-ask-panel` | (내부) 복수 페르소나 측면 검토 패널 |
| `hoje-goals-slop-cleaner` | (내부) AI Slop 정리 프래그먼트 |
| `hoje-goals-pipeline-validation` | (내부) 파이프라인 검증 계약 프래그먼트 |

## 버전 히스토리

| 버전 | 날짜 | 변경사항 |
|------|------|---------|
| **v0.13.1** | 2026-07-20 | `hoje-goals` 모델 자동 호출 허용; 다른 workflow 스킬은 수동 호출 유지 |
| **v0.13.0** 🔥 | 2026-07-20 | Node 네이티브 독립 런타임, `.hoje` 상태, 번들 역할 에이전트, 실행 강도 추가; Bun/GJC/tmux 실행 의존성 제거 |
| **v0.11.3** 🔥 | 2026-07-20 | Gajae-Code v0.11.3 동기화, 버전 고정 런처·세션 훅·Claude 호환 계층 추가 |
| v0.9.3 | 2026-07-09 | gajae-code v0.9.3 기준 업데이트 |
| v0.8.1 | — | gajae-code v0.8.1 기준 최초 포팅 |

## 최신화 가이드

이 플러그인은 [gajae-code](https://github.com/Yeachan-Heo/gajae-code)의 워크플로우 스킬을 hoje-code로 포팅한 것입니다.

### 적응 규칙

| 원본 (gajae) | 변경 (hoje-code) |
|-------------|-----------------|
| GJC 런타임 명령 | 번들 Node 런타임의 `hoje` 명령으로 실행 |
| `.gjc/`, `GJC_*`, `gjc` 설정 키 | `.hoje/`, `HOJE_*`, `hoje` 네이티브 계약으로 변환 |
| `/skill:deep-interview` | `/hoje-code:hoje-ask` |
| `/skill:ralplan` | `/hoje-code:hoje-plan` |
| `/skill:ultragoal` | `/hoje-code:hoje-goals` |

### 대체된 기능

| 스킬 | 사유 |
|------|------|
| `team` | 번들 `executor`, `executor-qa`, `architect`, `critic`, `planner` Agent로 대체 |
