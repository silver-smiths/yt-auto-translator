-- 유료 크레딧 우선 소진: 유료(balance)/추천(referral_balance) 2버킷 분리
-- 소진 순서: 유료 먼저 → 추천 → 그래도 부족하면 유료를 마이너스(오버드래프트=부채).
-- 추천 크레딧은 음수가 되지 않음. 잔액 검사·표시는 합계(balance + referral_balance).
-- 006(deduct_credits)·009(accrue_referral_rewards)를 supersede. 006·009 실행 후 이 파일 실행.

alter table public.credit_accounts
  add column if not exists referral_balance numeric(16,4) not null default 0;

-- ── deduct_credits: 유료 우선 소진 (job 멱등 유지) ──
create or replace function public.deduct_credits(
  p_user_id    uuid,
  p_job_id     uuid,
  p_api_cost   numeric,
  p_multiplier numeric
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

  v_charge := round(p_api_cost * p_multiplier, 6);

  select balance, referral_balance into v_paid, v_promo
    from public.credit_accounts where user_id = p_user_id for update;
  v_total_before := v_paid + v_promo;

  -- 1) 유료(balance)의 양수분 먼저 소진
  v_take_paid := least(v_charge, greatest(v_paid, 0));
  v_paid := v_paid - v_take_paid;
  v_rem  := v_charge - v_take_paid;

  -- 2) 남으면 추천(referral_balance) 소진 (음수 안 됨)
  v_take_promo := least(v_rem, v_promo);
  v_promo := v_promo - v_take_promo;
  v_rem   := v_rem - v_take_promo;

  -- 3) 그래도 남으면 유료 잔액을 마이너스로 (오버드래프트 = 부채, 다음 충전 시 상쇄)
  v_paid := v_paid - v_rem;

  v_total_after := v_paid + v_promo;

  update public.credit_accounts
     set balance         = v_paid,
         referral_balance = v_promo,
         cumulative_used  = cumulative_used + p_api_cost,
         updated_at       = now()
   where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, job_id)
  values
    (p_user_id, 'deduction', -v_charge, v_total_before, v_total_after,
     'Gemini API 사용 (×' || p_multiplier || ')', p_job_id);

  update public.translation_jobs set deducted_at = now() where id = p_job_id;
  return v_total_after;
end;
$$;

-- ── accrue_referral_rewards: 적립을 referral_balance(추천 버킷)로 ──
-- (009 대비 변경점만: balance → referral_balance, before/after = 합계. 창/하한 로직은 009 그대로)
create or replace function public.accrue_referral_rewards(p_date date)
returns integer language plpgsql as $$
declare v_count int := 0; rec record; v_amt numeric; v_total_before numeric;
begin
  for rec in
    select u.id as referee_id, u.referred_by as referrer_id,
           coalesce(sum(-ct.amount), 0) as consumed
      from public.users u
      join public.credit_transactions ct
        on ct.user_id = u.id and ct.type = 'deduction'
       and ct.created_at >= p_date::timestamptz
       and ct.created_at <  (p_date + 1)::timestamptz
     where u.referred_by is not null and u.referred_at is not null
       and p_date < (u.referred_at + interval '12 months')::date
     group by u.id, u.referred_by
     having coalesce(sum(-ct.amount), 0) > 0
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
