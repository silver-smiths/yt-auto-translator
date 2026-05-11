import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const app = new Hono();

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta';
const INPUT_PER_M  = 0.075;
const OUTPUT_PER_M = 0.30;

// 3-tier 폴백 체인
const FALLBACK_CHAIN = [
  { model: 'gemini-2.5-flash',      timeoutMs: 90_000, split: false },
  { model: 'gemini-2.5-flash-lite', timeoutMs: 60_000, split: true  },
  { model: 'gemini-2.0-flash',      timeoutMs: 60_000, split: false },
];

// ── 프롬프트 빌드 ──────────────────────────────────────────────────────────────
function buildPrompt(subtitles, offset, targetLangs, sourceLang) {
  const lines    = subtitles.map((s, i) => `[${offset + i}] ${s.text}`).join('\n');
  const langList = targetLangs.join(', ');
  return (
    `Translate the following ${subtitles.length} subtitle lines from ${sourceLang} into: ${langList}.\n` +
    `Return a JSON object with language codes as keys and arrays of translated strings as values.\n` +
    `Each array must have EXACTLY ${subtitles.length} elements in the same order as the input.\n` +
    `Do NOT include the [ID] prefix in the output strings.\n\n` +
    lines
  );
}

// ── responseSchema 빌드 ────────────────────────────────────────────────────────
function buildResponseSchema(targetLangs, count) {
  const properties = {};
  for (const lang of targetLangs) {
    properties[lang] = { type: 'array', items: { type: 'string' } };
  }
  return { type: 'object', properties, required: targetLangs };
}

// ── 배열 길이 검증 + 원본으로 보정 ───────────────────────────────────────────
function validateAndRepair(json, subtitles, targetLangs) {
  const result = {};
  for (const lang of targetLangs) {
    const arr = json?.[lang];
    if (Array.isArray(arr) && arr.length === subtitles.length) {
      result[lang] = arr;
    } else if (Array.isArray(arr)) {
      result[lang] = subtitles.map((s, i) => arr[i] ?? s.text);
    } else {
      result[lang] = subtitles.map(s => s.text);
    }
  }
  return result;
}

