-- 015: payments.pg_provider CHECK에 'paypal' 추가 (외국인 결제 수단).
-- 014를 이어받아 목록에 paypal만 추가. 데이터 변경 없음.

do $$ declare r record; begin
  for r in select conname from pg_constraint
           where conrelid = 'public.payments'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%pg_provider%'
  loop execute 'alter table public.payments drop constraint ' || quote_ident(r.conname); end loop;
end $$;

alter table public.payments
  add constraint payments_pg_provider_check
  check (pg_provider in ('toss', 'stripe', 'kakaopay', 'manual', 'kcp', 'paypal'));
