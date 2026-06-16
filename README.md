# hoje-marketplace

Claude Code 플러그인 마켓플레이스

## 플러그인 목록

| 플러그인 | 설명 |
|---------|------|
| `hoje-code` | deep-ask, gate-plan, run-goals 워크플로우 스킬 |

## 설치 방법

### 1. 마켓플레이스 등록

`~/.claude/plugins/known_marketplaces.json`에 추가:

```json
"hoje": {
  "source": {
    "source": "git",
    "url": "https://github.com/MrHoje/hoje-marketplace.git"
  }
}
```

### 2. 플러그인 설치

Claude Code에서:
```
/plugin install hoje-code@hoje
```

## 포함 스킬

- `deep-ask` — 모호한 아이디어를 소크라테스식 질문으로 스펙까지 끌어올리는 인터뷰어
- `gate-plan` — Planner→Architect→Critic 합의로 계획을 수립하는 게이트키퍼
- `run-goals` — @goal 블록 기반 품질 게이트 포함 순차 실행 시스템
