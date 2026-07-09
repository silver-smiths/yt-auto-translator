-- deduct_credits: 잔액 부족 시 예외 대신 마이너스 잔액 허용
-- (기존: 잔액 < 청구액이면 raise exception → 차감 전체 실패 → 무료 번역이 되는 버그)
-- 초과분은 부채로 기록되고 다음 충전 시 자연 상쇄됨.
-- 최대 부채는 백엔드의 OVERDRAFT_USD($2) + job 생성 시 잔액>0 검사로 상한 제한.

CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id    uuid,
  p_job_id     uuid,
  p_api_cost   numeric,   -- 실제 Gemini 비용 (USD)
  p_multiplier numeric    -- 티어 배율
)
RETURNS numeric           -- 차감 후 잔액 반환
LANGUAGE plpgsql AS $$
DECLARE
  v_charge     numeric;
  v_bal_before numeric;
  v_bal_after  numeric;
BEGIN
  v_charge := round(p_api_cost * p_multiplier, 6);

  -- 잔액 잠금 (동시 요청 방지)
  SELECT balance INTO v_bal_before
    FROM public.credit_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

  -- 잔액 부족이어도 차감 진행 (마이너스 허용 — 시작된 작업 마무리 정책)
  v_bal_after := v_bal_before - v_charge;

  UPDATE public.credit_accounts
     SET balance         = v_bal_after,
         cumulative_used = cumulative_used + p_api_cost
   WHERE user_id = p_user_id;

  INSERT INTO public.credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, job_id)
  VALUES
    (p_user_id, 'deduction', -v_charge, v_bal_before, v_bal_after,
     'Gemini API 사용 (×' || p_multiplier || ')', p_job_id);

  RETURN v_bal_after;
END;
$$;
