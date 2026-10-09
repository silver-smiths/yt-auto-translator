-- 014: payments.pg_provider CHECK 제약이 옛 결제사('toss','stripe')만 허용해
-- 실제 사용하는 'kakaopay'(KRW)·'manual'(USD 계좌송금)이 거부됨 → /credits/checkout 500
-- (CHECKOUT_FAILED_500). 제약을 현재 결제수단에 맞게 교체. 데이터 변경 없음.

do $$ declare r record; begin
  for r in select conname from pg_constraint
           where conrelid = 'public.payments'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%pg_provider%'
  loop execute 'alter table public.payments drop constraint ' || quote_ident(r.conname); end loop;
end $$;

alter table public.payments
  add constraint payments_pg_provider_check
  check (pg_provider in ('toss', 'stripe', 'kakaopay', 'manual', 'kcp'));
