/**
 * Background Service Worker
 *
 * - YouTube Captions API 기반 번역 오케스트레이션
 * - 병렬 번역 (5개씩 Promise.allSettled)
 * - Cloudflare Worker 경유 텔레그램 에러 알림
 */
import { MSG, TARGET_LANGUAGES } from '../lib/constants.js';
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

installGlobalErrorHandler('background');

// =============================================
// 유틸리티
// =============================================

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * 언어 코드 정규화 (ko-KR → ko)
 */
function normalizeLangCode(code) {
  if (!code) return '';
  return code.split('-')[0].toLowerCase();
}

/**
 * 언어 코드 → 표시 이름
 */
function getLangName(code) {
  if (!code) return 'Unknown';
  const norm = normalizeLangCode(code);
  const lang = TARGET_LANGUAGES.find(l =>
    normalizeLangCode(l.code) === norm || normalizeLangCode(l.ytCode) === norm
  );
  if (lang) return `${lang.name} (${lang.nativeName})`;
  return code;
}

/**
 * 기술적 오류 메시지 → 사용자 친화적 안내 메시지로 변환
 */
function friendlyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();

  // Google 계정 / OAuth 오류
  if (msg.includes('bad client id') || msg.includes('oauth') || msg.includes('auth token') ||
      msg.includes('getauthtoken') || msg.includes('identity')) {
    return 'Google 계정 연동에 문제가 발생했습니다. 페이지를 새로고침 후 다시 시도해 주세요. 문제가 반복되면 Chrome을 재시작해 주세요.';
  }

  // API 키 오류 (401, 키 무효)
  if (msg.includes('401') || msg.includes('api_key_invalid') ||
      msg.includes('api key not valid') || msg.includes('invalid api key') ||
      msg.includes('invalid_api_key')) {
    return 'Gemini API 키가 올바르지 않습니다. ⚙️ 설정 페이지에서 API 키를 다시 확인해 주세요.';
  }

  // 권한 / 접근 거부 (403)
  if (msg.includes('403') || msg.includes('forbidden') ||
      msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return '권한 오류가 발생했습니다. 해당 영상의 소유자 계정으로 YouTube에 로그인되어 있는지 확인해 주세요.';
  }

  // 요청 한도 초과 (429, quota)
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') ||
      msg.includes('resource_exhausted') || msg.includes('too many requests')) {
    return 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도하거나, ⚙️ 설정에서 유료 플랜으로 전환해 주세요.';
  }

  // 네트워크 오류
  if (msg.includes('failed to fetch') || msg.includes('networkerror') ||
      msg.includes('err_network') || msg.includes('timeout') || msg.includes('econnrefused')) {
    return '네트워크 연결을 확인해 주세요. 인터넷 연결 후 다시 시도해 주세요.';
  }

  // 자막 없음
  if (msg.includes('subtitle') || msg.includes('자막') || msg.includes('caption')) {
    return '영상에 원본 자막이 없습니다. YouTube Studio에서 자막을 먼저 추가한 뒤 번역을 시작해 주세요.';
  }

  // YouTube 영상 ID / 페이지 오류
  if (msg.includes('video id') || msg.includes('videoid') || msg.includes('영상 id')) {
    return 'YouTube Studio 영상 수정 페이지에서만 사용할 수 있습니다. 올바른 페이지에 접속한 뒤 다시 시도해 주세요.';
  }

  // 알 수 없는 오류 — 친절한 기본 메시지
  return '번역 중 오류가 발생했습니다. 페이지를 새로고침 후 다시 시도해 주세요. 문제가 계속되면 ⚙️ 설정 > 앱 로그에서 자세한 내용을 확인해 주세요.';
}

/**
 * Popup + Content Script 양쪽으로 메시지 브로드캐스트
 */
function broadcast(message, tabId = state.tabId) {
  chrome.runtime.sendMessage(message).catch(e => console.warn('[YT-Translator] broadcast(popup) 실패:', e?.message));
  if (tabId) {
    chrome.tabs.sendMessage(tabId, message).catch(e => console.warn('[YT-Translator] broadcast(content) 실패:', e?.message));
  }
}

// =============================================
// 상태
// =============================================

let state = {
  isRunning: false,
  shouldStop: false,
  currentLang: null,
  progress: { current: 0, total: 0 },
  targetLangs: [],
  tabId: null
};

function resetState() {
  state = {
    isRunning: false, shouldStop: false, currentLang: null,
    progress: { current: 0, total: 0 }, targetLangs: [], tabId: null
  };
}

// =============================================
// 메인 오케스트레이터
// =============================================

