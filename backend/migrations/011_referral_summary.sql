-- 011: 추천 현황 정확 집계 (기존 GET /referral이 최근 60행만 합산해 과소표기하던 것 교정)
-- total_earned = 전체 적립 합계, referee_count = 내가 추천한 실제 인원수
create or replace function public.referral_summary(p_referrer uuid)
returns table(total_earned numeric, referee_count bigint)
language sql stable as $$
  select
    coalesce((select sum(amount_krw) from public.referral_rewards where referrer_id = p_referrer), 0),
    (select count(*) from public.users where referred_by = p_referrer);
$$;
