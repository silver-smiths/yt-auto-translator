import { translateWithFallback } from '../lib/providers/index.js';
import { getSupabase } from '../lib/supabase.js';
import { verifyGoogleToken } from '../lib/auth.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// 언어 수 기반 동적 청크 크기 (Extension 참고용 — Worker는 단일 청크만 처리)
export function getChunkSize(langCount) {
  if (langCount <= 3)  return 150;
  if (langCount <= 8)  return 100;
  if (langCount <= 15) return 80;
  return 60;
}

// ── POST /translate/job ───────────────────────────────────────────────────────
export async function handleTranslateJob(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { video_id, source_lang, target_langs, model } = await request.json();
  if (!video_id || !target_langs?.length) return json({ error: 'Missing fields' }, 400);

  const db = getSupabase(env);

  // 잔액 사전 확인
  const { data: account } = await db
    .from('credit_accounts')
    .select('balance')
    .eq('user_id', user.id)
    .single();

  if (!account || account.balance <= 0) return json({ error: 'Insufficient credits' }, 402);

  const { data: job, error } = await db
    .from('translation_jobs')
    .insert({
      user_id: user.id,
      video_id,
      source_lang,
      target_langs,
      model: model || 'gemini-2.5-flash',
      status: 'running',
      job_type: 'subtitles',
    })
    .select('id, status')
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ job_id: job.id, status: job.status }, 201);
}

// ── POST /translate/chunk ─────────────────────────────────────────────────────
export async function handleTranslateChunk(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { job_id, subtitles, offset = 0, target_langs, source_lang, model } = await request.json();

  if (!job_id || !subtitles?.length || !target_langs?.length) {
    return json({ error: 'Missing fields' }, 400);
  }

  const db = getSupabase(env);

  // job 소유권 확인
  const { data: job } = await db
    .from('translation_jobs')
    .select('id, user_id, status, model')
    .eq('id', job_id)
    .single();

  if (!job || job.user_id !== user.id) return json({ error: 'Forbidden' }, 403);
  if (job.status === 'stopped') return json({ error: 'Job stopped' }, 409);

  // 번역 (폴백 포함)
  const { translations, modelUsed, tokens, allFailed } = await translateWithFallback({
    subtitles,
    offset,
    targetLangs: target_langs,
    sourceLang: source_lang,
    model: model || job.model || 'gemini-2.5-flash',
    env,
  });

  // 토큰 누적 (Supabase RPC)
  if (tokens.input > 0 || tokens.output > 0) {
    const apiCost = calcApiCost(tokens, modelUsed);
    const { data: account } = await db
      .from('credit_accounts')
      .select('multiplier:tier')
      .eq('user_id', user.id)
      .single();

    const multiplier = tierToMultiplier(account?.multiplier);
    const credits = apiCost * multiplier;

    await db.rpc('increment_job_tokens', {
      p_job_id:        job_id,
      p_input_tokens:  tokens.input,
      p_output_tokens: tokens.output,
      p_api_cost:      apiCost,
      p_credits:       credits,
    });
  }

  return json({ translations, model_used: modelUsed, tokens, all_failed: allFailed ?? false });
}

// ── PATCH /translate/job/:id ──────────────────────────────────────────────────
export async function handleTranslateJobPatch(request, env, jobId) {
  const user = await verifyGoogleToken(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { status, error_message } = await request.json();
  const db = getSupabase(env);

  const { data: job } = await db
    .from('translation_jobs')
    .select('id, user_id')
    .eq('id', jobId)
    .single();

  if (!job || job.user_id !== user.id) return json({ error: 'Forbidden' }, 403);

  // job 상태 업데이트
  await db
    .from('translation_jobs')
    .update({
      status,
      error_message: error_message || null,
      completed_at: ['completed', 'failed', 'stopped'].includes(status) ? new Date().toISOString() : null,
    })
    .eq('id', jobId);

  // 크레딧 정산 (완료 / 실패 / 중단 모두 사용량만큼 차감)
  const { data: jobData } = await db
    .from('translation_jobs')
    .select('api_cost_usd, multiplier, credits_charged')
    .eq('id', jobId)
    .single();

  let creditsRemaining = null;
  if (jobData?.credits_charged > 0) {
    const { data } = await db.rpc('deduct_credits', {
      p_user_id:    user.id,
      p_job_id:     jobId,
      p_api_cost:   jobData.api_cost_usd,
      p_multiplier: jobData.multiplier,
    });
    creditsRemaining = data;
  }

  return json({ status, credits_charged: jobData?.credits_charged ?? 0, credits_remaining: creditsRemaining });
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

// 모델별 API 단가 (USD per 1M tokens)
const MODEL_PRICING = {
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash':      { input: 0.10, output: 0.40 },
  'gpt-4o-mini':           { input: 0.15, output: 0.60 },
};

function calcApiCost(tokens, model) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['gemini-2.5-flash'];
  return (tokens.input * pricing.input + tokens.output * pricing.output) / 1_000_000;
}

// 티어 문자열 → 배율 (credit_accounts.tier 컬럼)
function tierToMultiplier(tier) {
  if (tier === 'heavy')    return 1.1;
  if (tier === 'standard') return 1.2;
  return 1.3; // light (기본)
}
