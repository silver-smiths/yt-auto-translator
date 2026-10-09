import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { INPUT_PER_M, OUTPUT_PER_M, CREDIT_PER_USD, MAX_SUBTITLES, MAX_TARGET_LANGS, OVERDRAFT_CREDITS, UNITS_PER_CREDIT } from '../lib/constants.js';
import { notifyError } from '../lib/errors.js';

const app = new Hono();

const GEMINI_V1BETA = 'https://generativelanguage.googleapis.com/v1beta';

// 폴백 단계별 크레딧 배수 계수 (기본 배수 20배 대비): 1단계=20배(×1), 2단계=10배(×0.5), 3단계=5배(×0.25).
// 재시도가 필요할수록 낮은 배수로 청구해 사용자 비용 폭증을 막고, 재시도 비용은 회사가 흡수.
// 청크 전체 실패(tier 없음)는 결과물이 없으므로 0 → 과금하지 않음.
const TIER_FACTOR = { 1: 1, 2: 0.5, 3: 0.25 };

// 타임아웃 상향 — 성공콜 median이 ~19s라 25s는 여유가 없어 레이턴시 스파이크에서 잘림.
// 릴레이(US Vercel)가 40s+를 허용하므로, 느리지만 유효한 생성이 끊기지 않게 넉넉히 준다.
const FALLBACK_CHAIN = [
  { model: 'gemini-2.5-flash', timeoutMs: 45_000, split: false, base: GEMINI_V1BETA },
  { model: 'gemini-2.5-flash', timeoutMs: 30_000, split: true,  base: GEMINI_V1BETA }, // 절반 분할 병렬 재시도
  { model: 'gemini-2.5-flash-lite', timeoutMs: 20_000, split: false, base: GEMINI_V1BETA }, // 경량 모델 최종 시도
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
  const prompt = buildPrompt(subtitles, offset, targetLangs, sourceLang);
  const schema = buildResponseSchema(targetLangs);

  const geminiPayload = {
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
  };

  // 429(사용량 한도)·5xx(일시 서버오류)는 폴백 체인이 같은 키를 쓰므로 못 벗어난다 → 여기서 백오프 후 1회 재시도.
  // 타임아웃/네트워크는 폴백·클라이언트 재시도에 맡긴다. 실패 시 원인(reason)을 실어 반환해 진단 가능하게.
  const RETRYABLE = new Set([429, 500, 502, 503]);
  let lastReason = 'unknown';

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Cloudflare Workers는 홍콩 콜로로 라우팅될 수 있어 Gemini가 지역 차단(400)함.
      // GEMINI_RELAY_URL(미국 리전 고정 Vercel 함수)이 설정되면 그쪽을 경유한다.
      const res = env.GEMINI_RELAY_URL
        ? await fetch(env.GEMINI_RELAY_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-relay-secret': env.GEMINI_RELAY_SECRET || '' },
            signal:  controller.signal,
            body: JSON.stringify({ model, base, payload: geminiPayload }),
          })
        : await fetch(`${base}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  controller.signal,
            body: JSON.stringify(geminiPayload),
          });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastReason = res.status === 429 ? 'rate_limit' : `http_${res.status}`;
        console.error(`[Gemini] ${model} 실패 status=${res.status}`, errText.slice(0, 200));
        if (RETRYABLE.has(res.status) && attempt === 0) {
          const ra = Number(res.headers.get('retry-after')) || 3;
          await new Promise(r => setTimeout(r, Math.min(ra, 6) * 1000)); // 백오프 후 1회 재시도
          continue;
        }
        return { failed: lastReason, inputTokens: 0, outputTokens: 0 };
      }

      const data    = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      const usage   = data.usageMetadata || {};

      if (!rawText) {
        console.error(`[Gemini] ${model} 응답 텍스트 없음`, JSON.stringify(data).slice(0, 300));
        return { failed: 'empty', inputTokens: 0, outputTokens: 0 };
      }

      let json;
      try { json = JSON.parse(rawText); } catch (e) {
        console.error(`[Gemini] ${model} JSON 파싱 실패`, e.message, rawText?.slice(0, 200));
        return { failed: 'parse', inputTokens: 0, outputTokens: 0 };
      }

      const repairedTranslations = validateAndRepair(json, subtitles, targetLangs);
      const inputTokens  = usage.promptTokenCount || 0;
      // thinking 토큰도 출력 단가로 과금되므로 합산 (thinkingBudget: 0이어도 방어적으로 포함)
      const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);

      // 번역 품질 검증: "모델이 사실상 번역을 안 하고 원문을 그대로 반환한 경우"만 폴백.
      // 광고·기술 영상은 브랜드명(Google, AdSense)·숫자·짧은 감탄사 등 번역해도 원문과 같은 줄이 흔해,
      // 낮은 임계값(과거 20%)은 정상 번역을 대량 거짓 불량 처리 → 긴 영상 전멸의 원인이었다.
      // 70%(최소 6줄) 이상 동일할 때만 "미번역"으로 간주해 폴백한다. (일부 동일 줄은 정상)
      for (const [lang, lines] of Object.entries(repairedTranslations)) {
        const untranslated = lines.filter((line, i) => {
          const orig = stripNonLetter(subtitles[i]?.text || '');
          if (!orig) return false; // 숫자·기호만 있는 줄은 비교 제외
          return stripNonLetter(line || '') === orig;
        }).length;
        const qualityThreshold = Math.max(6, Math.ceil(lines.length * 0.7));
        if (untranslated >= qualityThreshold) {
          console.error(`[Gemini] ${model} [${lang}] 미번역(원문 반환) ${untranslated}/${lines.length} → 폴백`);
          return { failed: 'quality', inputTokens, outputTokens };
        }
      }

      return { translations: repairedTranslations, inputTokens, outputTokens };
    } catch (err) {
      clearTimeout(timer);
      lastReason = err?.name === 'AbortError' ? 'timeout' : 'network';
      console.error('[Gemini] callGemini 예외:', err?.name, err?.message);
      return { failed: lastReason, inputTokens: 0, outputTokens: 0 };
    }
  }

  return { failed: lastReason, inputTokens: 0, outputTokens: 0 };
}

// ── 3-tier 폴백 체인 ──────────────────────────────────────────────────────────
async function translateWithFallback(env, subtitles, offset, targetLangs, sourceLang, preferredModel) {
  // 선호 모델부터 시작
  const startIdx = FALLBACK_CHAIN.findIndex(f => f.model === preferredModel);
  const chain    = startIdx >= 0 ? FALLBACK_CHAIN.slice(startIdx) : FALLBACK_CHAIN;

  let totalInput = 0, totalOutput = 0;
  let lastReason = 'unknown'; // 마지막 실패 원인 — 504에 실어 진단 가능하게

  for (let ci = 0; ci < chain.length; ci++) {
    const { model, timeoutMs, split, base } = chain[ci];
    const tier = startIdx + ci + 1; // 전체 폴백 체인 기준 단계 (1=원본, 2=분할, 3=경량)
    let result;

    if (split && subtitles.length > 1) {
      const mid      = Math.floor(subtitles.length / 2);
      const [r1, r2] = await Promise.all([
        callGemini(env, model, subtitles.slice(0, mid), offset,       targetLangs, sourceLang, timeoutMs, base),
        callGemini(env, model, subtitles.slice(mid),    offset + mid, targetLangs, sourceLang, timeoutMs, base),
      ]);

      // 토큰 항상 누적 (성공/품질실패 모두)
      totalInput  += (r1.inputTokens || 0) + (r2.inputTokens || 0);
      totalOutput += (r1.outputTokens || 0) + (r2.outputTokens || 0);

      if (!r1.failed && !r2.failed) {
        const translations = {};
        for (const lang of targetLangs) {
          translations[lang] = [...r1.translations[lang], ...r2.translations[lang]];
        }
        return { translations, model_used: model, tier, inputTokens: totalInput, outputTokens: totalOutput };
      }
      lastReason = r1.failed || r2.failed || lastReason;
    } else {
      result = await callGemini(env, model, subtitles, offset, targetLangs, sourceLang, timeoutMs, base);
      totalInput  += result.inputTokens  || 0;
      totalOutput += result.outputTokens || 0;
      if (!result.failed) {
        return { translations: result.translations, model_used: model, tier, inputTokens: totalInput, outputTokens: totalOutput };
      }
      lastReason = result.failed || lastReason;
    }
  }

  // 전부 실패 — 호출부에서 model_used === null 체크 후 504 반환 (reason 포함)
  return { translations: null, model_used: null, tier: null, reason: lastReason, inputTokens: totalInput, outputTokens: totalOutput };
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

  // 잔액 사전 확인 — 이 job에 누적된 미차감 요금까지 반영.
  // 시작된 작업이 잔액 소진 직후 끊기지 않도록 OVERDRAFT_CREDITS만큼 초과 허용 (초과분은 마이너스 잔액으로 차감됨)
  const { data: account } = await sb
    .from('credit_accounts')
    .select('balance, referral_balance')
    .eq('user_id', userId)
    .single();

  if (!account || (account.balance + (account.referral_balance || 0)) + OVERDRAFT_CREDITS <= (job.credits_charged || 0)) {
    return c.json({ error: 'INSUFFICIENT_CREDITS' }, 402);
  }

  // 번역 (폴백 포함)
  const preferredModel = model || c.env.GEMINI_MODEL;
  const { translations, model_used, tier, reason, inputTokens, outputTokens } =
    await translateWithFallback(c.env, subtitles, offset, target_langs, source_lang, preferredModel);

  const apiCostUsd = (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000;
  // 성공한 단계의 배수로 청구 크레딧 산정. 실패 청크(tier 없음)는 결과물이 없으므로 0(무과금).
  const tierFactor = tier ? (TIER_FACTOR[tier] ?? 1) : 0;

  // 토큰 사용량 기록 (실비는 통계용으로 항상, 청구 크레딧은 단계 배수 반영). rpc는 throw하지 않으므로 error 검사 필수.
  if (inputTokens > 0 || outputTokens > 0) {
    const { error: incError } = await sb.rpc('increment_job_tokens', {
      p_job_id:        job_id,
      p_input_tokens:  inputTokens,
      p_output_tokens: outputTokens,
      p_api_cost:      apiCostUsd,                            // 실비(USD) — cumulative_used·통계용
      p_credits:       apiCostUsd * CREDIT_PER_USD * tierFactor, // 청구 크레딧(원) — 단계 배수 반영
    });
    if (incError) await notifyError(c.env, 'translate/increment_job_tokens', new Error(incError.message), { job_id });
  }

  // 전부 실패 시 504 — 원인(reason: rate_limit/timeout/http_xxx 등)을 실어 진단 가능하게
  if (model_used === null) {
    await notifyError(c.env, 'translate/ALL_FALLBACKS_FAILED', new Error(`ALL_FALLBACKS_FAILED reason=${reason}`), { job_id, langs: target_langs.length, lines: subtitles.length });
    return c.json({ error: 'ALL_FALLBACKS_FAILED', reason: reason || 'unknown' }, 504);
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

  // 미정산 작업 처리 — 클라이언트가 PATCH(정산)를 보내지 않고 job을 무한 재생성해
  // 무료 번역하는 우회를 차단한다.
  //  (1) 유예시간(2분) 초과한 running·미차감 작업 = 버려진 작업 → 강제 정산
  //  (2) 유예 내 미정산 작업이 과도하면(정상 흐름은 자막+메타 최대 2건) 남용으로 보고 차단
  const GRACE_MS = 2 * 60 * 1000;
  const nowMs = Date.now();
  const { data: runningJobs } = await sb
    .from('translation_jobs')
    .select('id, api_cost_usd, created_at')
    .eq('user_id', userId)
    .eq('status', 'running')
    .is('deducted_at', null);

  let recentUnsettled = 0;
  for (const j of runningJobs || []) {
    const age = nowMs - new Date(j.created_at).getTime();
    if (age <= GRACE_MS) { recentUnsettled++; continue; } // 진행 중일 수 있음 → 정산 보류
    if (j.api_cost_usd > 0) {
      const { error: dErr } = await sb.rpc('deduct_credits', {
        p_user_id: userId, p_job_id: j.id, p_api_cost: j.api_cost_usd, p_multiplier: CREDIT_PER_USD,
      });
      // 차감 성공 시에만 정산 마킹 (실패 시 다음 기회에 재시도 — 006 없이도 이중차감 방지)
      if (!dErr) {
        await sb.from('translation_jobs')
          .update({ status: 'stopped', deducted_at: new Date().toISOString() })
          .eq('id', j.id);
      }
    } else {
      await sb.from('translation_jobs').update({ status: 'stopped' }).eq('id', j.id);
    }
  }
  if (recentUnsettled >= 4) {
    return c.json({ error: 'TOO_MANY_ACTIVE_JOBS' }, 429);
  }

  // 잔액이 0 이하(마이너스 부채 포함)면 새 작업 시작 거부 — overdraft 반복 악용 차단
  const { data: account } = await sb
    .from('credit_accounts')
    .select('balance, referral_balance')
    .eq('user_id', userId)
    .single();

  if (!account || (account.balance + (account.referral_balance || 0)) <= 0) {
    return c.json({ error: 'INSUFFICIENT_CREDITS' }, 402);
  }
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
  const { status, error_message, units, success } = await c.req.json();
  if (!['completed', 'failed', 'stopped'].includes(status)) {
    return c.json({ error: 'INVALID_STATUS' }, 400);
  }
  // YouTube quota 과금: 소비 unit → 크레딧 (10 unit = 1 크레딧)
  const quotaCredits = Math.round((Number(units) || 0) / UNITS_PER_CREDIT);

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

  // 결과물 0(성공 언어 0) → 과금 면제. 실패한 번역은 청구하지 않는다(사용자 보호).
  //   자막/제목·설명이 하나도 등록 안 됐으면 Gemini 토큰을 썼더라도 사용자에겐 청구 X.
  //   settled 표시(deducted_at)만 남겨 미정산 스위퍼가 다시 청구하지 않게 한다.
  if (['completed', 'failed', 'stopped'].includes(status) && Number(success) === 0 && !job.deducted_at) {
    await sb.from('translation_jobs').update({ deducted_at: new Date().toISOString() }).eq('id', jobId);
    return c.json({ ok: true, waived: true });
  }

  // 완료/실패/중단 시 크레딧 차감 (idempotency: deducted_at으로 이중 차감 방지)
  if (['completed', 'failed', 'stopped'].includes(status) && (job.api_cost_usd > 0 || quotaCredits > 0) && !job.deducted_at) {
    // supabase-js rpc는 throw하지 않고 {error}를 반환하므로 반드시 error를 검사해야 함.
    // 차감이 실패했는데 deducted_at을 기록하면 영구 무과금이 되므로, 성공했을 때만 마킹한다.
    const { error: deductError } = await sb.rpc('deduct_credits', {
      p_user_id:      userId,
      p_job_id:       jobId,
      p_api_cost:     job.api_cost_usd,
      p_multiplier:   CREDIT_PER_USD,   // apiCostUsd × (배수×환율) = Gemini 차감 크레딧(원)
      p_quota_credits: quotaCredits,    // YouTube quota 차감 크레딧(units/10)
    });
    if (deductError) {
      await notifyError(c.env, 'translate/deduct_credits', new Error(deductError.message), { jobId, userId });
      // deducted_at 미기록 → 재전송/재호출 시 재시도 가능
    } else {
      await sb
        .from('translation_jobs')
        .update({ deducted_at: new Date().toISOString() })
        .eq('id', jobId);
    }
  }

  return c.json({ ok: true });
});

export default app;
