/**
 * LLM API 모듈 - Google Gemini 전용 (API Key)
 * - 429 Rate Limit: 지수 백오프(Exponential Backoff) 자동 재시도
 * - GeminiRateLimiter: 요금제별 요청 간격 자동 제어
 */
import { GEMINI_CONFIG, RATE_CONFIGS, TRANSLATION_PROMPT } from './constants.js';

export const CHUNK_SIZE = 50; // 청크당 자막 수
const MAX_RETRIES = 4;   // 429 최대 재시도 횟수

// ── Rate Limiter ─────────────────────────────────────────────────────────────
// 모듈 레벨 싱글턴: 언어별 병렬 실행과 무관하게 모든 Gemini 요청에 간격 적용
class GeminiRateLimiter {
  constructor(intervalMs) {
    this.intervalMs    = intervalMs;
    this.lastSentTime  = 0;
    this.queue         = [];
    this.processing    = false;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.processing) this._process();
    });
  }

  async _process() {
    this.processing = true;
    while (this.queue.length > 0) {
      const waitMs = Math.max(0, this.lastSentTime + this.intervalMs - Date.now());
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const { fn, resolve, reject } = this.queue.shift();
      this.lastSentTime = Date.now();
      try   { resolve(await fn()); }
      catch (e) { reject(e); }
    }
    this.processing = false;
  }
}

// 기본값: 무료 티어 (5초 간격)
let _limiter = new GeminiRateLimiter(RATE_CONFIGS.free.intervalMs);

/**
 * 번역 시작 전 service-worker에서 한 번 호출 — 요금제에 맞게 속도 설정
 * @param {'free'|'paid_fast'|'paid_normal'|'paid_slow'} rateKey
 */
export function configureRateLimit(rateKey) {
  const cfg = RATE_CONFIGS[rateKey] || RATE_CONFIGS.free;
  _limiter  = new GeminiRateLimiter(cfg.intervalMs);
  console.log(`[YT-Translator] Rate Limit 설정: ${cfg.desc} (${cfg.intervalMs}ms 간격)`);
}

/**
 * 자막 번역 (ID 기반 매핑 + 청크 분할)
 */
