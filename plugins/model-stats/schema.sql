-- Supabase: model_metrics 테이블 + RLS. SQL Editor에 붙여 실행.

create table if not exists public.model_metrics (
  id             bigserial primary key,
  created_at     timestamptz default now(),
  source         text,          -- claude-code | codex
  session_id     text,
  project        text,          -- cwd basename
  model          text,          -- 실제 응답 모델 (비교축)
  category       text,          -- simple_bug/mystery_bug/feature/refactor/deep_reasoning/research/config_ops/question
  difficulty     text,          -- 하/중/상/최상
  input_tokens   int,
  output_tokens  int,
  tool_calls     int,
  duration_ms    int,
  raw            jsonb
);

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

-- PostgREST 스키마 캐시 갱신
notify pgrst, 'reload schema';
