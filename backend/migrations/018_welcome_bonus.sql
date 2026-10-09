-- 신규 가입 웰컴 무료체험 크레딧 — 계정당 1회만 지급 (멱등)
-- credit_accounts.welcome_bonus_claimed 플래그로 재설치·재클릭 시 중복 지급 차단.
-- credit_transactions.type 제약(009 이후: topup/deduction/refund/referral_payback)에 맞춰 type='topup'으로 기록.

ALTER TABLE public.credit_accounts
  ADD COLUMN IF NOT EXISTS welcome_bonus_claimed BOOLEAN NOT NULL DEFAULT FALSE;

DROP FUNCTION IF EXISTS claim_welcome_bonus(uuid, numeric);

-- 반환: 실제 지급된 크레딧 (이미 받은 계정이면 0)
CREATE OR REPLACE FUNCTION claim_welcome_bonus(
  p_user_id UUID,
  p_amount  NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_claimed    BOOLEAN;
  v_bal_before NUMERIC;
  v_bal_after  NUMERIC;
BEGIN
  -- 계정 잠금 후 중복 지급 여부 확인 (동시 호출에도 1회 보장)
  SELECT welcome_bonus_claimed, balance
    INTO v_claimed, v_bal_before
    FROM credit_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

  IF v_claimed IS NULL THEN
    RETURN 0; -- 계정 없음 (정상 흐름에선 auth가 선생성)
  END IF;

  IF v_claimed THEN
    RETURN 0; -- 이미 받음
  END IF;

  v_bal_after := v_bal_before + p_amount;

  UPDATE credit_accounts
     SET balance = v_bal_after,
         welcome_bonus_claimed = TRUE,
         updated_at = NOW()
   WHERE user_id = p_user_id;

  INSERT INTO credit_transactions
    (user_id, type, amount, balance_before, balance_after, description)
  VALUES
    (p_user_id, 'topup', p_amount, v_bal_before, v_bal_after, '🎁 무료체험 크레딧');

  RETURN p_amount;
END;
$$;
