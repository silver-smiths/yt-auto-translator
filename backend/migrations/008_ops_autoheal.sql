-- 자가수복 루프 Phase 2: 자동 완화(워처) 지원 — feature/lang 계측 + 자동조치 감사 + 설정
-- 007 실행 후 이 파일을 실행. 재실행 안전.

-- error_events에 feature/lang 태그 컬럼 (원인 기능 귀속용)
alter table public.error_events add column if not exists feature text;
alter table public.error_events add column if not exists lang    text;
create index if not exists idx_error_events_feature on public.error_events(feature, created_at desc);

-- 자동/수동 완화 조치 감사 로그 (쿨다운·이력)
create table if not exists public.ops_actions (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  action     text not null,    -- 'auto_disable' | 'auto_alert' 등
  target     text,             -- 대상 스위치 키
  reason     text
);
create index if not exists idx_ops_actions_target on public.ops_actions(target, created_at desc);

-- 자동 완화 설정 (튜닝은 코드 배포 없이 이 값 수정)
insert into public.app_config(key, value) values
  ('ops.autoheal', '{"enabled":true,"window_min":15,"min_count":20,"min_users":3}'::jsonb)
on conflict (key) do nothing;

-- record_error를 시그니처 변경 없이 갱신 — context의 feature/lang을 컬럼에도 채움
create or replace function public.record_error(
  p_source text, p_version text, p_fingerprint text,
  p_message text, p_context jsonb, p_anon_hash text
) returns boolean
language plpgsql as $$
declare v_is_new boolean;
begin
  insert into public.error_events(source, version, fingerprint, message, context, anon_hash, feature, lang)
    values (p_source, p_version, p_fingerprint, p_message, p_context, p_anon_hash,
            nullif(p_context->>'feature',''), nullif(p_context->>'lang',''));

  insert into public.incidents(fingerprint, sample_message, source)
    values (p_fingerprint, p_message, p_source)
  on conflict (fingerprint) do update
    set last_seen = now(),
        count     = incidents.count + 1,
        status    = case when incidents.status = 'resolved' then 'open' else incidents.status end
  returning (xmax = 0) into v_is_new;

  return v_is_new;
end;
$$;
