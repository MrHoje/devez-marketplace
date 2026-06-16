---
name: run-goals
description: brief를 @goal 블록으로 분리하고 각 goal을 품질 게이트와 함께 순차 완료하는 구조적 실행 시스템.
---

# Run-Goals (Structured Goal Execution)

> **우선순위 규칙**: 이 스킬이 로드되면 `executing-plans` 스킬을 자동 호출하지 않는다.
> 실행은 run-goals가 담당한다. executing-plans는 사용자가 명시적으로 요청할 때만 허용.

brief를 받아 goal로 분리하고, 각 goal을 **구현 → 품질 게이트 → 체크포인트** 루프로 순차 완료한다.

## Brief 구조

```
공유 컨텍스트 / 제약사항 (선택적 서문)

@goal: 첫 번째 목표 제목
상세 설명. 여러 줄 가능.

@goal: 두 번째 목표 제목
상세 설명.
```

`@goal` 구분자 없으면 전체 brief가 단일 목표 G001로 처리.

## 유효한 @goal 구분자
- `@goal: Title` (콜론 + 제목)
- `@goal Title` (공백 + 제목)
- `@goal` (단독)

## Step 1: Goals 생성

brief를 파싱하여 목표 목록을 생성하고 프로젝트에 `goals.md` 작성:

```markdown
# Goals

## G001: [제목]
**상태:** pending
**목표:** [설명]
**수용 기준:**
- [ ] ...

## G002: [제목]
...
```

`gate-plan`이나 `deep-ask`에서 넘어온 경우 해당 계획/스펙을 goals.md에 통합.

## Step 2: 각 Goal 실행 루프

각 goal에 대해 순서대로:

### 2a. 구현
- 현재 goal의 수용 기준을 기반으로 구현
- goal과 관련 없는 파일 수정 금지
- 관련 테스트 실행 확인

### 2b. 품질 게이트 (필수, 순서대로)

**① Slop Cleaner**
`run-goals-slop-cleaner` 스킬을 Skill 툴로 호출.
- 결과: `PASS` → 다음 단계
- 결과: `BLOCKED` → Agent(executor)를 스폰하여 차단 항목 수정 → Slop Cleaner 재실행 (PASS까지 반복)

**② Architect 리뷰**
Agent로 Architect를 스폰하여 읽기 전용 검토:
- 아키텍처 측면 (경계, 계층, 데이터 흐름)
- 제품 측면 (수용 기준, 엣지 케이스, 회귀)
- 코드 측면 (유지보수성, 테스트, 통합점)
- 결과: `APPROVE` / `COMMENT` / `REQUEST CHANGES` / `BLOCK`

**③ Executor QA**
Agent로 QA executor를 스폰하여:
- 수용 기준 대비 e2e 검증
- 경계/실패 케이스 테스트 (adversarial cases)
- 실제 실행 증거 제공 (스크린샷, CLI 출력, 테스트 결과)
- 결과: `passed` / `failed`

### 2c. 블로커 처리
Architect 또는 QA에서 블로커 발견 시:
1. 블로커 내용을 goals.md에 기록
2. 블로커 해결 서브골을 현재 goal 앞에 삽입
3. 해결 후 품질 게이트 전체 재실행

### 2d. 체크포인트
품질 게이트 전체 통과 시 goals.md 업데이트:

```markdown
## G001: [제목]
**상태:** ✅ complete
**완료 증거:** [테스트 통과, 스크린샷 등]
```

## Step 3: 다음 Goal

goals.md에서 다음 `pending` goal로 이동. 모든 goal이 complete이면 최종 요약 생성.

## 동적 조정 (Steering)

실행 중 언제든지:
- **goal 추가**: `@steer add: 새 목표 설명`
- **goal 분할**: `@steer split G002: A부분, B부분`
- **순서 변경**: `@steer reorder: G003, G001, G002`
- **메모**: `@steer note: 메모 내용`

**변경 불가**: aggregate 목표, 원본 제약사항, 품질 게이트, 완료된 goal 상태

## 품질 게이트 통과 기준 (모두 충족해야 함)

- Slop Cleaner: `PASS`
- Architect: `APPROVE`
- QA: 모든 항목 `passed`
- 수용 기준: 모두 체크

## 계획 없이 실행 요청 시

plan 또는 consensus artifact 없이 큰 작업을 요청받으면:
1. `gate-plan` 스킬을 Skill 툴로 호출하여 계획 수립 먼저
2. 계획 승인 후 실행 재개
3. 묵시적 즉흥 실행 금지

## Goals 파일 위치

`./goals.md` (프로젝트 루트) 또는 사용자가 지정한 경로.
파일이 이미 있으면 기존 내용에 통합.
