import { MSG, TARGET_LANGUAGES, TRANSLATION_MODES, getChunkSize } from '../lib/constants.js';
import { loadSettings } from '../lib/storage.js';
import { translateSubtitles, configureRateLimit, CHUNK_SIZE } from '../lib/llm-api.js';
import { reportError, reportTranslationResult, installGlobalErrorHandler, log, LOG_LEVEL, initSentry } from '../lib/logger.js';
import {
  authorizeYouTube,
  extractVideoId,
  getVideoDetails,
  listCaptions,
  fetchSourceSubtitles,
  uploadCaption,
  subtitlesToSRT,
  updateVideoLocalizations,
} from '../lib/youtube-api.js';
import {
  fetchCredits,
  createCheckout,
  createTranslationJob,
  translateChunk,
  updateTranslationJob,
} from '../lib/backend-api.js';
import {
  getSavedTranslations,
  saveTranslations,
  clearSavedTranslations,
} from '../lib/translation-cache.js';

installGlobalErrorHandler('background');

const MAX_CONCURRENT   = 3; // Vercel 동시 호출 부담 감소 (3 × langBatches = 최대 9개 동시 호출)
const MAX_LANGS_PER_CALL = 3; // Vercel Edge 25s 제한 내 완료 가능한 최대 언어 수

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function normalizeLangCode(code) {
  if (!code) return '';
  return code.split('-')[0].toLowerCase();
}

function getLangName(code) {
  if (!code) return 'Unknown';
  const norm = normalizeLangCode(code);
  const lang = TARGET_LANGUAGES.find(l =>
    normalizeLangCode(l.code) === norm || normalizeLangCode(l.ytCode) === norm
  );
  if (lang) return `${lang.name} (${lang.nativeName})`;
  return code;
}

function friendlyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();

  if (msg.includes('insufficient_credits')) {
    return '크레딧이 부족합니다. ⚙️ 설정에서 크레딧을 충전해 주세요.';
  }
  if (msg.includes('auth_failed') || msg.includes('bad client id') || msg.includes('oauth') ||
      msg.includes('auth token') || msg.includes('identity')) {
    return 'Google 계정 연동에 문제가 발생했습니다. 페이지를 새로고침 후 다시 시도해 주세요.';
  }
  if (msg.includes('401') || msg.includes('api_key_invalid') ||
      msg.includes('api key not valid') || msg.includes('invalid api key')) {
    return 'Gemini API 키가 올바르지 않습니다. ⚙️ 설정 페이지에서 API 키를 다시 확인해 주세요.';
  }
  if (msg.includes('403') || msg.includes('forbidden') ||
      msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return '권한 오류가 발생했습니다. 해당 영상의 소유자 계정으로 YouTube에 로그인되어 있는지 확인해 주세요.';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') ||
      msg.includes('resource_exhausted') || msg.includes('too many requests')) {
    return 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나, ⚙️ 설정에서 크레딧 모드로 전환해 주세요.';
  }
  if (msg.includes('all_fallbacks_failed')) {
    return '번역 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (msg.includes('failed to fetch') || msg.includes('networkerror') ||
      msg.includes('timeout') || msg.includes('econnrefused')) {
    return '네트워크 연결을 확인해 주세요. 인터넷 연결 후 다시 시도해 주세요.';
  }
  if (msg.includes('subtitle') || msg.includes('자막') || msg.includes('caption')) {
    return '영상에 원본 자막이 없습니다. YouTube Studio에서 자막을 먼저 추가한 뒤 번역을 시작해 주세요.';
  }
  if (msg.includes('video id') || msg.includes('videoid') || msg.includes('영상 id')) {
    return 'YouTube Studio 영상 수정 페이지에서만 사용할 수 있습니다.';
  }
  return '번역 중 오류가 발생했습니다. 페이지를 새로고침 후 다시 시도해 주세요.';
}