async function runTranslation(tabId, settings) {
  // 구형 Gemini 모델 ID 보정 (v1beta 전환 전 설정값 대응)
  if (settings.selectedModel === 'gemini-2.0-flash-exp') {
    log('구형 모델 ID(gemini-2.0-flash-exp) 감지. gemini-2.0-flash로 보정.', LOG_LEVEL.WARN);
    settings.selectedModel = 'gemini-2.0-flash';
  }

  state = {
    isRunning: true,
    shouldStop: false,
    currentLang: null,
    tabId,
    targetLangs: settings.targetLangs,
    progress: { current: 0, total: settings.targetLangs.length }
  };

  // 요금제에 맞는 Rate Limit 설정
  const rateKey = settings.geminiTier === 'paid'
    ? `paid_${settings.paidSpeed || 'normal'}`
    : 'free';
  configureRateLimit(rateKey);

  if (settings.sentryDsn) await initSentry(settings.sentryDsn);

  log(`번역 시작 — 탭 ${tabId}, 모델: ${settings.selectedModel}, 언어 수: ${settings.targetLangs.length}, 속도: ${rateKey}`, LOG_LEVEL.INFO);

  const errors = [];

  try {
    // 1. 탭 URL에서 영상 ID 추출
    const tab = await chrome.tabs.get(tabId);
    const videoId = extractVideoId(tab.url);
    if (!videoId) throw new Error('YouTube 영상 ID를 찾을 수 없습니다. 유튜브 스튜디오 영상 수정 페이지인지 확인해 주세요.');

    // 2. YouTube OAuth 인증
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: 'YouTube 인증 중...', current: 0, total: state.progress.total });
    await authorizeYouTube();

    // 3. 영상 정보 조회 (소스 언어 자동 감지용)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '영상 정보 조회 중...', current: 0, total: state.progress.total });
    const videoSnippet = await getVideoDetails(videoId);
    const videoDefaultLang = videoSnippet?.defaultLanguage;
    const videoAudioDefaultLang = videoSnippet?.defaultAudioLanguage;
    log(`영상 기본 언어: ${videoDefaultLang}, 오디오 언어: ${videoAudioDefaultLang}`, LOG_LEVEL.DEBUG);

    // 4. 자막 목록 조회 + 원본 자막 선정 (5단계 우선순위)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '원본 자막 불러오는 중...', current: 0, total: state.progress.total });
    const existingCaptions = await listCaptions(videoId);

    const { subtitles: sourceSubtitles, trackInfo } = await fetchSourceSubtitles(
      existingCaptions,
      settings.sourceLang,
      videoDefaultLang,
      videoAudioDefaultLang
    );

    if (!sourceSubtitles.length) throw new Error('원본 자막 내용이 비어 있습니다.');

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? '(자동생성)' : '(수동업로드)';
    log(`원본 자막 선정: ${sourceLangName} ${trackKindLabel}, ID: ${trackInfo.id}`, LOG_LEVEL.INFO);

    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `원본 감지: ${sourceLangName} ${trackKindLabel}`,
      current: 0,
      total: state.progress.total
    });

    // 5. 대상 언어 필터링
    const normSourceLang = normalizeLangCode(trackInfo.language);
    const alreadyTranslated = []; // 이미 번역된 언어 이름 목록 (안내용)

    const targetLangs = settings.targetLangs.filter(code => {
      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      if (!lang) return false;

      const normTarget   = normalizeLangCode(code);
      const normYtTarget = normalizeLangCode(lang.ytCode);

      // 원본과 동일 언어 스킵 (auto 모드에서만)
      if ((normTarget === normSourceLang || normYtTarget === normSourceLang) &&
          settings.sourceLang === 'auto' && !trackInfo.isASR) {
        log(`동일 언어 스킵: ${lang.name}`, LOG_LEVEL.INFO);
        return false;
      }

      // 이미 standard 자막이 존재하는 언어 스킵
      const hasExisting = existingCaptions.some(c =>
        normalizeLangCode(c.snippet?.language) === normYtTarget &&
        c.snippet?.trackKind === 'standard'
      );
      if (hasExisting) {
        log(`이미 번역된 자막 스킵: ${lang.name}`, LOG_LEVEL.INFO);
        alreadyTranslated.push(lang.name);
        return false;
      }

      return true;
    });

    // 이미 번역된 언어가 있으면 사용자에게 안내
    if (alreadyTranslated.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💡 이미 ${alreadyTranslated.join(', ')} 언어로 번역된 자막이 있어 건너뜁니다. 소중한 API 토큰을 아꼈습니다 🎉`,
        current: 0,
        total: targetLangs.length
      });
    }

    // 건너뛴 후 번역할 언어가 없으면 바로 완료 처리
    if (targetLangs.length === 0) {
      const tabIdBeforeReset = state.tabId;
      resetState();
      broadcast({ type: MSG.TRANSLATION_COMPLETE, count: 0, errors: [], allSkipped: true }, tabIdBeforeReset);
      return;
    }

    // 6. 병렬 번역 + 업로드 (3개씩 — 무료 티어 RPM 한도 대응)
    const chunks = chunkArray(targetLangs, 3);
    let completed = 0;

    // 청크 기반 전체 진행률 계산
    const totalChunksPerLang = Math.ceil(sourceSubtitles.length / CHUNK_SIZE);
    const totalAllChunks     = targetLangs.length * totalChunksPerLang;
    let   globalChunksDone   = 0;

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
            current: globalChunksDone,
            total: totalAllChunks
          });

          try {
            // 번역 (Gemini API Key 방식)
            const translated = await translateSubtitles({
              apiKey: settings.geminiApiKey || '',
              model: settings.selectedModel,
              sourceLang: sourceLangName,
              targetLang: lang.name,
              subtitles: sourceSubtitles,
              onChunkProgress: (chunkDone, chunkTotal) => {
                globalChunksDone++;
                broadcast({
                  type: MSG.TRANSLATION_PROGRESS,
                  lang: langCode,
                  langName: `[${lang.name}] 번역 중... (${chunkDone}/${chunkTotal} 청크)`,
                  current: globalChunksDone,
                  total: totalAllChunks,
                  isChunkUpdate: true
                });
              }
            });

            // YouTube Captions API로 업로드
            await uploadCaption(videoId, lang.ytCode, subtitlesToSRT(translated), existingCaptions);

            completed++;
            log(`[${lang.name}] 업로드 완료`, LOG_LEVEL.INFO);
            broadcast({
              type: MSG.TRANSLATION_PROGRESS,
              lang: langCode,
              langName: `[${lang.name}] 완료 ✓`,
              current: globalChunksDone,
              total: totalAllChunks,
              done: true
            });

          } catch (err) {
            completed++;
            errors.push({ lang: lang.name, message: err.message });
            await reportError(err, { action: 'translate_upload', currentLang: lang.name });
            broadcast({ type: MSG.TRANSLATION_ERROR, error: `${lang.name}: ${friendlyError(err)}`, lang: langCode });
          }
        })
      );

      // 청크 간 딜레이 (Rate Limit 방지)
      if (!state.shouldStop && settings.delayMin > 0) {
        await new Promise(r => setTimeout(r, settings.delayMin));
      }
    }

    // 7. 완료
    const successCount = targetLangs.length - errors.length;
    log(`번역 완료 — 성공: ${successCount}개, 실패: ${errors.length}개`, LOG_LEVEL.INFO);

    // tabId를 저장한 뒤 resetState()를 먼저 호출해 레이스 컨디션을 방지한다.
    // (resetState → broadcast 순서로 GET_STATUS가 idle을 반환하게 됨)
    // broadcast()에 savedTabId를 명시적으로 전달해야 한다.
    // resetState()가 state.tabId를 null로 초기화하기 때문.
    const savedTabId = state.tabId;
    resetState();
    broadcast({ type: MSG.TRANSLATION_COMPLETE, count: successCount, errors }, savedTabId);

    // 실패 언어가 있으면 Worker 경유 텔레그램 알림
    await reportTranslationResult({
      videoId,
      errors,
      total: targetLangs.length,
      success: successCount
    });

  } catch (err) {
    log(err.message, LOG_LEVEL.ERROR, { action: 'run_translation' });
    const savedTabId = state.tabId; // resetState() 전에 저장
    resetState();
    await reportError(err, { action: 'run_translation', tabId: savedTabId });
    broadcast({
      type: MSG.TRANSLATION_ERROR,
      error: friendlyError(err)
    }, savedTabId);

  } finally {
    // try/catch 각 경로에서 이미 resetState() 호출됨.
    // 예외적 경로(미처리 에러 등)에 대한 안전망으로만 유지.
    if (state.isRunning) resetState();
  }
}

// =============================================
// 메시지 핸들러
// =============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG.START_TRANSLATION) {
    if (state.isRunning) { sendResponse({ error: '이미 진행 중입니다.' }); return; }
    // tabId: 메시지에 명시된 값 우선, 없으면 sender.tab.id (사이드바 content-script 발신 시)
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'YouTube Studio 페이지에서 사이드바를 통해 번역을 시작해 주세요.' }); return; }
    runTranslation(tabId, message.settings);
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
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  const settings = await loadSettings();
  if (settings.sentryDsn) await initSentry(settings.sentryDsn);
});

console.log('[YT-Auto-Translator] Service worker 초기화 완료 (Captions API + 병렬 번역 모드)');
