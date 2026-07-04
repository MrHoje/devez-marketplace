---
name: hoje-goals
description: brief를 @goal 블록으로 분리하고 각 goal을 품질 게이트와 함께 순차 완료하는 구조적 실행 시스템.
level: 4
---

# Hoje-Goals (구조적 목표 실행)

`.hoje/_session-{sessionid}/ultragoal/goals.json`이 goal ID/상태의 정규 소스이며, `ledger.jsonl`이 체크포인트/블로커/조정 감사 내역이다. 인라인 goal 도구는 UX 브리지 전용이다.

## 명령어

```
hoje goals create-goals --brief "<brief>"
hoje goals create-goals --brief-file <path>
hoje goals complete-goals
hoje goals complete-goals --retry-failed
hoje goals checkpoint --goal-id <id> --status complete --evidence "<ev>" --quality-gate-json <json>
hoje goals checkpoint --goal-id <id> --status failed --evidence "<ev>"
hoje goals status
hoje goals steer --kind add_subgoal --title "..." --objective "..." --evidence "..."
```

## @goal 구분자

```
공유 컨텍스트 (선택적 서문)

@goal: 첫 번째 목표
목표 설명...

@goal: 두 번째 목표
목표 설명...
```

- `@goal:` / `@goal` / `@goal Title` 모두 유효 (컬럼 0 시작, 선행 공백 없음)
- 서문은 goal이 되지 않음 (전역 컨텍스트)
- 구분자 없으면 전체가 단일 G001

## 실행 루프

1. `hoje goals create-goals`로 goals.json 생성
2. `hoje goals complete-goals`로 다음 goal 확인
3. `goal({"op":"get"})` → `goal({"op":"create","objective":"..."})`
4. 현재 goal 구현
5. **필수 정리/검토 게이트 실행** (아래)
6. `hoje goals checkpoint --goal-id <id> --status complete --quality-gate-json <json>`
7. 모든 goal 완료 시까지 반복

## 블로커 분류

- **resolvable**: 에이전트가 처리 가능 (테스트 실패, 구현 누락 등) — 절대 일시중지 금지, executor 위임 또는 steer로 블로커 기록
- **human_blocked**: 사용자만 처리 가능 (크리덴셜, 수동 단계, 외부 승인) — 마지막 수단으로만 pause

## 동적 조정 (Steer)

```
hoje goals steer --kind add_subgoal --title "블로커 조사" --objective "..." --evidence "..."
hoje goals steer --kind split_subgoal --goal-id G002 --replacements-json '[...]'
hoje goals steer --kind reorder_pending --order-json '["G003","G002"]'
hoje goals steer --kind revise_pending_wording --goal-id G002 --title "새 제목"
```

변경 불가: aggregate 목표, 원본 제약, 품질 게이트, 완료된 goal 상태.

## 필수 구현 위임 (대규모 작업)

story가 다음 조건 중 하나라도 해당하면 **반드시 executor 에이전트에 위임**:
- 3개 이상 파일 또는 2개 이상 독립 모듈
- 약 200라인 이상 순 변경
- 병렬 가능한 독립 슬라이스
- 리더가 이미 2회 이상 인라인 수정

위임 규칙: 클린 슬라이스로 분할, 각 executor에 명확한 수용 기준 제시, 독립 슬라이스는 병렬 실행.

## 완료 정리/검토 게이트 (필수)

goal을 `complete` 체크포인트하기 전 반드시 실행:

1. **ai-slop-cleaner** — 변경 파일만 검사, BLOCKING 0건까지 반복
2. **검증 재실행** — cleaner 통과 후
3. **Architect 리뷰** — 아키텍처/제품/코드 3개 레인
4. **Executor QA/레드팀** — 실제 표면에서 E2E 증명 (스크린샷, CLI 재생, API 증거 등)

`--quality-gate-json` 구조:
```json
{
  "architectReview": { "architectureStatus": "CLEAR", "productStatus": "CLEAR", "codeStatus": "CLEAR", "recommendation": "APPROVE", "blockers": [] },
  "executorQa": { "status": "passed", "contractCoverage": [...], "surfaceEvidence": [...], "adversarialCases": [...], "blockers": [] },
  "iteration": { "status": "passed", "fullRerun": true, "blockers": [] }
}
```

모든 레인 CLEAR/passed, blockers 0건, evidence 전부 비어있지 않아야 통과. 하나라도 실패하면 블로커 기록 후 재시도.

## 계획 없는 요청 처리

plan이나 합의 산출물 없이 큰 작업 요청 시:
1. `/hoje-plan`으로 먼저 계획 수립
2. 승인 후 실행
3. 묵시적 즉흥 실행 금지
