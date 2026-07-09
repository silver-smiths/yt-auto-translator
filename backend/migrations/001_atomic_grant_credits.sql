-- 결제 완료 시 크레딧 지급 + 결제 상태 업데이트를 하나의 트랜잭션으로 처리
-- 웹훅 중복 호출에도 payments.status 체크로 멱등성 보장
-- (2026-07-09 수정: credit_transactions 스키마와 정합 — type='topup', balance_before 포함, cumulative_paid 제거)

DROP FUNCTION IF EXISTS grant_credits(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION grant_credits(
  p_user_id    UUID,
  p_payment_id UUID,
  p_amount_usd NUMERIC
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_status     TEXT;
  v_bal_before NUMERIC;
  v_bal_after  NUMERIC;
BEGIN
  -- 이미 처리된 결제면 조용히 종료 (멱등성)
  SELECT status INTO v_status FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF v_status IS NULL OR v_status = 'completed' THEN
    RETURN;
  END IF;

  -- 결제 상태 완료로 변경
  UPDATE payments
  SET status = 'completed', updated_at = NOW()
  WHERE id = p_payment_id AND status = 'pending';

  -- 크레딧 잔액 증가
  SELECT balance INTO v_bal_before
    FROM credit_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

  v_bal_after := v_bal_before + p_amount_usd;

  UPDATE credit_accounts
  SET balance = v_bal_after, updated_at = NOW()
  WHERE user_id = p_user_id;

  -- 거래 이력 기록 (credit_transactions 제약: type in ('topup','deduction','refund'))
  INSERT INTO credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, payment_id)
  VALUES
    (p_user_id, 'topup', p_amount_usd, v_bal_before, v_bal_after,
     '결제 완료 크레딧 충전', p_payment_id);
END;
$$;
