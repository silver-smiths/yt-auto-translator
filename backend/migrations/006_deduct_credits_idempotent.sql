-- deduct_credits 멱등화: job 행을 잠그고 deducted_at를 RPC 내부에서 확인·설정
-- (기존 002는 잔액만 FOR UPDATE → 동시 PATCH 2건이 각각 deduct 호출 시 이중 차감 발생)
-- 이후 동일 job에 대한 중복 호출은 no-op으로 현재 잔액만 반환.
-- 002를 대체(같은 시그니처)하므로 002 실행 후 이 파일을 실행하면 됩니다.

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
  v_deducted   timestamptz;
BEGIN
  -- 1) job 행을 잠그고 이미 정산됐는지 확인 (동시 PATCH 이중 차감 방지)
  SELECT deducted_at INTO v_deducted
    FROM public.translation_jobs
   WHERE id = p_job_id
     FOR UPDATE;

  IF v_deducted IS NOT NULL THEN
    -- 이미 차감됨 → no-op, 현재 잔액만 반환 (멱등)
    SELECT balance INTO v_bal_after
      FROM public.credit_accounts
     WHERE user_id = p_user_id;
    RETURN v_bal_after;
  END IF;

  v_charge := round(p_api_cost * p_multiplier, 6);

  -- 2) 잔액 잠금 후 차감 (마이너스 허용 — 시작된 작업 마무리 정책, 002와 동일)
  SELECT balance INTO v_bal_before
    FROM public.credit_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

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

  -- 3) 차감과 동일 트랜잭션에서 정산 마킹 (원자적) → 이후 중복 호출은 1)에서 no-op
  UPDATE public.translation_jobs
     SET deducted_at = now()
   WHERE id = p_job_id;

  RETURN v_bal_after;
END;
$$;