// ── 업로드 실패 상황별 상세 안내 메시지 ──────────────────────────────────────
function getUploadErrorMessage(err, langName) {
  const msg = (err?.message || String(err)).toLowerCase();

  if (msg.includes('quotaexceeded') || (msg.includes('quota') && msg.includes('exceeded'))) {
    return `[${langName}] YouTube 일일 API 한도 초과 — 번역 결과는 저장되었습니다. 내일(태평양 표준시 자정) 이후 다시 번역을 시작하면 추가 크레딧 없이 자막이 자동 등록됩니다.`;
  }
  if (msg.includes('forbidden') || msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return `[${langName}] 권한 오류 — 이 영상의 채널 소유자 계정으로 YouTube에 로그인되어 있는지 확인해 주세요.`;
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid credentials') || msg.includes('auth')) {
    return `[${langName}] 인증 만료 — 페이지를 새로고침 후 다시 시도해 주세요.`;
  }
  if (msg.includes('404') || msg.includes('not found') || msg.includes('videonotfound')) {
    return `[${langName}] 영상을 찾을 수 없음 — 영상이 삭제됐거나 비공개로 전환되었을 수 있습니다.`;
  }
  if (msg.includes('409') || msg.includes('duplicate') || msg.includes('already exists')) {
    return `[${langName}] 이미 해당 언어 자막이 존재합니다 — YouTube Studio에서 기존 자막을 삭제 후 다시 시도해 주세요.`;
  }
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network')) {
    return `[${langName}] 네트워크 오류 — 인터넷 연결 상태를 확인하고 다시 시도해 주세요.`;
  }
  if (msg.includes('500') || msg.includes('internal server')) {
    return `[${langName}] YouTube 서버 오류 — 일시적인 문제입니다. 잠시 후 다시 시도해 주세요.`;
  }
  return `[${langName}] 자막 등록 실패 (${err?.message || '알 수 없는 오류'}) — 문제가 계속되면 ⚙️ 설정 > 앱 로그를 확인해 주세요.`;
}

function broadcast(message, tabId = state.tabId) {
  chrome.runtime.sendMessage(message).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── 상태 ──────────────────────────────────────────────────────────────────────

let state = {
  isRunning: false,
  shouldStop: false,
  currentLang: null,
  progress: { current: 0, total: 0 },
  targetLangs: [],
  tabId: null,
};

function resetState() {
  state = {
    isRunning: false, shouldStop: false, currentLang: null,
    progress: { current: 0, total: 0 }, targetLangs: [], tabId: null,
  };
}

// ── 공통: YouTube 자막 준비 ────────────────────────────────────────────────────

async function prepareSubtitles(tabId, settings) {
  const tab = await chrome.tabs.get(tabId);
  const videoId = extractVideoId(tab.url);
  if (!videoId) throw new Error('YouTube 영상 ID를 찾을 수 없습니다.');

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: 'YouTube 인증 중...', current: 0, total: state.progress.total });
  await authorizeYouTube();

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '영상 정보 조회 중...', current: 0, total: state.progress.total });
  const videoSnippet = await getVideoDetails(videoId);

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '원본 자막 불러오는 중...', current: 0, total: state.progress.total });
  const existingCaptions = await listCaptions(videoId);

  const { subtitles, trackInfo } = await fetchSourceSubtitles(
    existingCaptions,
    settings.sourceLang,
    videoSnippet?.defaultLanguage,
    videoSnippet?.defaultAudioLanguage
  );

  if (!subtitles.length) throw new Error('원본 자막 내용이 비어 있습니다.');

  return { videoId, videoSnippet, subtitles, trackInfo, existingCaptions };
}

function filterTargetLangs(settings, trackInfo, existingCaptions) {
  const normSourceLang = normalizeLangCode(trackInfo.language);
  const alreadyTranslated = [];

  const targetLangs = settings.targetLangs.filter(code => {
    const lang = TARGET_LANGUAGES.find(l => l.code === code);
    if (!lang) return false;

    const normTarget   = normalizeLangCode(code);
    const normYtTarget = normalizeLangCode(lang.ytCode);

    if ((normTarget === normSourceLang || normYtTarget === normSourceLang) &&
        settings.sourceLang === 'auto' && !trackInfo.isASR) {
      return false;
    }

    const hasExisting = existingCaptions.some(c =>
      normalizeLangCode(c.snippet?.language) === normYtTarget &&
      c.snippet?.trackKind === 'standard'
    );
    if (hasExisting) { alreadyTranslated.push(lang.name); return false; }

    return true;
  });

  return { targetLangs, alreadyTranslated };
}

