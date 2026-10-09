-- 013: 추천 적립을 "유료 소비분"에만 지급 (무료=추천 크레딧으로 쓴 소비는 상위 추천인 적립 제외)
-- 방법: deduct_credits가 차감 트랜잭션에 유료 소비분(paid_amount)을 기록 →
--       accrue_referral_rewards가 -amount(전액) 대신 paid_amount 합산.
-- paid_amount = 전체 차감액 − 추천버킷 소진분(v_take_promo) = 유료 소진 + 오버드래프트(유료 부채).
-- 012(deduct_credits 5-인자)·010(accrue) 실행 후 이 파일 실행. 시그니처 동일 → drop 불필요.

alter table public.credit_transactions
  add column if not exists paid_amount numeric(16,6);  -- 차감 시 유료 소비분(추천버킷 제외). deduction 외 타입은 null.

-- ── deduct_credits: 기존 동작 + 유료 소비분(paid_amount) 기록 ──
create or replace function public.deduct_credits(
  p_user_id       uuid,
  p_job_id        uuid,
  p_api_cost      numeric,
  p_multiplier    numeric,
  p_quota_credits numeric default 0
)
returns numeric
language plpgsql as $$
declare
  v_charge       numeric;
  v_paid         numeric;
  v_promo        numeric;
  v_total_before numeric;
  v_total_after  numeric;
  v_take_paid    numeric;
  v_take_promo   numeric;
  v_rem          numeric;
  v_paid_portion numeric;
  v_deducted     timestamptz;
begin
  -- 멱등: 이미 정산된 job이면 no-op (합계 잔액 반환)
  select deducted_at into v_deducted
    from public.translation_jobs where id = p_job_id for update;
  if v_deducted is not null then
    select balance + referral_balance into v_total_after
      from public.credit_accounts where user_id = p_user_id;
    return v_total_after;
  end if;

  -- 차감액 = Gemini(실비×배수) + quota(units/10)
  v_charge := round(p_api_cost * p_multiplier, 6) + coalesce(p_quota_credits, 0);

  select balance, referral_balance into v_paid, v_promo
    from public.credit_accounts where user_id = p_user_id for update;
  v_total_before := v_paid + v_promo;

  -- 유료(balance) 먼저 소진
  v_take_paid := least(v_charge, greatest(v_paid, 0));
  v_paid := v_paid - v_take_paid;
  v_rem  := v_charge - v_take_paid;

  -- 그다음 추천(referral_balance)
  v_take_promo := least(v_rem, v_promo);
  v_promo := v_promo - v_take_promo;
  v_rem   := v_rem - v_take_promo;

  -- 그래도 남으면 유료 마이너스(오버드래프트)
  v_paid := v_paid - v_rem;

  v_total_after := v_paid + v_promo;

  -- 유료 소비분 = 전체 − 추천버킷 소진분 (오버드래프트도 유료 부채이므로 포함)
  v_paid_portion := v_charge - v_take_promo;

  update public.credit_accounts
     set balance          = v_paid,
         referral_balance  = v_promo,
         cumulative_used   = cumulative_used + p_api_cost,
         updated_at        = now()
   where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, type, amount, paid_amount, balance_before, balance_after, description, job_id)
  values
    (p_user_id, 'deduction', -v_charge, v_paid_portion, v_total_before, v_total_after,
     'Gemini 사용(×' || p_multiplier || ') + quota ' || coalesce(p_quota_credits,0) || '크레딧', p_job_id);

  update public.translation_jobs set deducted_at = now() where id = p_job_id;
  return v_total_after;
end;
$$;

-- ── accrue_referral_rewards: 유료 소비분(paid_amount)만 합산 ──
-- (010 대비 변경점: sum(-ct.amount) → sum(coalesce(ct.paid_amount, -ct.amount)).
--  013 이전 생성된 deduction 행은 paid_amount가 null이라 전액 fallback — 사전 오픈이라 무해.)
create or replace function public.accrue_referral_rewards(p_date date)
returns integer language plpgsql as $$
declare v_count int := 0; rec record; v_amt numeric; v_total_before numeric;
begin
  for rec in
    select u.id as referee_id, u.referred_by as referrer_id,
           coalesce(sum(coalesce(ct.paid_amount, -ct.amount)), 0) as consumed
      from public.users u
      join public.credit_transactions ct
        on ct.user_id = u.id and ct.type = 'deduction'
       and ct.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Seoul')
       and ct.created_at <  ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')
       and ct.created_at >= u.referred_at
     where u.referred_by is not null and u.referred_at is not null
       and p_date < (u.referred_at + interval '12 months')::date
     group by u.id, u.referred_by
     having coalesce(sum(coalesce(ct.paid_amount, -ct.amount)), 0) > 0
  loop
    v_amt := round(rec.consumed * 0.10, 4);

    select balance + referral_balance into v_total_before
      from public.credit_accounts where user_id = rec.referrer_id for update;
    if v_total_before is null then continue; end if;

    begin
      insert into public.referral_rewards(referrer_id, referee_id, reward_date, consumed_krw, amount_krw)
        values (rec.referrer_id, rec.referee_id, p_date, rec.consumed, v_amt);
    exception when unique_violation then continue; end;

    update public.credit_accounts
       set referral_balance = referral_balance + v_amt, updated_at = now()
     where user_id = rec.referrer_id;
    insert into public.credit_transactions(user_id, type, amount, balance_before, balance_after, description)
      values (rec.referrer_id, 'referral_payback', v_amt, v_total_before, v_total_before + v_amt,
              '추천 페이백 10% ('||p_date||')');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
