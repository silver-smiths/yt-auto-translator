-- 012: deduct_credits에 YouTube quota 과금(p_quota_credits) 추가. 010을 supersede.
-- 차감액 = (Gemini 실비 × 배수) + quota 크레딧(units/10). quota는 길이 무관 고정.
-- p_quota_credits 기본값 0 → 기존 4-인자 호출(POST /job의 미정산 강제정산)도 그대로 동작.
-- 010의 4-인자 버전을 drop해 오버로드 모호성 제거.

drop function if exists public.deduct_credits(uuid, uuid, numeric, numeric);

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

  update public.credit_accounts
     set balance          = v_paid,
         referral_balance  = v_promo,
         cumulative_used   = cumulative_used + p_api_cost,
         updated_at        = now()
   where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, job_id)
  values
    (p_user_id, 'deduction', -v_charge, v_total_before, v_total_after,
     'Gemini 사용(×' || p_multiplier || ') + quota ' || coalesce(p_quota_credits,0) || '크레딧', p_job_id);

  update public.translation_jobs set deducted_at = now() where id = p_job_id;
  return v_total_after;
end;
$$;
