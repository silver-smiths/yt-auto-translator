-- ============================================================
-- YT Auto-Translator v2.0 — Supabase Schema
-- ============================================================

-- ── 확장 ──────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── ENUM 대신 text + CHECK 사용 (Supabase 호환성) ─────────

-- ============================================================
-- 1. users
-- Google OAuth로 식별되는 사용자 기본 테이블
-- ============================================================
create table public.users (
  id           uuid primary key default uuid_generate_v4(),
  google_id    text unique not null,
  email        text not null,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- 2. credit_accounts
-- 사용자당 1개. 잔액 + 누적 사용량 + 티어 관리
-- ============================================================
create table public.credit_accounts (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null unique references public.users(id) on delete cascade,
  balance          numeric(12, 6) not null default 0 check (balance >= 0),
  cumulative_used  numeric(12, 6) not null default 0,  -- 실제 API 비용 누적 (티어 기준)
  tier             text not null default 'light'
                     check (tier in ('light', 'standard', 'heavy')),
  updated_at       timestamptz not null default now()
);

-- 티어 기준 (cumulative_used 기준 USD)
-- light:    $0  ~ $30   → 1.3x
-- standard: $30 ~ $100  → 1.2x
-- heavy:    $100+        → 1.1x

-- ============================================================
-- 3. payments
-- Portone 결제 기록 (Toss / Stripe 통합)
-- ============================================================
create table public.payments (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.users(id) on delete restrict,
  portone_id       text unique not null,          -- Portone 결제 고유 ID
  pg_provider      text not null
                     check (pg_provider in ('toss', 'stripe')),
  amount_paid      numeric(12, 2) not null,       -- 실제 결제 금액 (원화/달러 원본)
  currency         text not null
                     check (currency in ('KRW', 'USD')),
  amount_usd       numeric(12, 6) not null,       -- USD 환산 금액
  credits_granted  numeric(12, 6) not null,       -- 지급된 크레딧 (= amount_usd)
  status           text not null default 'pending'
                     check (status in ('pending', 'completed', 'failed', 'refunded')),
  metadata         jsonb,                         -- Portone 원본 응답 저장
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============================================================
-- 4. credit_transactions
-- 모든 크레딧 변동 이력 (충전 / 차감 / 환불)
-- ============================================================
create table public.credit_transactions (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.users(id) on delete restrict,
  type           text not null
                   check (type in ('topup', 'deduction', 'refund')),
  amount         numeric(12, 6) not null,   -- 양수: 증가, 음수: 감소
  balance_before numeric(12, 6) not null,
  balance_after  numeric(12, 6) not null,
  description    text,
  payment_id     uuid references public.payments(id),          -- topup 시
  job_id         uuid,                                          -- deduction 시 (FK는 아래에서 추가)
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 5. translation_jobs
-- 번역 작업 단위. 실제 Gemini 토큰 사용량 및 크레딧 차감 기록
-- ============================================================
create table public.translation_jobs (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.users(id) on delete restrict,
  video_id         text not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'running', 'completed', 'failed', 'stopped')),
  job_type         text not null default 'subtitles'
                     check (job_type in ('subtitles', 'title_desc', 'all')),
  source_lang      text,
  target_langs     text[] not null default '{}',
  model            text,
  -- Gemini 실사용량
  input_tokens     integer not null default 0,
  output_tokens    integer not null default 0,
  api_cost_usd     numeric(12, 6) not null default 0,   -- 실제 Gemini 비용
  -- 크레딧 차감
  multiplier       numeric(4, 2) not null default 1.3,  -- 티어별 배율
  credits_charged  numeric(12, 6) not null default 0,   -- api_cost × multiplier
  error_message    text,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

-- credit_transactions.job_id FK (순환 참조 회피를 위해 별도 추가)
alter table public.credit_transactions
  add constraint fk_job_id
  foreign key (job_id) references public.translation_jobs(id);

-- ============================================================
-- 인덱스
-- ============================================================
create index idx_credit_accounts_user_id    on public.credit_accounts(user_id);
create index idx_payments_user_id           on public.payments(user_id);
create index idx_payments_status            on public.payments(status);
create index idx_credit_transactions_user   on public.credit_transactions(user_id);
create index idx_credit_transactions_type   on public.credit_transactions(type);
create index idx_translation_jobs_user      on public.translation_jobs(user_id);
create index idx_translation_jobs_status    on public.translation_jobs(status);
create index idx_translation_jobs_video     on public.translation_jobs(video_id);

-- ============================================================
-- 티어 자동 갱신 트리거
-- cumulative_used 변경 시 tier를 자동으로 업데이트
-- ============================================================
create or replace function public.update_tier()
returns trigger language plpgsql as $$
begin
  new.tier := case
    when new.cumulative_used >= 100 then 'heavy'
    when new.cumulative_used >= 30  then 'standard'
    else 'light'
  end;
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_update_tier
  before update of cumulative_used on public.credit_accounts
  for each row execute function public.update_tier();

-- ============================================================
-- 크레딧 차감 함수 (원자적 처리)
-- Cloudflare Workers에서 RPC로 호출 → 잔액 부족 시 예외 발생
-- ============================================================
create or replace function public.deduct_credits(
  p_user_id    uuid,
  p_job_id     uuid,
  p_api_cost   numeric,   -- 실제 Gemini 비용 (USD)
  p_multiplier numeric    -- 티어 배율
)
returns numeric           -- 차감 후 잔액 반환
language plpgsql as $$
declare
  v_charge   numeric;
  v_bal_before numeric;
  v_bal_after  numeric;
begin
  v_charge := round(p_api_cost * p_multiplier, 6);

  -- 잔액 잠금 (동시 요청 방지)
  select balance into v_bal_before
    from public.credit_accounts
   where user_id = p_user_id
     for update;

  if v_bal_before < v_charge then
    raise exception 'INSUFFICIENT_CREDITS: 잔액 % < 청구 %', v_bal_before, v_charge;
  end if;

  v_bal_after := v_bal_before - v_charge;

  -- 잔액 차감 + 누적 사용량 증가
  update public.credit_accounts
     set balance         = v_bal_after,
         cumulative_used = cumulative_used + p_api_cost  -- 실비 기준 누적
   where user_id = p_user_id;

  -- 거래 이력 기록
  insert into public.credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, job_id)
  values
    (p_user_id, 'deduction', -v_charge, v_bal_before, v_bal_after,
     'Gemini API 사용 (×' || p_multiplier || ')', p_job_id);

  return v_bal_after;
end;
$$;

-- ============================================================
-- 크레딧 충전 함수
-- 결제 완료 웹훅 수신 시 호출
-- ============================================================
create or replace function public.grant_credits(
  p_user_id   uuid,
  p_payment_id uuid,
  p_amount_usd numeric
)
returns numeric
language plpgsql as $$
declare
  v_bal_before numeric;
  v_bal_after  numeric;
begin
  select balance into v_bal_before
    from public.credit_accounts
   where user_id = p_user_id
     for update;

  v_bal_after := v_bal_before + p_amount_usd;

  update public.credit_accounts
     set balance    = v_bal_after,
         updated_at = now()
   where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, payment_id)
  values
    (p_user_id, 'topup', p_amount_usd, v_bal_before, v_bal_after,
     '크레딧 충전', p_payment_id);

  return v_bal_after;
end;
$$;

-- ============================================================
-- Row Level Security (RLS)
-- 사용자는 자신의 데이터만 조회 가능
-- ============================================================
alter table public.users               enable row level security;
alter table public.credit_accounts     enable row level security;
alter table public.payments            enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.translation_jobs    enable row level security;

-- users: 본인만
create policy "users_self" on public.users
  for all using (id = auth.uid());

-- credit_accounts: 본인만
create policy "credit_accounts_self" on public.credit_accounts
  for all using (user_id = auth.uid());

-- payments: 본인만
create policy "payments_self" on public.payments
  for all using (user_id = auth.uid());

-- credit_transactions: 본인만
create policy "credit_transactions_self" on public.credit_transactions
  for all using (user_id = auth.uid());

-- translation_jobs: 본인만
create policy "translation_jobs_self" on public.translation_jobs
  for all using (user_id = auth.uid());

-- ============================================================
-- 서비스 롤 (Cloudflare Workers에서 사용할 service_role은 RLS 우회)
-- → Supabase 대시보드에서 service_role 키 사용 시 자동 적용
-- ============================================================
