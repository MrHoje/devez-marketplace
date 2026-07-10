-- Supabase: model_metrics 테이블 + RLS. SQL Editor에 붙여 실행.

create table if not exists public.model_metrics (
  id                bigserial primary key,
  created_at        timestamptz default now(),
  source            text,          -- claude-code | codex
  session_id        text,
  project           text,          -- cwd basename
  model             text,          -- 실제 응답 모델 (비교축)
  category          text,          -- simple_bug/mystery_bug/feature/refactor/deep_reasoning/research/config_ops/question
  difficulty        text,          -- 하/중/상/최상 (작업량 기반)
  difficulty_llm    text,          -- 하/중/상/최상 (프롬프트 본질, LLM 판정)
  domain            text,          -- frontend/backend/database/devops/infra/data/mobile/other
  outcome           text,          -- success/partial/fail/na
  input_tokens      int,
  output_tokens     int,
  tool_calls        int,
  duration_ms       int,
  cost_usd          numeric,       -- 추정 비용(캐시 단가 반영)
  code_files        int,           -- 편집한 파일 수
  code_lines        int,           -- 추가 라인 수(근사)
  reasoning_tokens  int,           -- 추론 토큰(codex)
  outcome_signal    text,          -- 행동 기반 성과 검증: accepted/reworked/interrupted (다음 턴 반응)
  raw               jsonb
);

-- 기존 설치 업그레이드용(컬럼 추가)
alter table public.model_metrics add column if not exists difficulty_llm   text;
alter table public.model_metrics add column if not exists domain           text;
alter table public.model_metrics add column if not exists outcome          text;
alter table public.model_metrics add column if not exists cost_usd         numeric;
alter table public.model_metrics add column if not exists code_files       int;
alter table public.model_metrics add column if not exists code_lines       int;
alter table public.model_metrics add column if not exists reasoning_tokens int;
alter table public.model_metrics add column if not exists outcome_signal   text;

-- codex 중복 적재 방지(동시 스캐너 경합 대비 최종 방어선)
create unique index if not exists idx_mm_codex_turn
  on public.model_metrics (session_id, ((raw->>'turn'))) where source = 'codex';

create index if not exists idx_mm_model    on public.model_metrics (model);
create index if not exists idx_mm_category on public.model_metrics (category);
create index if not exists idx_mm_created  on public.model_metrics (created_at);
create index if not exists idx_mm_source   on public.model_metrics (source);

alter table public.model_metrics enable row level security;

-- 기록: anon insert 허용(키 유출돼도 통계만, 프롬프트 본문 미저장)
drop policy if exists mm_insert_anon on public.model_metrics;
create policy mm_insert_anon on public.model_metrics for insert to anon with check (true);

-- 대시보드 읽기: anon select 허용(통계만 노출)
drop policy if exists mm_select_anon on public.model_metrics;
create policy mm_select_anon on public.model_metrics for select to anon using (true);

-- 대시보드 '전체삭제' 버튼용: anon delete 허용
-- ⚠️ 키 아는 사람 누구나 전체삭제 가능. 원치 않으면 이 블록 제거(삭제는 콘솔/PAT로만).
drop policy if exists mm_delete_anon on public.model_metrics;
create policy mm_delete_anon on public.model_metrics for delete to anon using (true);

-- outcome_signal 소급 보정용: anon update 허용(다음 턴 반응으로 이전 턴 성과 검증)
drop policy if exists mm_update_anon on public.model_metrics;
create policy mm_update_anon on public.model_metrics for update to anon using (true) with check (true);

-- PostgREST 스키마 캐시 갱신
notify pgrst, 'reload schema';
