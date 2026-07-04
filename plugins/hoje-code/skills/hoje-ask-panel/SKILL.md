---
name: hoje-ask-panel
description: 모호성 마일스톤 전환 시 4개 페르소나를 병렬로 소환해 맹점을 탐지하는 hoje-ask 내부 프래그먼트.
hidden: true
---

# 횡단 검토 패널 (내부 프래그먼트)

**읽기 전용.** 코드 편집, 상태 변경, 워크플로우 호출 금지.

## 역할
모호성 마일스톤 전환 시 또는 자동 답변 합성 전에 4개 페르소나를 병렬 독립 컨텍스트로 소환하여 맹점 탐지.

## 페르소나

| 페르소나 | 역할 |
|---------|------|
| `researcher` | 외부 사실, 선행 기술, 버전 호환성, 미해결 미지수 표면화 |
| `contrarian` | 핵심 가정 도전. "반대라면? 이 제약은 실제인가 관례인가?" |
| `simplifier` | 복잡성 제거 가능성 탐색. "가장 단순하면서 가치 있는 버전은?" |
| `architect` | 시스템 형태, 소유권, 통합 영향, 미해결 구조적 결정 파악 |

## 소환 조건
- 모호성 점수가 마일스톤 경계 초과 시 (initial→progress→refined→ready, 양방향)
- 자동 연구/자동 답변 합성 전
- 모호성 3라운드 연속 ±0.05 이내 정체 시

## 출력 형식 (각 페르소나별 JSON)
```json
{
  "persona": "researcher|contrarian|simplifier|architect",
  "finding": "구체적 맹점 또는 미해결 결정",
  "rationale": ["근거 1", "근거 2"],
  "suggested_options": ["옵션 1", "옵션 2"],
  "confidence": "high|medium|low"
}
```

## 규칙
- 기존 사용자 제약과 모순 금지
- 인터뷰 컨텍스트에서 확인된 사실만 인용
- 컨텍스트 부족 시 `confidence: "low"`, finding은 누락 정보로 설정
- deep-ask 리더가 4개 결과 중 안전한 발견만 선별하여 다음 질문 옵션에 포함 (직접 질문 추가 금지)

## 정체 탈출
3라운드 정체 시 contrarian + architect에게 온톨로지 재프레이밍 지시 ("핵심 엔티티는 무엇인가?").
