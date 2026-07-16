-- 추천인 크레딧 페이백(원안, 출금 없음): 피추천인 소진액 10%를 추천인 크레딧으로 일일 적립
-- 재실행 안전. 007/008과 독립.

-- 추천 코드(공유용, 링크 ?ref=CODE) + 추천 연결(피추천인 → 추천인, 1회·불변)
alter table public.users add column if not exists referral_code text;
alter table public.users add column if not exists referred_by uuid references public.users(id);
alter table public.users add column if not exists referred_at timestamptz;
create unique index if not exists idx_users_referral_code on public.users(referral_code) where referral_code is not null;
create index if not exists idx_users_referred_by on public.users(referred_by);

-- 일일 적립 원장 (멱등: 피추천인+날짜 유일 → 배치 재실행해도 중복 적립 없음)
create table if not exists public.referral_rewards (
  id           bigserial primary key,
  referrer_id  uuid not null references public.users(id),
  referee_id   uuid not null references public.users(id),
  reward_date  date not null,
  consumed_krw numeric(16,4) not null,   -- 그 날 피추천인 소진액(크레딧=원화)
  amount_krw   numeric(16,4) not null,   -- 적립액(= 소진액 * 10%)
  created_at   timestamptz not null default now(),
  unique (referee_id, reward_date)
);
create index if not exists idx_referral_rewards_referrer on public.referral_rewards(referrer_id, created_at desc);

-- credit_transactions.type에 'referral_payback' 허용 (기존 type CHECK 제약 교체)
do $$ declare r record; begin
  for r in select conname from pg_constraint
           where conrelid='public.credit_transactions'::regclass and contype='c'
             and pg_get_constraintdef(oid) ilike '%type%'
  loop execute 'alter table public.credit_transactions drop constraint '||quote_ident(r.conname); end loop;
end $$;
alter table public.credit_transactions
  add constraint credit_transactions_type_check
  check (type in ('topup','deduction','refund','referral_payback'));

-- 일일 적립 배치: p_date(하루) 동안 각 피추천인 소진 합산 → 추천인 크레딧 적립 (12개월 창·멱등)
create or replace function public.accrue_referral_rewards(p_date date)
returns integer language plpgsql as $$
declare v_count int := 0; rec record; v_amt numeric; v_before numeric;
begin
  for rec in
    select u.id as referee_id, u.referred_by as referrer_id,
           coalesce(sum(-ct.amount), 0) as consumed   -- deduction.amount는 음수 → 부호 반전
      from public.users u
      join public.credit_transactions ct
        on ct.user_id = u.id and ct.type = 'deduction'
       and ct.created_at >= p_date::timestamptz
       and ct.created_at <  (p_date + 1)::timestamptz
     where u.referred_by is not null and u.referred_at is not null
       and p_date < (u.referred_at + interval '12 months')::date   -- 추천연결 후 12개월 창
     group by u.id, u.referred_by
     having coalesce(sum(-ct.amount), 0) > 0
  loop
    v_amt := round(rec.consumed * 0.10, 4);

    -- 추천인 계정 잠금(없으면 방어적 skip)
    select balance into v_before from public.credit_accounts where user_id = rec.referrer_id for update;
    if v_before is null then continue; end if;

    -- 멱등: 그 날 이미 적립됐으면 skip
    begin
      insert into public.referral_rewards(referrer_id, referee_id, reward_date, consumed_krw, amount_krw)
        values (rec.referrer_id, rec.referee_id, p_date, rec.consumed, v_amt);
    exception when unique_violation then continue; end;

    update public.credit_accounts set balance = v_before + v_amt where user_id = rec.referrer_id;
    insert into public.credit_transactions(user_id, type, amount, balance_before, balance_after, description)
      values (rec.referrer_id, 'referral_payback', v_amt, v_before, v_before + v_amt, '추천 페이백 10% ('||p_date||')');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