export async function translateSubtitles({ apiKey, model, sourceLang, targetLang, subtitles, onChunkProgress }) {
  const results = new Array(subtitles.length);

  // 청크 단위 번역 — 재귀 호출로 MAX_TOKENS 분할 처리
  async function processSegment(items, offset) {
    const segLabel = `청크 [${offset + 1}~${offset + items.length}]`;

    // API 호출 (실패 시 1회 재시도)
    let responseText = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const subtitleTexts = items.map((s, idx) => `[${offset + idx + 1}] ${s.text}`).join('\n');
      const prompt = TRANSLATION_PROMPT
        .replaceAll('{sourceLang}', sourceLang)
        .replaceAll('{targetLang}', targetLang)
        .replaceAll('{subtitles}', subtitleTexts);
      try {
        responseText = await _limiter.enqueue(() =>
          callGemini({ apiKey, model, prompt, targetLang })
        );
        break;
      } catch (err) {
        if (err.code === 'MAX_TOKENS' && err.partialText) {
          // ── MAX_TOKENS: 부분 응답 파싱 후 나머지 항목 재귀 처리 ──
          const partialClean = err.partialText.replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1').trim();
          const partialMap   = parseTranslatedLines(partialClean);
          let   lastHit      = -1;

          items.forEach((original, idx) => {
            const translated = partialMap.get(offset + idx + 1) || partialMap.get(idx + 1);
            if (translated) {
              results[offset + idx] = { ...original, text: translated };
              lastHit = idx;
            }
          });

          if (lastHit >= 0 && lastHit < items.length - 1) {
            const remaining = items.slice(lastHit + 1);
            console.warn(`[YT-Translator] ${segLabel} MAX_TOKENS — ${lastHit + 1}개 파싱, 나머지 ${remaining.length}개 재귀 요청`);
            await processSegment(remaining, offset + lastHit + 1);
          } else if (lastHit === -1) {
            // 부분 파싱도 0개 → 절반으로 분할해 재귀
            if (items.length > 1) {
              const half = Math.ceil(items.length / 2);
              console.warn(`[YT-Translator] ${segLabel} MAX_TOKENS 파싱 실패 — 절반(${half}개)으로 분할`);
              await processSegment(items.slice(0, half), offset);
              await processSegment(items.slice(half), offset + half);
            } else {
              console.error(`[YT-Translator] ${segLabel} MAX_TOKENS 단일 항목 실패 — 원본 유지`);
              if (!results[offset]) results[offset] = { ...items[0] };
            }
          }
          return; // MAX_TOKENS 처리 완료
        }
        if (attempt === 0) {
          console.warn(`[YT-Translator] ${segLabel} 실패, 재시도 중... (${err.message})`);
        } else {
          throw err;
        }
      }
    }

    if (!responseText) return;

    const cleanText = responseText.replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1').trim();
    const parsedMap = parseTranslatedLines(cleanText);

    // ── 1차: 글로벌 ID 매핑 ────────────────────────────────────
    let matchCount = 0;
    items.forEach((original, idx) => {
      const translated = parsedMap.get(offset + idx + 1);
      if (translated) { results[offset + idx] = { ...original, text: translated }; matchCount++; }
    });
    if (matchCount === items.length) return;

    // ── 2차: 로컬 ID 매핑 (LLM이 [1]부터 다시 번호를 매긴 경우) ──
    if (matchCount === 0) {
      let local = 0;
      items.forEach((original, idx) => {
        const translated = parsedMap.get(idx + 1);
        if (translated) { results[offset + idx] = { ...original, text: translated }; local++; }
      });
      if (local > 0) {
        console.warn(`[YT-Translator] ${segLabel} 로컬 ID 폴백 (${local}/${items.length})`);
        matchCount = local;
      }
    }
    if (matchCount === items.length) return;

    // ── 3차: 순서 기반 매핑 ───────────────────────────────────
    const rawLines = cleanText.split('\n')
      .map(l => l.replace(/^\[?\d+\]?[\s.:-]*\s*/, '').trim())
      .filter(l => l.length > 0);

    if (rawLines.length === items.length) {
      items.forEach((original, idx) => {
        if (!results[offset + idx])
          results[offset + idx] = { ...original, text: rawLines[idx] };
      });
      console.warn(`[YT-Translator] ${segLabel} 순서 기반 폴백`);
      return;
    }

    // ── 4차: 절반 분할 재귀 요청 (응답 줄 수가 맞지 않을 때) ──
    if (items.length > 1) {
      const half = Math.ceil(items.length / 2);
      console.warn(`[YT-Translator] ${segLabel} 줄 수 불일치(응답 ${rawLines.length} ≠ 입력 ${items.length}) — 절반 분할 재요청`);
      await processSegment(items.slice(0, half), offset);
      await processSegment(items.slice(half),    offset + half);
    } else {
      console.error(`[YT-Translator] ${segLabel} 번역 실패 — 원본 유지`);
      if (!results[offset]) results[offset] = { ...items[0] };
    }
  }

  const totalChunks = Math.ceil(subtitles.length / CHUNK_SIZE);
  let chunksCompleted = 0;

  for (let i = 0; i < subtitles.length; i += CHUNK_SIZE) {
    const chunk = subtitles.slice(i, i + CHUNK_SIZE);
    await processSegment(chunk, i);
    chunksCompleted++;
    if (onChunkProgress) onChunkProgress(chunksCompleted, totalChunks);
  }

  return results;
}

/**
 * Gemini API 호출 — 429 시 지수 백오프 자동 재시도
 * endpoint: v1beta (system_instruction 지원 / v1에서는 400 오류)
 * @param {number} attempt - 현재 시도 횟수 (내부 재귀용)
 */