// ── 단일 Gemini 호출 (JSON structured output) ──────────────────────────────────
async function callGemini(env, model, subtitles, offset, targetLangs, sourceLang, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = buildPrompt(subtitles, offset, targetLangs, sourceLang);
    const schema = buildResponseSchema(targetLangs, subtitles.length);

    const res = await fetch(
      `${GEMINI_BASE}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text:
              'You are a professional subtitle translator. ' +
              'Return ONLY valid JSON matching the given schema. ' +
              'Translate every single line. Never skip, merge, or deduplicate lines.'
            }]
          },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature:      0.2,
            maxOutputTokens:  65536,
            responseMimeType: 'application/json',
            responseSchema:   schema,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        }),
      }
    );

    clearTimeout(timer);

    if (!res.ok) return null;

    const data    = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const usage   = data.usageMetadata || {};

    let json;
    try { json = JSON.parse(rawText); } catch { return null; }

    return {
      translations: validateAndRepair(json, subtitles, targetLangs),
      inputTokens:  usage.promptTokenCount     || 0,
      outputTokens: usage.candidatesTokenCount || 0,
    };
  } catch {
    clearTimeout(timer);
    return null; // timeout or network error
  }
}

// ── 3-tier 폴백 체인 ──────────────────────────────────────────────────────────
async function translateWithFallback(env, subtitles, offset, targetLangs, sourceLang, preferredModel) {
  // 선호 모델부터 시작
  const startIdx = FALLBACK_CHAIN.findIndex(f => f.model === preferredModel);
  const chain    = startIdx >= 0 ? FALLBACK_CHAIN.slice(startIdx) : FALLBACK_CHAIN;

  let totalInput = 0, totalOutput = 0;

  for (const { model, timeoutMs, split } of chain) {
    let result;

    if (split && subtitles.length > 1) {
      // 청크 절반 분할 → 병렬 호출
      const mid      = Math.floor(subtitles.length / 2);
      const [r1, r2] = await Promise.all([
        callGemini(env, model, subtitles.slice(0, mid), offset,       targetLangs, sourceLang, timeoutMs),
        callGemini(env, model, subtitles.slice(mid),    offset + mid, targetLangs, sourceLang, timeoutMs),
      ]);

      if (r1 && r2) {
        const translations = {};
        for (const lang of targetLangs) {
          translations[lang] = [...r1.translations[lang], ...r2.translations[lang]];
        }
        totalInput  += r1.inputTokens  + r2.inputTokens;
        totalOutput += r1.outputTokens + r2.outputTokens;
        return { translations, model_used: model, inputTokens: totalInput, outputTokens: totalOutput };
      }
    } else {
      result = await callGemini(env, model, subtitles, offset, targetLangs, sourceLang, timeoutMs);
      if (result) {
        totalInput  += result.inputTokens;
        totalOutput += result.outputTokens;
        return { translations: result.translations, model_used: model, inputTokens: totalInput, outputTokens: totalOutput };
      }
    }
  }

  // 전부 실패 → 원본 텍스트 유지
  const translations = {};
  for (const lang of targetLangs) {
    translations[lang] = subtitles.map(s => s.text);
  }
  return { translations, model_used: null, inputTokens: totalInput, outputTokens: totalOutput };
}

// ── POST /translate/chunk ─────────────────────────────────────────────────────
app.post('/chunk', async (c) => {
  const userId = c.get('userId');
  const {
    job_id,
    subtitles,
    offset      = 0,
    target_langs,
    source_lang = 'auto',
    model,
  } = await c.req.json();

  const sb = getSupabase(c.env);

  // job 소유권 확인
  const { data: job } = await sb
    .from('translation_jobs')
    .select('id, user_id')
    .eq('id', job_id)
    .single();

  if (!job || job.user_id !== userId) {
    return c.json({ error: 'FORBIDDEN' }, 403);
  }

  // 잔액 사전 확인 (빠른 실패)
  const { data: account } = await sb
    .from('credit_accounts')
    .select('balance, tier')
    .eq('user_id', userId)
    .single();

  if (!account || account.balance <= 0) {
    return c.json({ error: 'INSUFFICIENT_CREDITS' }, 402);
  }

  // 번역 (폴백 포함)
  const preferredModel = model || c.env.GEMINI_MODEL;
  const { translations, model_used, inputTokens, outputTokens } =
    await translateWithFallback(c.env, subtitles, offset, target_langs, source_lang, preferredModel);

  // 전부 실패 시 504
  if (model_used === null && inputTokens === 0) {
    return c.json({ error: 'ALL_FALLBACKS_FAILED' }, 504);
  }

  // 토큰 누적 (크레딧 차감은 job 완료 시 PATCH /translate/job/:id 에서 처리)
  const multiplier = account.tier === 'heavy' ? 1.1 : account.tier === 'standard' ? 1.2 : 1.3;
  const apiCostUsd = (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000;

  await sb.rpc('increment_job_tokens', {
    p_job_id:        job_id,
    p_input_tokens:  inputTokens,
    p_output_tokens: outputTokens,
    p_api_cost:      apiCostUsd,
    p_credits:       apiCostUsd * multiplier,
  }).maybeSingle();

  return c.json({
    translations,
    model_used,
    tokens: { input: inputTokens, output: outputTokens },
  });
});

// ── POST /translate/job ───────────────────────────────────────────────────────
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
      status: 'running',
    })
    .select('id')
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({ job_id: data.id });
});

// ── PATCH /translate/job/:id ──────────────────────────────────────────────────
app.patch('/job/:id', async (c) => {
  const userId = c.get('userId');
  const jobId  = c.req.param('id');
  const { status, error_message } = await c.req.json();

  const sb = getSupabase(c.env);

  // job 소유권 확인
  const { data: job } = await sb
    .from('translation_jobs')
    .select('id, user_id, api_cost_usd, credits_charged')
    .eq('id', jobId)
    .single();

  if (!job || job.user_id !== userId) {
    return c.json({ error: 'FORBIDDEN' }, 403);
  }

  await sb
    .from('translation_jobs')
    .update({
      status,
      error_message: error_message || null,
      completed_at: ['completed', 'failed', 'stopped'].includes(status)
        ? new Date().toISOString() : null,
    })
    .eq('id', jobId);

  // job 완료 시 크레딧 차감
  if (status === 'completed' && job.api_cost_usd > 0) {
    const { data: account } = await sb
      .from('credit_accounts')
      .select('tier')
      .eq('user_id', userId)
      .single();

    const multiplier = account?.tier === 'heavy' ? 1.1 : account?.tier === 'standard' ? 1.2 : 1.3;

    await sb.rpc('deduct_credits', {
      p_user_id:    userId,
      p_job_id:     jobId,
      p_api_cost:   job.api_cost_usd,
      p_multiplier: multiplier,
    });
  }

  return c.json({ ok: true });
});

export default app;