// ── 제목/설명 번역 — API 키 모드 (직접 Gemini 호출) ──────────────────────────

async function translateMetadataApiKey({ apiKey, model, sourceLang, targetLangName, title, description }) {
  const schema = { type: 'object', properties: {}, required: [] };
  const promptParts = [`Translate from ${sourceLang} to ${targetLangName}:`];
  if (title)       { promptParts.push(`Title: ${title}`);              schema.properties.title       = { type: 'string' }; schema.required.push('title');       }
  if (description) { promptParts.push(`Description:\n${description}`); schema.properties.description = { type: 'string' }; schema.required.push('description'); }
  promptParts.push('\nReturn ONLY the JSON object, no explanation.');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptParts.join('\n') }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Gemini API 오류 (${res.status}): ${errBody?.error?.message || '알 수 없는 오류'}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text || '{}');
}

// ── 제목/설명 번역 — 크레딧 모드 ──────────────────────────────────────────────

async function translateAndUploadMetadataCredits(videoId, snippet, targetLangs, sourceLangName, settings) {
  const items = [];
  if (settings.translateTitle       && snippet?.title)       items.push({ text: snippet.title });
  if (settings.translateDescription && snippet?.description) items.push({ text: snippet.description.slice(0, 3000) });
  if (!items.length || !targetLangs.length) return;

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '제목/설명 번역 중...', current: 0, total: 1 });

  const { job_id: metaJobId } = await createTranslationJob({
    video_id:     videoId,
    job_type:     'metadata',
    source_lang:  sourceLangName,
    target_langs: targetLangs,
    model:        'gemini-2.5-flash',
  });

  const langBatches  = chunkArray(targetLangs, MAX_LANGS_PER_CALL);
  const localizations = {};

  for (const langBatch of langBatches) {
    try {
      const result = await translateChunk({
        job_id:       metaJobId,
        subtitles:    items,
        offset:       0,
        target_langs: langBatch,
        source_lang:  sourceLangName,
        model:        'gemini-2.5-flash',
      });
      for (const code of langBatch) {
        const lang = TARGET_LANGUAGES.find(l => l.code === code);
        if (!lang) continue;
        localizations[lang.ytCode] = {};
        let idx = 0;
        if (settings.translateTitle)       localizations[lang.ytCode].title       = result.translations[code]?.[idx++] || snippet.title;
        if (settings.translateDescription) localizations[lang.ytCode].description = result.translations[code]?.[idx]  || '';
      }
    } catch (err) {
      log(`메타데이터 번역 실패 (${langBatch.join(',')}): ${err.message}`, LOG_LEVEL.WARN);
    }
  }

  await updateTranslationJob(metaJobId, { status: 'completed' });

  if (Object.keys(localizations).length) {
    await updateVideoLocalizations(videoId, localizations);
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '제목/설명 등록 완료 ✓', current: 1, total: 1 });
  }
}

// ── API 키 경로 (v1 로직 그대로) ───────────────────────────────────────────────

