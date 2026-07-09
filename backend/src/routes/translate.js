import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { INPUT_PER_M, OUTPUT_PER_M, CREDIT_MULTIPLIER, MAX_SUBTITLES, MAX_TARGET_LANGS } from '../lib/constants.js';

const app = new Hono();

const GEMINI_V1BETA = 'https://generativelanguage.googleapis.com/v1beta';

const FALLBACK_CHAIN = [
  { model: 'gemini-2.5-flash', timeoutMs: 25_000, split: false, base: GEMINI_V1BETA },
  { model: 'gemini-2.5-flash', timeoutMs: 18_000, split: true,  base: GEMINI_V1BETA }, // 절반 분할 병렬 재시도
  { model: 'gemini-2.5-flash-lite', timeoutMs: 12_000, split: false, base: GEMINI_V1BETA }, // 경량 모델 최종 시도 (1.5-flash는 서비스 종료)
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
function buildResponseSchema(targetLangs) {
  const properties = {};
  for (const lang of targetLangs) {
    properties[lang] = { type: 'array', items: { type: 'string' } };
  }
  return { type: 'object', properties, required: targetLangs };
}

// 숫자·특수문자·공백 제거 후 언어 문자만 비교
function stripNonLetter(text) {
  return (text || '').replace(/[^\p{L}]/gu, '').toLowerCase();
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
async function callGemini(env, model, subtitles, offset, targetLangs, sourceLang, timeoutMs, base = GEMINI_V1BETA) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = buildPrompt(subtitles, offset, targetLangs, sourceLang);
    const schema = buildResponseSchema(targetLangs);

    const res = await fetch(
      `${base}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
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
            thinkingConfig:   { thinkingBudget: 0 }, // 번역엔 불필요 — thinking 토큰($2.50/M) 비용 차단
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

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error(`[Gemini] ${model} 실패 status=${res.status}`, JSON.stringify(errBody));
      return null;
    }

    const data    = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const usage   = data.usageMetadata || {};

    if (!rawText) {
      console.error(`[Gemini] ${model} 응답 텍스트 없음`, JSON.stringify(data).slice(0, 300));
      return null;
    }

    let json;
    try { json = JSON.parse(rawText); } catch (e) {
      console.error(`[Gemini] ${model} JSON 파싱 실패`, e.message, rawText?.slice(0, 200));
      return null;
    }

    const repairedTranslations = validateAndRepair(json, subtitles, targetLangs);
    const inputTokens  = usage.promptTokenCount || 0;
    // thinking 토큰도 출력 단가로 과금되므로 합산 (thinkingBudget: 0이어도 방어적으로 포함)
    const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);

    // 번역 품질 검증: 단 1줄도 원본과 동일하면 폴백 트리거 (언어 문자 기준 비교)
    // 단, 사용된 토큰은 반환해 과금에 포함 (failed: 'quality' 플래그)
    for (const [lang, lines] of Object.entries(repairedTranslations)) {
      const untranslated = lines.filter((line, i) => {
        const orig = stripNonLetter(subtitles[i]?.text || '');
        if (!orig) return false; // 숫자·기호만 있는 줄은 비교 제외
        return stripNonLetter(line || '') === orig;
      }).length;
      // 고유명사·언어 간 동일 단어는 정상이므로 20% 이상(최소 2줄)일 때만 품질 실패 처리
      const qualityThreshold = Math.max(2, Math.ceil(lines.length * 0.2));
      if (untranslated >= qualityThreshold) {
        console.error(`[Gemini] ${model} [${lang}] 번역 품질 불량: ${untranslated}/${lines.length} 줄이 원본과 동일(언어 문자 기준) → 폴백`);
        return { failed: 'quality', inputTokens, outputTokens };
      }
    }

    return { translations: repairedTranslations, inputTokens, outputTokens };
  } catch (err) {
    clearTimeout(timer);
    console.error('[Gemini] callGemini 예외:', err?.name, err?.message);
    return null;
  }
}

// ── 3-tier 폴백 체인 ──────────────────────────────────────────────────────────
async function translateWithFallback(env, subtitles, offset, targetLangs, sourceLang, preferredModel) {
  // 선호 모델부터 시작
  const startIdx = FALLBACK_CHAIN.findIndex(f => f.model === preferredModel);
  const chain    = startIdx >= 0 ? FALLBACK_CHAIN.slice(startIdx) : FALLBACK_CHAIN;

  let totalInput = 0, totalOutput = 0;

  for (const { model, timeoutMs, split, base } of chain) {
    let result;

    if (split && subtitles.length > 1) {
      const mid      = Math.floor(subtitles.length / 2);
      const [r1, r2] = await Promise.all([
        callGemini(env, model, subtitles.slice(0, mid), offset,       targetLangs, sourceLang, timeoutMs, base),
        callGemini(env, model, subtitles.slice(mid),    offset + mid, targetLangs, sourceLang, timeoutMs, base),
      ]);

      // 토큰 항상 누적 (성공/품질실패 모두)
      if (r1) { totalInput += r1.inputTokens; totalOutput += r1.outputTokens; }
      if (r2) { totalInput += r2.inputTokens; totalOutput += r2.outputTokens; }

      if (r1 && r2 && !r1.failed && !r2.failed) {
        const translations = {};
        for (const lang of targetLangs) {
          translations[lang] = [...r1.translations[lang], ...r2.translations[lang]];
        }
        return { translations, model_used: model, inputTokens: totalInput, outputTokens: totalOutput };
      }
    } else {
      result = await callGemini(env, model, subtitles, offset, targetLangs, sourceLang, timeoutMs, base);
      if (result) {
        totalInput  += result.inputTokens;
        totalOutput += result.outputTokens;
        if (!result.failed) {
          return { translations: result.translations, model_used: model, inputTokens: totalInput, outputTokens: totalOutput };
        }
      }
    }
  }

  // 전부 실패 — 호출부에서 model_used === null 체크 후 504 반환
  return { translations: null, model_used: null, inputTokens: totalInput, outputTokens: totalOutput };
}

// ── POST /translate/chunk ─────────────────────────────────────────────────────
app.post('/chunk', async (c) => {
  const userId = c.get('userId');
  const { job_id, subtitles, offset = 0, target_langs, source_lang = 'auto', model } = await c.req.json();

  // 입력값 검증
  if (!job_id) return c.json({ error: 'MISSING_JOB_ID' }, 400);
  if (!Array.isArray(subtitles) || subtitles.length === 0) return c.json({ error: 'INVALID_SUBTITLES' }, 400);
  if (subtitles.length > MAX_SUBTITLES) return c.json({ error: 'TOO_MANY_SUBTITLES' }, 400);
  if (!Array.isArray(target_langs) || target_langs.length === 0) return c.json({ error: 'INVALID_TARGET_LANGS' }, 400);
  if (target_langs.length > MAX_TARGET_LANGS) return c.json({ error: 'TOO_MANY_LANGS' }, 400);

  const sb = getSupabase(c.env);

  // job 소유권 확인
  const { data: job } = await sb
    .from('translation_jobs')
    .select('id, user_id, status, deducted_at, credits_charged')
    .eq('id', job_id)
    .single();

  if (!job || job.user_id !== userId) {
    return c.json({ error: 'FORBIDDEN' }, 403);
  }

  // 완료/차감된 job으로 재호출 차단 (차감 우회 방지)
  if (job.status !== 'running' || job.deducted_at) {
    return c.json({ error: 'JOB_NOT_ACTIVE' }, 409);
  }

  // 잔액 사전 확인 — 이 job에 누적된 미차감 요금까지 반영 (잔액 소진 후 무한 호출 방지)
  const { data: account } = await sb
    .from('credit_accounts')
    .select('balance')
    .eq('user_id', userId)
    .single();

  if (!account || account.balance <= (job.credits_charged || 0)) {
    return c.json({ error: 'INSUFFICIENT_CREDITS' }, 402);
  }

  // 번역 (폴백 포함)
  const preferredModel = model || c.env.GEMINI_MODEL;
  const { translations, model_used, inputTokens, outputTokens } =
    await translateWithFallback(c.env, subtitles, offset, target_langs, source_lang, preferredModel);

  const apiCostUsd = (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000;

  // 토큰 사용량 기록 (성공/실패 무관 — 과금 기준)
  if (inputTokens > 0 || outputTokens > 0) {
    await sb.rpc('increment_job_tokens', {
      p_job_id:        job_id,
      p_input_tokens:  inputTokens,
      p_output_tokens: outputTokens,
      p_api_cost:      apiCostUsd,
      p_credits:       apiCostUsd * CREDIT_MULTIPLIER,
    }).maybeSingle();
  }

  // 전부 실패 시 504 (토큰은 기록됐으므로 PATCH failed 시 차감됨)
  if (model_used === null) {
    return c.json({ error: 'ALL_FALLBACKS_FAILED' }, 504);
  }

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
  if (!['completed', 'failed', 'stopped'].includes(status)) {
    return c.json({ error: 'INVALID_STATUS' }, 400);
  }

  const sb = getSupabase(c.env);

  // job 소유권 확인
  const { data: job } = await sb
    .from('translation_jobs')
    .select('id, user_id, api_cost_usd, credits_charged, deducted_at')
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

  // 완료/실패/중단 시 크레딧 차감 (idempotency: deducted_at으로 이중 차감 방지)
  if (['completed', 'failed', 'stopped'].includes(status) && job.api_cost_usd > 0 && !job.deducted_at) {
    try {
      await sb.rpc('deduct_credits', {
        p_user_id:    userId,
        p_job_id:     jobId,
        p_api_cost:   job.api_cost_usd,
        p_multiplier: CREDIT_MULTIPLIER,
      });
      await sb
        .from('translation_jobs')
        .update({ deducted_at: new Date().toISOString() })
        .eq('id', jobId);
    } catch (err) {
      console.error('[PATCH] deduct_credits 실패:', err.message, { jobId, userId });
      // 차감 실패는 기록하되 응답은 정상 처리 (재시도 로직 없음 - deducted_at으로 보호)
    }
  }

  return c.json({ ok: true });
});

export default app;
