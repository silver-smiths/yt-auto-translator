import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const app = new Hono();

const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta';
const INPUT_PER_M   = 0.075;
const OUTPUT_PER_M  = 0.30;

/**
 * POST /translate/chunk
 * 익스텐션이 청크 단위로 자막을 보내면 Gemini로 번역 후 반환
 * 크레딧 차감은 청크 완료 후 즉시 처리
 */
app.post('/chunk', async (c) => {
  const userId = c.get('userId');
  const {
    job_id,       // translation_jobs.id (익스텐션이 사전에 생성)
    model,
    prompt,
    target_lang
  } = await c.req.json();

  // ── 잔액 사전 확인 (빠른 실패) ───────────────────────
  const sb = getSupabase(c.env);
  const { data: account } = await sb
    .from('credit_accounts')
    .select('balance, tier')
    .eq('user_id', userId)
    .single();

  if (!account || account.balance <= 0) {
    return c.json({ error: 'INSUFFICIENT_CREDITS' }, 402);
  }

  const multiplier = account.tier === 'heavy' ? 1.1
                   : account.tier === 'standard' ? 1.2 : 1.3;

  // ── Gemini API 호출 ──────────────────────────────────
  const geminiRes = await fetch(
    `${GEMINI_BASE}/models/${model || c.env.GEMINI_MODEL}:generateContent?key=${c.env.GEMINI_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text:
            `You are a professional subtitle translator. ` +
            `Translate into ${target_lang}. ` +
            `Return ONLY lines in [ID] Text format. ` +
            `NEVER collapse, deduplicate, merge, or skip any lines.`
          }]
        },
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 65536 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      })
    }
  );

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    return c.json({ error: 'GEMINI_ERROR', detail: err }, 502);
  }

  const data         = await geminiRes.json();
  const text         = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data.candidates?.[0]?.finishReason;
  const usage        = data.usageMetadata || {};

  const inputTokens  = usage.promptTokenCount     || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const apiCostUsd   = (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000;

  // ── 크레딧 차감 (원자적 — Supabase RPC) ─────────────
  const { error: deductError } = await sb.rpc('deduct_credits', {
    p_user_id:    userId,
    p_job_id:     job_id,
    p_api_cost:   apiCostUsd,
    p_multiplier: multiplier
  });

  if (deductError) {
    const isInsufficient = deductError.message?.includes('INSUFFICIENT_CREDITS');
    return c.json(
      { error: isInsufficient ? 'INSUFFICIENT_CREDITS' : 'DEDUCT_ERROR', detail: deductError.message },
      isInsufficient ? 402 : 500
    );
  }

  // ── translation_jobs 사용량 누적 ─────────────────────
  await sb.rpc('increment_job_tokens', {
    p_job_id:        job_id,
    p_input_tokens:  inputTokens,
    p_output_tokens: outputTokens,
    p_api_cost:      apiCostUsd,
    p_credits:       apiCostUsd * multiplier
  }).maybeSingle();

  return c.json({
    text,
    finish_reason:  finishReason,
    input_tokens:   inputTokens,
    output_tokens:  outputTokens,
    api_cost_usd:   apiCostUsd,
    credits_charged: parseFloat((apiCostUsd * multiplier).toFixed(6))
  });
});

/**
 * POST /translate/job
 * 번역 작업 레코드 생성 (번역 시작 전 호출)
 */
app.post('/job', async (c) => {
  const userId = c.get('userId');
  const { video_id, job_type, source_lang, target_langs, model } = await c.req.json();

  const sb = getSupabase(c.env);
  const { data, error } = await sb
    .from('translation_jobs')
    .insert({
      user_id:      userId,
      video_id,
      job_type:     job_type || 'subtitles',
      source_lang,
      target_langs: target_langs || [],
      model,
      status: 'running'
    })
    .select('id')
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({ job_id: data.id });
});

/**
 * PATCH /translate/job/:id
 * 번역 완료/실패 상태 업데이트
 */
app.patch('/job/:id', async (c) => {
  const userId = c.get('userId');
  const jobId  = c.req.param('id');
  const { status, error_message } = await c.req.json();

  const sb = getSupabase(c.env);
  await sb
    .from('translation_jobs')
    .update({
      status,
      error_message: error_message || null,
      completed_at:  ['completed', 'failed', 'stopped'].includes(status)
        ? new Date().toISOString() : null
    })
    .eq('id', jobId)
    .eq('user_id', userId);

  return c.json({ ok: true });
});

export default app;