async function runTranslationApiKey(tabId, settings) {
  if (settings.selectedModel === 'gemini-2.0-flash-exp') {
    settings.selectedModel = 'gemini-2.0-flash';
  }

  state = {
    isRunning: true, shouldStop: false, currentLang: null,
    tabId, targetLangs: settings.targetLangs,
    progress: { current: 0, total: settings.targetLangs.length },
  };

  const rateKey = settings.geminiTier === 'paid'
    ? `paid_${settings.paidSpeed || 'normal'}` : 'free';
  configureRateLimit(rateKey);

  if (settings.sentryDsn) await initSentry(settings.sentryDsn);

  const errors = [];

  try {
    const { videoId, videoSnippet, subtitles: sourceSubtitles, trackInfo, existingCaptions } =
      await prepareSubtitles(tabId, settings);

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? '(자동생성)' : '(수동업로드)';
    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `원본 감지: ${sourceLangName} ${trackKindLabel}`,
      current: 0, total: state.progress.total,
    });

    const { targetLangs, alreadyTranslated } = filterTargetLangs(settings, trackInfo, existingCaptions);

    if (alreadyTranslated.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💡 이미 ${alreadyTranslated.join(', ')} 언어로 번역된 자막이 있어 건너뜁니다.`,
        current: 0, total: targetLangs.length,
      });
    }

    if (targetLangs.length === 0) {
      const savedTabId = state.tabId;
      resetState();
      broadcast({ type: MSG.TRANSLATION_COMPLETE, successCount: 0, failCount: 0, errors: [], allSkipped: true }, savedTabId);
      return;
    }

    const chunks = chunkArray(targetLangs, 3);
    let globalChunksDone = 0;
    const totalAllChunks = targetLangs.length * Math.ceil(sourceSubtitles.length / CHUNK_SIZE);

    for (const chunk of chunks) {
      if (state.shouldStop) break;

      await Promise.allSettled(
        chunk.map(async (langCode) => {
          const lang = TARGET_LANGUAGES.find(l => l.code === langCode);
          if (!lang) return;

          state.currentLang = langCode;
          broadcast({
            type: MSG.TRANSLATION_PROGRESS,
            lang: langCode,
            langName: `[${lang.name}] 번역 중...`,
            current: globalChunksDone, total: totalAllChunks,
          });

          try {
            const translated = await translateSubtitles({
              apiKey: settings.geminiApiKey || '',
              model: settings.selectedModel,
              sourceLang: sourceLangName,
              targetLang: lang.name,
              subtitles: sourceSubtitles,
              onChunkProgress: () => {
                globalChunksDone++;
                broadcast({
                  type: MSG.TRANSLATION_PROGRESS,
                  lang: langCode,
                  langName: `[${lang.name}] 번역 중...`,
                  current: globalChunksDone, total: totalAllChunks,
                  isChunkUpdate: true,
                });
              },
            });

            await uploadCaption(videoId, lang.ytCode, subtitlesToSRT(translated), existingCaptions);

            // 제목/설명 번역 (API 키 모드 — 언어별 순차 처리)
            if (settings.translateTitle || settings.translateDescription) {
              try {
                const metaResult = await translateMetadataApiKey({
                  apiKey:         settings.geminiApiKey || '',
                  model:          settings.selectedModel,
                  sourceLang:     sourceLangName,
                  targetLangName: lang.name,
                  title:          settings.translateTitle       ? videoSnippet?.title                        : null,
                  description:    settings.translateDescription ? videoSnippet?.description?.slice(0, 3000)  : null,
                });
                if (Object.keys(metaResult).length) {
                  await updateVideoLocalizations(videoId, { [lang.ytCode]: metaResult });
                }
              } catch (metaErr) {
                log(`[${lang.name}] 제목/설명 번역 실패: ${metaErr.message}`, LOG_LEVEL.WARN);
              }
            }

            broadcast({
              type: MSG.TRANSLATION_PROGRESS,
              lang: langCode, langName: `[${lang.name}] 완료 ✓`,
              current: globalChunksDone, total: totalAllChunks,
              langDone: true,
            });

          } catch (err) {
            errors.push({ lang: lang.name, message: err.message });
            await reportError(err, { action: 'translate_upload', currentLang: lang.name });
            broadcast({ type: MSG.TRANSLATION_ERROR, error: `${lang.name}: ${friendlyError(err)}`, lang: langCode });
          }
        })
      );

      if (!state.shouldStop && settings.delayMin > 0) {
        await new Promise(r => setTimeout(r, settings.delayMin));
      }
    }

    const successCount = targetLangs.length - errors.length;
    const savedTabId = state.tabId;
    resetState();
    broadcast({ type: MSG.TRANSLATION_COMPLETE, successCount: successCount, errors }, savedTabId);

    await reportTranslationResult({ videoId, errors, total: targetLangs.length, success: successCount });

  } catch (err) {
    log(err.message, LOG_LEVEL.ERROR, { action: 'runTranslationApiKey' });
    const savedTabId = state.tabId;
    resetState();
    await reportError(err, { action: 'runTranslationApiKey', tabId: savedTabId });
    broadcast({ type: MSG.TRANSLATION_ERROR, error: friendlyError(err) }, savedTabId);
  } finally {
    if (state.isRunning) resetState();
  }
}

// ── 크레딧 경로 (v2 신규) ──────────────────────────────────────────────────────

async function runTranslationCredits(tabId, settings) {
  state = {
    isRunning: true, shouldStop: false, currentLang: null,
    tabId, targetLangs: settings.targetLangs,
    progress: { current: 0, total: settings.targetLangs.length },
  };

  let jobId = null;

  try {
    // 1. 잔액 조회 (실제 검증은 신규 번역이 필요한 경우에만)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '크레딧 잔액 확인 중...', current: 0, total: state.progress.total });
    const { balance } = await fetchCredits();

    // 2. YouTube 인증 + 자막 가져오기
    const { videoId, videoSnippet, subtitles: sourceSubtitles, trackInfo, existingCaptions } =
      await prepareSubtitles(tabId, settings);

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? '(자동생성)' : '(수동업로드)';
    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `원본 감지: ${sourceLangName} ${trackKindLabel}`,
      current: 0, total: state.progress.total,
    });

    // 3. 대상 언어 필터링
    let { targetLangs, alreadyTranslated } = filterTargetLangs(settings, trackInfo, existingCaptions);

    if (alreadyTranslated.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💡 이미 ${alreadyTranslated.join(', ')} 언어로 번역된 자막이 있어 건너뜁니다.`,
        current: 0, total: targetLangs.length,
      });
    }

    if (targetLangs.length === 0) {
      const savedTabId = state.tabId;
      resetState();
      broadcast({ type: MSG.TRANSLATION_COMPLETE, successCount: 0, failCount: 0, errors: [], allSkipped: true }, savedTabId);
      return;
    }

    // 3-1. 이전 업로드 실패 번역 캐시 확인 → 해당 언어는 번역 생략하고 바로 업로드
    const cached = await getSavedTranslations(videoId);
    const cachedLangs   = cached ? targetLangs.filter(c => cached.langResults?.[c]) : [];
    const remainingLangs = targetLangs.filter(c => !cachedLangs.includes(c));

    if (cachedLangs.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💾 저장된 번역 발견 (${cachedLangs.map(c => TARGET_LANGUAGES.find(l=>l.code===c)?.name||c).join(', ')}) — 크레딧 없이 재업로드 시도`,
        current: 0, total: targetLangs.length,
      });
    }

    // 4. 신규 번역이 필요한 언어만 job 생성 + 번역 (캐시 언어는 건너뜀)
    const langResults  = {};
    const failedLangs  = new Set();
    let chunksCompleted  = 0;
    let totalChunks      = 0; // if 블록 안에서 재할당, 캐시 전용이면 0 유지
    let totalInputTokens = 0, totalOutputTokens = 0;

    if (remainingLangs.length > 0) {
      // 신규 번역이 있을 때만 잔액 검증 (캐시 재업로드는 크레딧 불필요)
      if (balance <= 0) throw new Error('INSUFFICIENT_CREDITS');

      const { job_id } = await createTranslationJob({
        video_id:    videoId,
        source_lang: trackInfo.language,
        target_langs: remainingLangs,
        model: 'gemini-2.5-flash',
      });
      jobId = job_id;

      // 5. 자막 청크 + 언어 배치 분할 → 병렬 번역
      const chunkSize      = getChunkSize(remainingLangs.length);
      const subtitleChunks = chunkArray(sourceSubtitles, chunkSize);
      const langBatches    = chunkArray(remainingLangs, MAX_LANGS_PER_CALL);
      totalChunks          = subtitleChunks.length * langBatches.length;

      for (const code of remainingLangs) langResults[code] = [];

      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `번역 중... (0/${totalChunks} 청크)`,
        current: 0, total: totalChunks,
      });

      // Gemini 응답 대기 중 5초마다 경과 시간 안내 (사용자 불안 감소)
      const startTime = Date.now();
      const heartbeat = setInterval(() => {
        if (!state.isRunning) { clearInterval(heartbeat); return; }
        const sec = Math.round((Date.now() - startTime) / 1000);
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          langName: `번역 처리 중... (${sec}초 경과, AI 응답 대기)`,
          current: chunksCompleted, total: totalChunks,
        });
      }, 5000);

      for (let si = 0; si < subtitleChunks.length; si += MAX_CONCURRENT) {
        if (state.shouldStop) break;

        const subBatch = subtitleChunks.slice(si, si + MAX_CONCURRENT);
        const callPairs = [];
        for (let bi = 0; bi < subBatch.length; bi++) {
          for (const langBatch of langBatches) {
            callPairs.push({ chunk: subBatch[bi], offset: (si + bi) * chunkSize, langBatch });
          }
        }

        const results = await Promise.allSettled(
          callPairs.map(({ chunk, offset, langBatch }) =>
            translateChunk({
              job_id:       jobId,
              subtitles:    chunk.map(s => ({ text: s.text })),
              offset,
              target_langs: langBatch,
              source_lang:  sourceLangName,
              model:        'gemini-2.5-flash',
            })
          )
        );

        for (let ri = 0; ri < results.length; ri++) {
          const result   = results[ri];
          const { chunk, langBatch } = callPairs[ri];

          if (result.status === 'fulfilled') {
            const { translations, tokens } = result.value;
            for (const code of langBatch) {
              langResults[code].push(...(translations[code] || chunk.map(s => s.text)));
            }
            totalInputTokens  += tokens?.input  || 0;
            totalOutputTokens += tokens?.output || 0;
          } else {
            for (const code of langBatch) failedLangs.add(code);
            const chunkErr = result.reason?.message || '알 수 없는 오류';
            log(`청크 번역 실패: ${chunkErr}`, LOG_LEVEL.WARN);
            await reportError(result.reason || new Error(chunkErr), { action: 'chunk_translate', chunk: chunksCompleted });
          }

          chunksCompleted++;
          broadcast({
            type: MSG.TRANSLATION_PROGRESS,
            langName: `번역 중... (${chunksCompleted}/${totalChunks} 청크)`,
            current: chunksCompleted, total: totalChunks,
          });
        }
      }
      clearInterval(heartbeat);
    }

    // 6. 언어별 YouTube 업로드
    // 업로드 대상 = 방금 번역된 언어(remainingLangs) + 캐시 복원 언어(cachedLangs)
    const allUploadLangs  = [...remainingLangs, ...cachedLangs];
    const allLangResults  = { ...langResults, ...(cached?.langResults || {}) };
    const errors = [];

    let uploadedCount = 0;
    const uploadSucceeded = []; // 캐시 삭제용
    const uploadFailed    = []; // 캐시 저장용

    for (const code of allUploadLangs) {
      if (state.shouldStop) break;

      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      if (!lang) continue;

      // 번역 단계 실패 언어는 건너뜀 (캐시 복원 언어는 failedLangs에 없음)
      if (failedLangs.has(code)) {
        errors.push({ lang: code, error: '번역 실패' });
        continue;
      }

      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        lang: code, langName: `[${lang.name}] 업로드 중...`,
        current: chunksCompleted, total: totalChunks,
      });

      try {
        const translated = sourceSubtitles.map((s, i) => ({
          ...s,
          text: allLangResults[code]?.[i] ?? s.text,
        }));
        await uploadCaption(videoId, lang.ytCode, subtitlesToSRT(translated), existingCaptions);
        uploadedCount++;
        uploadSucceeded.push(code);
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          lang: code, langName: `[${lang.name}] 완료 ✓`,
          current: chunksCompleted, total: totalChunks,
          langDone: true,
        });
      } catch (err) {
        uploadFailed.push(code);
        const detail = getUploadErrorMessage(err, lang.name);
        errors.push({ lang: lang.name, message: detail });
        broadcast({ type: MSG.TRANSLATION_ERROR, error: detail, lang: code });
      }
    }

    // 업로드 성공 언어 캐시 삭제, 실패 언어 캐시 저장 (번역된 언어만)
    await clearSavedTranslations(videoId, uploadSucceeded);
    await saveTranslations(videoId, allLangResults, uploadFailed);

    // 6-1. 제목/설명 번역 (크레딧 모드 — 자막과 별도 mini job)
    if ((settings.translateTitle || settings.translateDescription) && !state.shouldStop) {
      try {
        await translateAndUploadMetadataCredits(
          videoId, videoSnippet, settings.targetLangs,
          getLangName(trackInfo.language), settings
        );
      } catch (err) {
        log(`제목/설명 번역 실패: ${err.message}`, LOG_LEVEL.WARN);
      }
    }

    // 7. job 완료 처리 → 크레딧 차감 (신규 번역이 있었을 때만)
    if (jobId) {
      const finalStatus = state.shouldStop ? 'stopped' : 'completed';
      await updateTranslationJob(jobId, { status: finalStatus });
    }

    // 8. 잔여 크레딧 조회
    let creditsRemaining = 0;
    try {
      const updated = await fetchCredits();
      creditsRemaining = updated.balance;
    } catch (err) {
      log(`잔여 크레딧 조회 실패: ${err.message}`, LOG_LEVEL.WARN);
    }

    const successCount = uploadedCount;
    await reportTranslationResult({ videoId, errors, total: allUploadLangs.length, success: successCount });

    const savedTabId   = state.tabId;
    resetState();
    broadcast({
      type: MSG.TRANSLATION_COMPLETE,
      successCount: successCount,
      errors,
      creditsRemaining,
    }, savedTabId);

  } catch (err) {
    log(err.message, LOG_LEVEL.ERROR, { action: 'runTranslationCredits' });
    await reportError(err, { action: 'runTranslationCredits' });

    if (jobId) {
      await updateTranslationJob(jobId, { status: 'failed', error_message: err.message })
        .catch(e => log(`job 상태 업데이트 실패: ${e.message}`, LOG_LEVEL.WARN));
    }

    const savedTabId = state.tabId;
    resetState();
    broadcast({ type: MSG.TRANSLATION_ERROR, error: friendlyError(err) }, savedTabId);
  } finally {
    if (state.isRunning) resetState();
  }
}

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG.START_TRANSLATION) {
    if (state.isRunning) { sendResponse({ error: '이미 진행 중입니다.' }); return; }

    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'YouTube Studio 페이지에서 사이드바를 통해 번역을 시작해 주세요.' });
      return;
    }

    const { settings } = message;
    if (settings.translationMode === TRANSLATION_MODES.CREDITS) {
      runTranslationCredits(tabId, settings);
    } else {
      runTranslationApiKey(tabId, settings);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === MSG.STOP_TRANSLATION) {
    log('사용자가 번역을 중지했습니다.', LOG_LEVEL.INFO);
    state.shouldStop = true;
    sendResponse({ ok: true });
    return;
  }

  if (message.type === MSG.GET_STATUS) {
    sendResponse({ state: state.isRunning ? 'working' : 'idle', ...state });
    return;
  }

  if (message.type === MSG.LOG_ERROR) {
    reportError(new Error(message.error), message.context || {});
    return;
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: message.url });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'GET_CREDITS') {
    fetchCredits()
      .then(data => sendResponse({ balance: data.balance }))
      .catch(err => sendResponse({ balance: null, error: err.message }));
    return true; // 비동기 응답
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  const settings = await loadSettings();
  if (settings.sentryDsn) await initSentry(settings.sentryDsn);
});

// ── 외부 웹페이지(silver-smiths.com) → 익스텐션 통신 ─────────────────────────
// manifest.json의 externally_connectable로 silver-smiths.com만 허용
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== 'https://silver-smiths.com') return;

  if (message.type === 'YTAT_REQUEST_CHECKOUT') {
    const { amount, currency } = message;
    createCheckout(amount, currency)
      .then(data => sendResponse({ ok: true, orderId: data.order_id }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'YTAT_GET_AUTH_TOKEN') {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        sendResponse({ ok: false });
      } else {
        sendResponse({ ok: true, token });
      }
    });
    return true;
  }
});

console.log('[YT-Auto-Translator] Service worker v2 초기화 완료');