async function callGemini({ apiKey, model, prompt, targetLang }, attempt = 0) {
  if (!apiKey) {
    throw new Error('Gemini API 키가 없습니다. 설정에서 API 키를 입력해 주세요.');
  }

  const url = `${GEMINI_CONFIG.baseUrl}/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // systemInstruction: v1beta 공식 필드명 (camelCase) — v1에서는 미지원
      systemInstruction: {
        parts: [{ text:
          `You are a professional subtitle translator. ` +
          `Translate into ${targetLang}. ` +
          `Return ONLY lines in [ID] Text format (e.g. [1] Hello). ` +
          `CRITICAL: Translate EVERY line independently. ` +
          `Even if consecutive source lines look identical or similar, you MUST produce a separate translation for each line. ` +
          `NEVER collapse, deduplicate, merge, or skip any lines. ` +
          `Never return the original text.`
        }]
      },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 65536 },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    })
  });

  // ── 429 Rate Limit: RPM / RPD 구분 후 재시도 or 즉시 중단 ──
  if (response.status === 429) {
    const errData = await response.json().catch(() => ({}));
    const errMsg  = errData?.error?.message || '';

    // 일일 한도(RPD) 소진 → 재시도해도 의미 없음, 즉시 안내
    const isRPD = /per_day|per-day|daily|day.*quota|quota.*day/i.test(errMsg);
    if (isRPD) {
      throw new Error(
        `Gemini API 일일 한도 초과 (429). ` +
        `무료 티어의 하루 요청 횟수를 모두 사용했습니다. ` +
        `내일 자정(태평양 표준시) 이후에 다시 시도하거나, ` +
        `Google AI Studio(aistudio.google.com/apikey)에서 사용량을 확인해 주세요.`
      );
    }

    // 분당 한도(RPM) or 토큰 한도 → 지수 백오프 재시도
    const retryDelaySec = parseRetryDelay(errData);
    const backoffMs     = retryDelaySec
      ? (retryDelaySec * 1000 + 3000)                     // 서버 제안 + 여유 3초
      : Math.min(2000 * Math.pow(2, attempt), 120000);    // 지수 백오프 (최대 2분)

    if (attempt < MAX_RETRIES) {
      const waitSec = Math.round(backoffMs / 1000);
      console.warn(`[YT-Translator] Gemini 429 — ${waitSec}초 대기 후 재시도 (${attempt + 1}/${MAX_RETRIES}) | ${errMsg.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, backoffMs));
      return callGemini({ apiKey, model, prompt, targetLang }, attempt + 1);
    }

    // 최대 재시도 초과 (RPM이지만 계속 실패)
    throw new Error(
      `Gemini API 분당 요청 한도 초과 (429). ` +
      `${MAX_RETRIES}회 재시도 후에도 해결되지 않았습니다. ` +
      `설정에서 '번역 요청 간격'을 늘리거나 잠시 후 다시 시도해 주세요.`
    );
  }

  // ── 기타 오류 ──
  if (!response.ok) {
    const errText = await response.text();
    let detail = errText;
    try { detail = JSON.parse(errText).error?.message || errText; } catch {}

    if (response.status === 401 || response.status === 403) {
      throw new Error('Gemini API 인증 오류 (401/403). 설정의 API 키를 확인해 주세요.');
    }
    if (response.status === 404) {
      throw new Error(
        `선택한 모델(${model})을 찾을 수 없습니다 (404). ` +
        `설정에서 모델을 "Gemini 2.5 Flash (권장)"으로 변경해 주세요.`
      );
    }
    throw new Error(`Gemini API 오류 (${response.status}): ${detail}`);
  }

  // ── 정상 응답 파싱 ──
  const data = await response.json();
  const text         = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data.candidates?.[0]?.finishReason;

  if (!text) {
    throw new Error(`Gemini 응답 없음 (finishReason: ${finishReason || 'unknown'})`);
  }

  // 출력 토큰 한도 초과 → 부분 응답을 담아 특수 에러로 전파
  // (translateSubtitles에서 파싱 후 남은 항목 재요청)
  if (finishReason === 'MAX_TOKENS') {
    const err = new Error('GEMINI_MAX_TOKENS');
    err.code = 'MAX_TOKENS';
    err.partialText = text;
    throw err;
  }

  return text;
}

/**
 * Gemini 429 에러 본문에서 재시도 대기 초 추출
 * e.g. "Please retry in 25.54s" → 26
 */
function parseRetryDelay(errData) {
  const msg = errData?.error?.message || '';
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]));
  return null;
}

/**
 * [ID] Text 형식 파싱
 */
function parseTranslatedLines(text) {
  const map = new Map();
  const regexes = [
    /^\[(\d+)\][\s.:-]*\s*(.*)$/,
    /^\**(\d+)\.\**[\s.:-]*\s*(.*)$/,
    /^(\d+)[\s.:-]+\s*(.*)$/,
    /^(\d+)\)\s*(.*)$/
  ];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const regex of regexes) {
      const match = trimmed.match(regex);
      if (match) {
        const id = parseInt(match[1], 10);
        const content = match[2].trim();
        if (content && !map.has(id)) map.set(id, content);
        break;
      }
    }
  }
  return map;
}
