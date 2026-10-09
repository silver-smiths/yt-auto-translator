-- 017: 폴백 단계별 배수 과금. 청구액을 translation_jobs.credits_charged(청크별로 단계 배수가
--      이미 반영돼 누적된 값)에서 읽어 청구한다. (기존: api_cost × 고정배수)
--      → 재시도(2·3단계)일수록 낮은 배수로 청구돼 사용자 비용 폭증 방지. 시그니처는 그대로라
--        기존 호출부(PATCH·미정산 스위퍼)는 수정 불필요. p_multiplier는 레거시(미사용) 유지.

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
  v_charge         numeric;
  v_gemini_credits numeric;
  v_paid           numeric;
  v_promo          numeric;
  v_total_before   numeric;
  v_total_after    numeric;
  v_take_paid      numeric;
  v_take_promo     numeric;
  v_rem            numeric;
  v_paid_portion   numeric;
  v_deducted       timestamptz;
begin
  -- 멱등: 이미 정산된 job이면 no-op (합계 잔액 반환). 동시에 청구 크레딧(credits_charged)도 확보.
  select deducted_at, credits_charged into v_deducted, v_gemini_credits
    from public.translation_jobs where id = p_job_id for update;
  if v_deducted is not null then
    select balance + referral_balance into v_total_after
      from public.credit_accounts where user_id = p_user_id;
    return v_total_after;
  end if;

  -- 차감액 = 단계 배수가 반영된 Gemini 청구(credits_charged) + quota. (p_multiplier는 미사용)
  v_charge := round(coalesce(v_gemini_credits, 0), 6) + coalesce(p_quota_credits, 0);

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
  v_paid_portion := v_charge - v_take_promo; -- 유료 소비분(추천버킷 제외)

  update public.credit_accounts
     set balance          = v_paid,
         referral_balance  = v_promo,
         cumulative_used   = cumulative_used + p_api_cost, -- 실비(USD) 통계는 그대로
         updated_at        = now()
   where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, type, amount, paid_amount, balance_before, balance_after, description, job_id)
  values
    (p_user_id, 'deduction', -v_charge, v_paid_portion, v_total_before, v_total_after,
     'Gemini 번역(단계 배수) + quota ' || coalesce(p_quota_credits,0) || '크레딧', p_job_id);

  update public.translation_jobs set deducted_at = now() where id = p_job_id;
  return v_total_after;
end;
$$;
