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
  subtitlesToSRT
} from '../lib/youtube-api.js';
import {
  fetchCredits,
  createTranslationJob,
  translateChunk,
  updateTranslationJob,
} from '../lib/backend-api.js';

installGlobalErrorHandler('background');

const MAX_CONCURRENT = 20;

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

  return { videoId, subtitles, trackInfo, existingCaptions };
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
    const { videoId, subtitles: sourceSubtitles, trackInfo, existingCaptions } =
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
      broadcast({ type: MSG.TRANSLATION_COMPLETE, count: 0, errors: [], allSkipped: true }, savedTabId);
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
    broadcast({ type: MSG.TRANSLATION_COMPLETE, count: successCount, errors }, savedTabId);

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
    // 1. 잔액 확인 (빠른 실패)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '크레딧 잔액 확인 중...', current: 0, total: state.progress.total });
    const { balance } = await fetchCredits();
    if (balance <= 0) throw new Error('INSUFFICIENT_CREDITS');

    // 2. YouTube 인증 + 자막 가져오기
    const { videoId, subtitles: sourceSubtitles, trackInfo, existingCaptions } =
      await prepareSubtitles(tabId, settings);

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? '(자동생성)' : '(수동업로드)';
    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `원본 감지: ${sourceLangName} ${trackKindLabel}`,
      current: 0, total: state.progress.total,
    });

    // 3. 대상 언어 필터링
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
      broadcast({ type: MSG.TRANSLATION_COMPLETE, count: 0, errors: [], allSkipped: true }, savedTabId);
      return;
    }

    // 4. 번역 job 생성
    const { job_id } = await createTranslationJob({
      video_id:    videoId,
      source_lang: trackInfo.language,
      target_langs: targetLangs,
      model: 'gemini-2.5-flash',
    });
    jobId = job_id;

    // 5. 청크 분할 + 병렬 번역
    const chunkSize  = getChunkSize(targetLangs.length);
    const subtitleChunks = chunkArray(sourceSubtitles, chunkSize);
    const totalChunks    = subtitleChunks.length;

    // lang → 번역 결과 배열 (청크 순서대로 누적)
    const langResults = {};
    for (const code of targetLangs) langResults[code] = [];

    let chunksCompleted = 0;
    let totalInputTokens = 0, totalOutputTokens = 0;

    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `번역 중... (0/${totalChunks} 청크)`,
      current: 0, total: totalChunks,
    });

    // MAX_CONCURRENT 단위로 청크 병렬 처리
    for (let i = 0; i < subtitleChunks.length; i += MAX_CONCURRENT) {
      if (state.shouldStop) break;

      const batch = subtitleChunks.slice(i, i + MAX_CONCURRENT);
      const batchOffset = i * chunkSize;

      const results = await Promise.allSettled(
        batch.map((chunk, bi) =>
          translateChunk({
            job_id:       jobId,
            subtitles:    chunk.map(s => ({ text: s.text })),
            offset:       batchOffset + bi * chunkSize,
            target_langs: targetLangs,
            source_lang:  sourceLangName,
            model:        'gemini-2.5-flash',
          })
        )
      );

      for (let bi = 0; bi < results.length; bi++) {
        const result = results[bi];
        const chunk  = batch[bi];

        if (result.status === 'fulfilled') {
          const { translations, tokens } = result.value;
          for (const code of targetLangs) {
            langResults[code].push(...(translations[code] || chunk.map(s => s.text)));
          }
          totalInputTokens  += tokens?.input  || 0;
          totalOutputTokens += tokens?.output || 0;
        } else {
          // 실패 청크 → 원본 텍스트 유지
          for (const code of targetLangs) {
            langResults[code].push(...chunk.map(s => s.text));
          }
          const chunkErr = result.reason?.message || '알 수 없는 오류';
          log(`청크 번역 실패: ${chunkErr}`, LOG_LEVEL.WARN);
          broadcast({ type: MSG.TRANSLATION_ERROR, error: `청크 번역 실패 (원본 유지): ${chunkErr}` });
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

    // 6. 언어별 YouTube 업로드
    const errors = [];
    for (const code of targetLangs) {
      if (state.shouldStop) break;

      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      if (!lang) continue;

      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        lang: code, langName: `[${lang.name}] 업로드 중...`,
        current: chunksCompleted, total: totalChunks,
      });

      try {
        // langResults[code]는 flat 텍스트 배열 → sourceSubtitles와 병합해 SRT 생성
        const translated = sourceSubtitles.map((s, i) => ({
          ...s,
          text: langResults[code][i] ?? s.text,
        }));
        await uploadCaption(videoId, lang.ytCode, subtitlesToSRT(translated), existingCaptions);
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          lang: code, langName: `[${lang.name}] 완료 ✓`,
          current: chunksCompleted, total: totalChunks,
          langDone: true,
        });
      } catch (err) {
        errors.push({ lang: lang.name, message: err.message });
        broadcast({ type: MSG.TRANSLATION_ERROR, error: `${lang.name}: ${friendlyError(err)}`, lang: code });
      }
    }

    // 7. job 완료 처리 → 크레딧 차감
    const finalStatus = state.shouldStop ? 'stopped' : 'completed';
    await updateTranslationJob(jobId, { status: finalStatus });

    // 8. 잔여 크레딧 조회
    let creditsRemaining = 0;
    try {
      const updated = await fetchCredits();
      creditsRemaining = updated.balance;
    } catch (err) {
      log(`잔여 크레딧 조회 실패: ${err.message}`, LOG_LEVEL.WARN);
    }

    const successCount = targetLangs.length - errors.length;
    await reportTranslationResult({ videoId, errors, total: targetLangs.length, success: successCount });

    const savedTabId   = state.tabId;
    resetState();
    broadcast({
      type: MSG.TRANSLATION_COMPLETE,
      count: successCount,
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

console.log('[YT-Auto-Translator] Service worker v2 초기화 완료');
