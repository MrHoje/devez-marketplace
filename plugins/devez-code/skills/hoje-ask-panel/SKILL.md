---
name: hoje-ask-panel
description: 모호성 마일스톤 전환 시 4개 페르소나를 병렬로 소환해 맹점을 탐지하는 hoje-ask 내부 프래그먼트.
hidden: true
---

# Deep-Ask Lateral Review Panel (Fragment)

**읽기 전용.** 코드 편집, 상태 변경, 워크플로우 호출 금지.

## 역할
모호성 마일스톤 전환(initial→progress→refined→ready) 시, 또는 자동 답변 합성 전에 4개 페르소나를 **병렬 독립 컨텍스트**로 소환하여 맹점을 탐지한다.

## 페르소나

| 페르소나 | 역할 |
|---------|------|
| `researcher` | 외부 사실, 선행 기술, 버전 호환성, 미해결 미지수 표면화 |
| `contrarian` | 핵심 가정 도전. "반대라면? 이 제약은 실제인가 관례인가?" |
| `simplifier` | 복잡성 제거 가능성 탐색. "가장 단순하면서 가치 있는 버전은?" |
| `architect` | 시스템 형태, 소유권, 통합 영향, 미해결 구조적 결정 파악 |

## 소환 조건
- 모호성 점수가 마일스톤 경계를 넘을 때 (양방향)
- 자동 연구/자동 답변 합성 전
- 모호성이 3라운드 연속 ±0.05 이내로 정체 시

## 출력 형식 (각 페르소나별 JSON)

```json
{
  "status": "answered",
  "persona": "researcher|contrarian|simplifier|architect",
  "finding": "구체적 맹점 또는 미해결 결정",
  "rationale": ["근거 1", "근거 2"],
  "suggested_options": ["선택지 1", "선택지 2"],
  "confidence": "high|medium|low"
}
```

## 규칙
- `finding`: 공백 불가, 구체적, 기존 사용자 제약과 모순 금지
- `rationale`: 인터뷰 컨텍스트에서 확인된 사실만 인용
- `suggested_options`: 다음 질문에서 옵션으로 제시 가능한 형태
- 컨텍스트 부족 시 `confidence: "low"`, `finding`을 누락 정보로 설정

## 결과 통합 (deep-ask 리더 담당)
4개 페르소나 결과 중 구체적이고 안전한 발견사항만 선별하여 다음 단일 사용자 질문에 2-3개 옵션으로 포함.
패널이 직접 질문 추가하거나 요구사항 변경 금지. 1회 질문 규칙 유지.

## 모호성 정체 탈출
3라운드 이상 정체 시 `contrarian`과 `architect`에게 "이것의 핵심 엔티티는 무엇인가?" 를 중심으로 온톨로지 재프레이밍 지시.
