import { callGemini } from './gemini.js';
import { callOpenAI } from './openai.js';

/**
 * 폴백 체인 정의
 *
 * Gemini 내 폴백 (v2): 속도 문제, 일시 부하 대응
 * Gemini 외 폴백 (v2.x): Gemini 전체 장애 대응
 *
 * OPENAI_API_KEY 미설정 시 openai 항목은 자동 skip됨
 */
const FALLBACK_CHAIN = [
  { provider: 'gemini', model: 'gemini-2.5-flash',      timeoutMs: 90_000 },
  { provider: 'gemini', model: 'gemini-2.5-flash-lite', timeoutMs: 60_000 },
  { provider: 'gemini', model: 'gemini-2.0-flash',      timeoutMs: 60_000 },
  { provider: 'openai', model: 'gpt-4o-mini',           timeoutMs: 60_000 }, // v2.x
];

/**
 * 선호 모델 기준으로 체인 시작점 결정
 * 요청된 모델이 체인에 없으면 맨 앞부터 시작
 */
function buildChain(preferredModel) {
  const startIdx = FALLBACK_CHAIN.findIndex(c => c.model === preferredModel);
  return startIdx >= 0 ? FALLBACK_CHAIN.slice(startIdx) : FALLBACK_CHAIN;
}

/**
 * 타임아웃 래퍼
 */
function withTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

/**
 * 단일 청크 번역 (폴백 포함)
 *
 * @param {object} params
 * @param {Array}  params.subtitles   - [{text: string}, ...]
 * @param {number} params.offset      - 전역 ID 오프셋 (0-based)
 * @param {Array}  params.targetLangs - 번역 대상 언어 코드 배열
 * @param {string} params.sourceLang  - 원본 언어명 (예: 'Korean')
 * @param {string} params.model       - 선호 모델
 * @param {object} params.env         - Cloudflare Worker env
 * @returns {{ translations, modelUsed, tokens }}
 */
export async function translateWithFallback({ subtitles, offset, targetLangs, sourceLang, model, env }) {
  const chain = buildChain(model);
  let lastError;

  for (let i = 0; i < chain.length; i++) {
    const { provider, model: currentModel, timeoutMs } = chain[i];

    // OPENAI_API_KEY 없으면 openai 항목 skip
    if (provider === 'openai' && !env.OPENAI_API_KEY) continue;

    // 2순위 이후: 청크를 절반으로 분할해서 재시도
    if (i > 0 && subtitles.length > 1) {
      return await translateHalved({ subtitles, offset, targetLangs, sourceLang, model: currentModel, timeoutMs, provider, env });
    }

    try {
      console.log(`[provider] trying ${currentModel} (timeout ${timeoutMs}ms)`);
      const result = await withTimeout(
        (signal) => callProvider({ provider, model: currentModel, subtitles, offset, targetLangs, sourceLang, env, signal }),
        timeoutMs
      );

      // 길이 검증 + 누락 보정
      const validated = validateAndRepair(result.translations, subtitles, targetLangs);
      return { translations: validated, modelUsed: currentModel, tokens: result.tokens };

    } catch (err) {
      lastError = err;
      const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted');
      const isServerErr = err.status >= 500 || isTimeout;

      console.warn(`[provider] ${currentModel} failed: ${err.message} (isServerErr=${isServerErr})`);

      // 4xx 클라이언트 에러 (인증, 쿼터 초과 등)는 같은 프로바이더 재시도 무의미
      if (err.status === 429 || err.status === 401 || err.status === 403) {
        // 다음 프로바이더로 넘어가되, 같은 프로바이더의 다른 모델은 skip
        const currentProvider = provider;
        while (i + 1 < chain.length && chain[i + 1].provider === currentProvider) i++;
      }
    }
  }

  // 모든 폴백 실패 → 원본 텍스트 유지
  console.error('[provider] all fallbacks failed, returning original text');
  const original = Object.fromEntries(
    targetLangs.map(lang => [lang, subtitles.map(s => s.text)])
  );
  return { translations: original, modelUsed: null, tokens: { input: 0, output: 0 }, allFailed: true };
}

/**
 * 청크 절반 분할 후 병렬 재시도
 */
async function translateHalved({ subtitles, offset, targetLangs, sourceLang, model, timeoutMs, provider, env }) {
  const half = Math.ceil(subtitles.length / 2);
  const [a, b] = await Promise.all([
    withTimeout(
      (signal) => callProvider({ provider, model, subtitles: subtitles.slice(0, half), offset, targetLangs, sourceLang, env, signal }),
      timeoutMs
    ),
    withTimeout(
      (signal) => callProvider({ provider, model, subtitles: subtitles.slice(half), offset: offset + half, targetLangs, sourceLang, env, signal }),
      timeoutMs
    )
  ]);

  const merged = {};
  for (const lang of targetLangs) {
    merged[lang] = [...(a.translations[lang] || []), ...(b.translations[lang] || [])];
  }

  const totalTokens = {
    input: (a.tokens?.input || 0) + (b.tokens?.input || 0),
    output: (a.tokens?.output || 0) + (b.tokens?.output || 0),
  };

  return {
    translations: validateAndRepair(merged, subtitles, targetLangs),
    modelUsed: model,
    tokens: totalTokens
  };
}

/**
 * 프로바이더 라우터
 */
function callProvider({ provider, model, subtitles, offset, targetLangs, sourceLang, env, signal }) {
  if (provider === 'gemini') {
    return callGemini({ model, subtitles, offset, targetLangs, sourceLang, apiKey: env.GEMINI_API_KEY, signal });
  }
  if (provider === 'openai') {
    return callOpenAI({ model, subtitles, offset, targetLangs, sourceLang, apiKey: env.OPENAI_API_KEY, signal });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * 번역 결과 길이 검증 + 누락 보정
 * 배열 길이가 맞지 않으면 원본 텍스트로 채움
 */
function validateAndRepair(translations, subtitles, targetLangs) {
  const repaired = {};
  for (const lang of targetLangs) {
    const arr = Array.isArray(translations[lang]) ? translations[lang] : [];
    repaired[lang] = subtitles.map((s, i) => {
      const t = arr[i];
      return (t && t.trim()) ? t.trim() : s.text;
    });
  }
  return repaired;
}
