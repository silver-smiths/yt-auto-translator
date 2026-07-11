-- 결제 취소 시 크레딧 회수 + 결제 상태 refunded 처리를 하나의 트랜잭션으로
-- 웹훅 중복 호출에도 payments.status 체크로 멱등성 보장

CREATE OR REPLACE FUNCTION refund_credits(
  p_user_id    UUID,
  p_payment_id UUID,
  p_amount_usd NUMERIC
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
  v_before NUMERIC;
BEGIN
  -- 이미 환불 처리된 결제면 조용히 종료 (멱등성)
  SELECT status INTO v_status FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF v_status IS NULL OR v_status = 'refunded' THEN
    RETURN;
  END IF;

  UPDATE payments
  SET status = 'refunded', updated_at = NOW()
  WHERE id = p_payment_id;

  -- 크레딧 회수 (마이너스 잔액 허용 — 이미 사용한 경우 부채로 기록)
  SELECT balance INTO v_before
    FROM credit_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

  UPDATE credit_accounts
  SET balance = balance - p_amount_usd, updated_at = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions
    (user_id, type, amount, balance_before, balance_after, description, payment_id)
  VALUES
    (p_user_id, 'refund', -p_amount_usd,
     v_before, v_before - p_amount_usd,
     '결제 취소 크레딧 회수', p_payment_id);
END;
$$;
