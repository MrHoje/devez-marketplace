---
name: hoje-plan
description: 모호한 실행 요청을 차단하고 Planner→Architect→Critic 합의 루프로 계획을 수립하는 게이트키퍼. 실행 전 항상 거쳐야 하는 계획 관문.
level: 4
---

# Hoje-Plan (합의 계획 수립)

Planner → Architect → Critic 반복 합의로 실행 계획을 수립한다.

## 사용법

```
/hoje-plan "작업 설명"
/hoje-plan --interactive "작업 설명"
/hoje-plan --deliberate "고위험 작업 설명"
```

## 플래그

- `--interactive`: 중간 사용자 확인 활성화 (초안 검토, 단계별 조정). 항상 승인 UI로 종료.
- `--deliberate`: 고위험 작업 모드. 사전-사후 분석(pre-mortem 3개 시나리오) + 확장 테스트 계획 추가. 인증/보안/마이그레이션/프로덕션 장애/PHI/API 변경 시 자동 활성화 가능.

## 게이트: 구체성 판단

**즉시 통과** (직접 hoje-goals로 전달):
- 파일 경로 포함, 이슈/PR 번호, 함수명/클래스명, 번호 매긴 단계, 수용 기준 명시, 에러 메시지, `force:`/`!` 접두사

**계획 수립 필요** (합의 워크플로우 진행):
- 모호한 요청 ("고쳐줘", "만들어줘", 15단어 이내, 구체적 기준 없음)

## 합의 워크플로우

### Step 1: Planner — 초안
Planner 에이전트가 다음 포함 계획 초안 작성:
- **원칙** (3-5개)
- **결정 기준** (상위 3개)
- **실행 옵션** (2개 이상, 각각 장단점)
- **권장 접근법**
- **수용 기준** (테스트 가능해야 함)
- **Deliberate 모드만**: pre-mortem 3개 + 확장 테스트 계획

### Step 2: Architect 검토
Architect 에이전트가 검토 (Planner 완료 후 순차 실행):
- 아키텍처 건전성, 가장 강력한 반론(steelman antithesis), 실제 트레이드오프
- 결과: `CLEAR` / `WATCH` / `BLOCK`

### Step 3: Critic 평가
Critic 에이전트가 평가 (Architect 완료 후 순차 실행):
- 원칙-옵션 일관성, 리스크 완화, 수용 기준 테스트 가능성
- 결과: `APPROVE` / `ITERATE` / `REJECT`

### 재검토 루프 (최대 5회)
`ITERATE` 또는 `REJECT`면:
1. 피드백 수집 → Planner 수정
2. Architect 재검토 → Critic 재평가
3. `APPROVE` 또는 5회 초과 시 종료

### 사후 인터뷰 (의도 조정 게이트)
Critic `APPROVE` 후, 계획이 사용자 의도와 일치하는지 확인:
- 합의 과정에서 가정으로 처리된 항목 수집
- 기존 deep-ask 스펙과 충돌 확인
- `ask` 도구로 항목별 확인 (약한 것부터)
- 조정 결과를 계획에 `## 의도 조정` 섹션으로 포함

### 승인 UI
항상 `ask` 도구로 최종 선택 제시:
- **계획 정제** — 합의 루프 재실행
- **hoje-goals로 실행 (권장)** — 목표 기반 자동 실행
- **여기서 중지** — `pending approval` 상태로 유지

## 최종 계획 출력

```markdown
## 계획 요약
[목표]

## 접근 방법
[선택 옵션 + 근거]

## 실행 단계
1. ...

## 수용 기준
- [ ] ...

## 리스크 & 트레이드오프
- ...

## 의도 조정
- ...

상태: PENDING APPROVAL
```

## 문제 해결

| 문제 | 해결 |
|------|------|
| 구체적인데 차단됨 | 파일 경로나 함수명 추가 |
| 우회 필요 | `force:` 접두사 |
| 계획이 너무 추상적 | Architect에게 구체적 파일명 요구 |
