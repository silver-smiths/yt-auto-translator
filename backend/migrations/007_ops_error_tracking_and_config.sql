-- Ops 자가수복 루프 Phase 0~1 스키마: 오류 추적 + 원격 설정(kill-switch)
-- Supabase SQL 편집기에서 실행. 기존 테이블/함수와 독립적이라 재실행 안전(IF NOT EXISTS / OR REPLACE).

-- ── 오류 원본 이벤트 ──────────────────────────────────────
create table if not exists public.error_events (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  source      text not null,          -- 'extension' | 'backend'
  version     text,
  fingerprint text not null,          -- 오류 지문(type+정규화 위치 해시)
  message     text,
  context     jsonb,
  anon_hash   text                    -- 익명 사용자 해시(PII 아님)
);
create index if not exists idx_error_events_fp      on public.error_events(fingerprint);
create index if not exists idx_error_events_created on public.error_events(created_at desc);

-- ── 지문별 집계(인시던트) ─────────────────────────────────
create table if not exists public.incidents (
  fingerprint    text primary key,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  count          integer     not null default 1,
  sample_message text,
  source         text,
  status         text        not null default 'open',   -- 'open' | 'resolved'
  resolved_at    timestamptz
);

-- ── 원격 설정 / kill-switch ───────────────────────────────
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 기본 스위치 시드(전부 정상=켜짐). 이미 있으면 건드리지 않음.
insert into public.app_config(key, value) values
  ('translate.enabled',           'true'::jsonb),
  ('translate.subtitles.enabled', 'true'::jsonb),
  ('translate.metadata.enabled',  'true'::jsonb),
  ('payment.enabled',             'true'::jsonb),
  ('lang.disabled',               '[]'::jsonb),
  ('banner',                      '{"message":"","level":"info"}'::jsonb)
on conflict (key) do nothing;

-- ── 오류 기록 + 인시던트 upsert (원자적). 신규 지문이면 true 반환(텔레그램 1회 알림용) ──
create or replace function public.record_error(
  p_source text, p_version text, p_fingerprint text,
  p_message text, p_context jsonb, p_anon_hash text
) returns boolean
language plpgsql as $$
declare v_is_new boolean;
begin
  insert into public.error_events(source, version, fingerprint, message, context, anon_hash)
    values (p_source, p_version, p_fingerprint, p_message, p_context, p_anon_hash);

  insert into public.incidents(fingerprint, sample_message, source)
    values (p_fingerprint, p_message, p_source)
  on conflict (fingerprint) do update
    set last_seen = now(),
        count     = incidents.count + 1,
        status    = case when incidents.status = 'resolved' then 'open' else incidents.status end
  returning (xmax = 0) into v_is_new;   -- xmax=0 → 이번에 새로 insert된 지문

  return v_is_new;
end;
$$;
