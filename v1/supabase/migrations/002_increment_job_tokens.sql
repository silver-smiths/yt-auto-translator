-- translation_jobs 토큰/비용 누적 함수
-- translate.js에서 청크 완료 시마다 호출
create or replace function public.increment_job_tokens(
  p_job_id        uuid,
  p_input_tokens  integer,
  p_output_tokens integer,
  p_api_cost      numeric,
  p_credits       numeric
)
returns void language plpgsql as $$
begin
  update public.translation_jobs
     set input_tokens     = input_tokens  + p_input_tokens,
         output_tokens    = output_tokens + p_output_tokens,
         api_cost_usd     = api_cost_usd  + p_api_cost,
         credits_charged  = credits_charged + p_credits
   where id = p_job_id;
end;
$$;
