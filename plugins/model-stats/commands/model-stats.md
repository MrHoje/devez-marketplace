---
description: 모델별 프롬프트 계측 집계(종류/난이도/토큰/툴콜)를 Supabase에서 조회해 표로 보여준다
---

`~/.model-stats/.env`에서 `SUPABASE_URL`, `SUPABASE_KEY`를 읽어라. 없으면 사용자에게 설정 안내 후 중단.

아래 두 집계를 Supabase REST(PostgREST)로 조회해 각각 마크다운 표로 출력하라. `curl`로 GET 하되 헤더에 `apikey`와 `Authorization: Bearer <KEY>`를 넣어라. (anon select 정책 필요 — 없으면 빈 결과.)

1. **source × model 요약** — 건수, 평균 output_tokens, 평균 tool_calls, 평균 duration_ms
   endpoint 예:
   `GET {URL}/rest/v1/model_metrics?select=source,model,output_tokens,tool_calls,duration_ms`
   받은 JSON을 로컬에서 그룹핑·평균내어 표로.

2. **model × difficulty 분포** — 난이도(하/중/상/최상)별 건수 교차표.
   같은 데이터 재사용.

주의:
- 프롬프트 본문은 저장 안 됨(통계만). 조회로도 본문 안 나옴.
- 행이 많으면 `&created_at=gte.<최근 30일 ISO>`로 제한.
- 표는 건수 내림차순 정렬. 숫자는 반올림.
- 끝에 한 줄 요약(어느 모델이 어떤 난이도/종류에 많이 쓰였는지) 덧붙여라.
