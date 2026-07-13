-- 크레딧 단위를 원화(KRW) 1:1로 전환 (2026-07-12)
-- balance/credits_charged = 원화 크레딧. cumulative_used는 실비(USD) 유지 → tier 기준 불변.

-- 1) 컬럼 정밀도 확대 (원화 크레딧은 정수부가 큼: 수만~수십만) + 마이너스 잔액 허용
ALTER TABLE public.credit_accounts   ALTER COLUMN balance TYPE numeric(16, 4);
ALTER TABLE public.credit_accounts   DROP CONSTRAINT IF EXISTS credit_accounts_balance_check; -- overdraft/환불로 음수 가능
ALTER TABLE public.credit_transactions ALTER COLUMN amount         TYPE numeric(16, 4);
ALTER TABLE public.credit_transactions ALTER COLUMN balance_before TYPE numeric(16, 4);
ALTER TABLE public.credit_transactions ALTER COLUMN balance_after  TYPE numeric(16, 4);

-- 2) 기존 USD 잔액/거래이력 → 원화 크레딧 (× 1350). cumulative_used는 그대로 둔다.
UPDATE public.credit_accounts
   SET balance = round(balance * 1350);

UPDATE public.credit_transactions
   SET amount         = round(amount * 1350),
       balance_before = round(balance_before * 1350),
       balance_after  = round(balance_after * 1350);
