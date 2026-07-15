import { MSG, TARGET_LANGUAGES, getChunkSize } from '../lib/constants.js';
import { loadSettings } from '../lib/storage.js';
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
  getVideoLocalizations,
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
  if (msg.includes('credits_fetch_failed') || msg.includes('create_job_failed') ||
      msg.includes('update_job_failed') || msg.includes('checkout_failed')) {
    return '번역 서버 연결에 실패했습니다. 페이지를 새로고침 후 다시 시도해 주세요.';
  }
  if (msg.includes('401') || msg.includes('api_key_invalid') ||
      msg.includes('api key not valid') || msg.includes('invalid api key')) {
    return '일시적인 서버 오류가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 문의해 주세요.';
  }
  if (msg.includes('403') || msg.includes('forbidden') ||
      msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return '권한 오류가 발생했습니다. 해당 영상의 소유자 계정으로 YouTube에 로그인되어 있는지 확인해 주세요.';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') ||
      msg.includes('resource_exhausted') || msg.includes('too many requests')) {
    return 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
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

  if (msg.includes('quotaexceeded') || msg.includes('할당량') ||
      (msg.includes('quota') && msg.includes('exceeded'))) {
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
  return `[${langName}] 자막 등록 실패 (${err?.message || '알 수 없는 오류'}) — 문제가 계속되면 설정 화면의 📝 문의하기로 알려주세요.`;
}

function broadcast(message, tabId = state.tabId) {
  chrome.runtime.sendMessage(message).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// 처리 이력을 SW가 직접 storage에 저장 (사이드바 탭이 닫혀도 기록 유지, 최대 100건).
// 완료/실패 시 record를 만들어 저장 + broadcast에 함께 실어 사이드바 화면도 갱신.
const MAX_HISTORY = 100;
async function saveHistoryToStorage(record) {
  try {
    const r = await chrome.storage.local.get('ytatHistory');
    const list = [record, ...(r.ytatHistory || [])].slice(0, MAX_HISTORY);
    await chrome.storage.local.set({ ytatHistory: list });
  } catch (e) {
    log(`이력 저장 실패: ${e.message}`, LOG_LEVEL.WARN);
  }
}
function nowISO() { return new Date().toISOString(); }

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

async function prepareSubtitles(tabId, settings, needSubtitles = true) {
  const tab = await chrome.tabs.get(tabId);
  const videoId = extractVideoId(tab.url);
  if (!videoId) throw new Error('YouTube 영상 ID를 찾을 수 없습니다.');

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: 'YouTube 인증 중...', current: 0, total: state.progress.total });
  await authorizeYouTube();

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '영상 정보 조회 중...', current: 0, total: state.progress.total });
  const videoSnippet = await getVideoDetails(videoId);

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '원본 자막 확인 중...', current: 0, total: state.progress.total });
  const existingCaptions = await listCaptions(videoId);

  // 자막 번역이 필요 없으면(제목/설명만) 자막 다운로드(200 units)를 건너뛰어 API 절약.
  // 원본 언어는 영상 메타데이터로 대체.
  if (!needSubtitles) {
    const lang = videoSnippet?.defaultLanguage || videoSnippet?.defaultAudioLanguage || settings.sourceLang || 'auto';
    return {
      videoId, videoSnippet, existingCaptions,
      subtitles: [],
      trackInfo: { language: lang, trackKind: 'none', isASR: false },
    };
  }

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '원본 자막 불러오는 중...', current: 0, total: state.progress.total });
  const wantMeta = settings.translateTitle || settings.translateDescription;
  try {
    const { subtitles, trackInfo } = await fetchSourceSubtitles(
      existingCaptions,
      settings.sourceLang,
      videoSnippet?.defaultLanguage,
      videoSnippet?.defaultAudioLanguage
    );
    if (!subtitles.length) throw new Error('원본 자막 내용이 비어 있습니다.');
    return { videoId, videoSnippet, subtitles, trackInfo, existingCaptions };
  } catch (subErr) {
    // 자막 준비 실패: 제목/설명 번역이 켜져 있으면 자막만 포기하고 메타는 살린다.
    // 자막만 원한 경우엔 그대로 실패 처리.
    if (!wantMeta) throw subErr;
    const lang = videoSnippet?.defaultLanguage || videoSnippet?.defaultAudioLanguage || settings.sourceLang || 'auto';
    return {
      videoId, videoSnippet, existingCaptions,
      subtitles: [],
      trackInfo: { language: lang, trackKind: 'none', isASR: false },
      subtitlesError: subErr.message,
    };
  }
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

// ── 제목/설명 번역 — 크레딧 모드 ──────────────────────────────────────────────

async function translateAndUploadMetadataCredits(videoId, snippet, targetLangs, sourceLangName, settings) {
  const items = [];
  if (settings.translateTitle       && snippet?.title)       items.push({ text: snippet.title });
  if (settings.translateDescription && snippet?.description) items.push({ text: snippet.description.slice(0, 3000) });
  if (!items.length || !targetLangs.length) return;

  // 이미 제목/설명이 등록된 언어는 건너뜀 (반복 실행 시 재번역·재과금 방지)
  let metaTargets = targetLangs;
  try {
    const existing = await getVideoLocalizations(videoId);
    metaTargets = targetLangs.filter(code => {
      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      const ytCode = lang?.ytCode || code;
      const loc = existing[ytCode];
      if (!loc) return true; // 등록 이력 없음 → 번역
      // 요청한 필드가 이미 다 있으면 스킵
      const titleDone = !settings.translateTitle       || !!loc.title;
      const descDone  = !settings.translateDescription || !!loc.description;
      return !(titleDone && descDone);
    });
  } catch (e) {
    log(`기존 localization 조회 실패(전체 번역 진행): ${e.message}`, LOG_LEVEL.WARN);
  }
  if (!metaTargets.length) return; // 전부 이미 등록됨
  targetLangs = metaTargets;

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '제목/설명 번역 중...', current: 0, total: 1 });

  const { job_id: metaJobId } = await createTranslationJob({
    video_id:     videoId,
    job_type:     'title_desc', // 스키마 check 제약: ('subtitles','title_desc','all')
    source_lang:  sourceLangName,
    target_langs: targetLangs,
    model:        'gemini-2.5-flash',
  });

  const langBatches  = chunkArray(targetLangs, MAX_LANGS_PER_CALL);
  const localizations = {};
  let metaFailCount = 0;

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
        // 번역이 누락된 필드는 업로드에서 제외 (빈 값으로 기존 localization 덮어쓰기 방지)
        const translated = result.translations[code] || [];
        const entry = {};
        let idx = 0;
        if (settings.translateTitle) {
          const t = translated[idx++];
          if (t) entry.title = t;
        }
        if (settings.translateDescription) {
          const d = translated[idx];
          if (d) entry.description = d;
        }
        if (Object.keys(entry).length) localizations[lang.ytCode] = entry;
      }
    } catch (err) {
      metaFailCount++;
      log(`메타데이터 번역 실패 (${langBatch.join(',')}): ${err.message}`, LOG_LEVEL.WARN);
    }
  }

  await updateTranslationJob(metaJobId, { status: 'completed' });

  if (Object.keys(localizations).length) {
    await updateVideoLocalizations(videoId, localizations);
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '제목/설명 등록 완료 ✓', current: 1, total: 1 });
  } else if (metaFailCount > 0) {
    // 전 배치 실패 — 침묵하지 않고 사용자에게 안내
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '⚠️ 제목/설명 번역에 실패했습니다. 자막 결과에는 영향이 없습니다.', current: 1, total: 1 });
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
  let vId = null, vTitle = null; // 실패 broadcast에서도 영상 식별용 (catch 스코프 공유)

  try {
    // 1. 잔액 조회 (실제 검증은 신규 번역이 필요한 경우에만)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: '크레딧 잔액 확인 중...', current: 0, total: state.progress.total });
    const { balance, pricing } = await fetchCredits();

    // 2. YouTube 인증 + 자막 가져오기 (자막 OFF면 다운로드 스킵 → API 절약)
    const needSubtitles = settings.translateSubtitles !== false;
    const { videoId, videoSnippet, subtitles: sourceSubtitles, trackInfo, existingCaptions, subtitlesError } =
      await prepareSubtitles(tabId, settings, needSubtitles);
    vId = videoId;
    vTitle = videoSnippet?.title || videoId;

    // 자막 준비는 실패했지만 제목/설명 번역은 살아남은 경우 — 자막만 건너뜀
    if (subtitlesError) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: '⚠️ 원본 자막이 없어 자막 번역은 건너뜁니다. 제목/설명만 번역합니다.',
        current: 0, total: state.progress.total,
      });
    }

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? '(자동생성)' : '(수동업로드)';
    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `원본 감지: ${sourceLangName} ${trackKindLabel}`,
      current: 0, total: state.progress.total,
    });

    // 3. 대상 언어 필터링
    let { targetLangs, alreadyTranslated } = filterTargetLangs(settings, trackInfo, existingCaptions);
    if (settings.translateSubtitles === false || subtitlesError) {
      targetLangs = [];        // 자막 OFF이거나 원본 자막이 없으면 자막 번역 스킵
      alreadyTranslated = [];
    }

    if (alreadyTranslated.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💡 이미 ${alreadyTranslated.join(', ')} 언어로 번역된 자막이 있어 건너뜁니다.`,
        current: 0, total: targetLangs.length,
      });
    }

    if (targetLangs.length === 0 && !(settings.translateTitle || settings.translateDescription)) {
      const savedTabId = state.tabId;
      resetState();
      const record = {
        ts: nowISO(), videoId, videoTitle: videoSnippet?.title || videoId,
        items: [], successCount: 0, failCount: 0, allSkipped: true,
      };
      await saveHistoryToStorage(record);
      broadcast({ type: MSG.TRANSLATION_COMPLETE, record }, savedTabId);
      return;
    }

    // 3-1. 이전 업로드 실패 번역 캐시 확인 → 해당 언어는 번역 생략하고 바로 업로드
    const cached = await getSavedTranslations(videoId);
    // 원본 자막 개수와 일치하는 캐시만 복원 (자막 수정 후 재시도 시 인덱스 엇갈림 방지)
    const cachedLangs   = cached ? targetLangs.filter(c => cached.langResults?.[c]?.length === sourceSubtitles.length) : [];
    let remainingLangs = targetLangs.filter(c => !cachedLangs.includes(c));

    // 3-2. 시작 전 비용 추정 — 잔액으로 감당 가능한 언어 수만 번역 + 예상 차감액 안내
    if (remainingLangs.length > 0 && pricing) {
      const totalChars   = sourceSubtitles.reduce((s, x) => s + (x.text?.length || 0), 0);
      const estTokens    = Math.ceil(totalChars * 1.2); // 보수적 토큰 추정 (한국어 1자 ≈ 1토큰 + 여유분)
      // 입력은 언어 3개씩 배치로 공유, 출력은 언어당 원문 분량만큼 발생
      const estCostPerLang =
        ((estTokens / MAX_LANGS_PER_CALL + 500) * pricing.input_per_m + estTokens * pricing.output_per_m)
        / 1_000_000 * pricing.multiplier;

      const affordable = Math.floor(balance / estCostPerLang);
      if (affordable <= 0) throw new Error('INSUFFICIENT_CREDITS');
      if (affordable < remainingLangs.length) {
        const kept    = remainingLangs.slice(0, affordable);
        const dropped = remainingLangs.slice(affordable)
          .map(c => TARGET_LANGUAGES.find(l => l.code === c)?.name || c);
        remainingLangs = kept;
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          langName: `⚠️ 잔액 기준 ${affordable}개 언어만 번역합니다. 제외: ${dropped.join(', ')} — 충전 후 다시 시작하면 이어서 번역됩니다.`,
          current: 0, total: targetLangs.length,
        });
      }

      // 시작 전 예상 차감액 안내 (선불 차감형 서비스 — 사용자가 금액을 알고 시작하도록)
      const estTotal = Math.round(estCostPerLang * remainingLangs.length);
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `💳 예상 차감 약 ${estTotal.toLocaleString('ko-KR')} 크레딧 (${remainingLangs.length}개 언어) · 실제 사용량 기준 정산`,
        current: 0, total: targetLangs.length,
      });
    }

    // 언어 칩 초기화용 — 번역 대상 언어 목록을 사이드바에 전달 (pending 칩 표시)
    if (remainingLangs.length > 0 || cachedLangs.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: '번역을 시작합니다...',
        current: 0, total: targetLangs.length,
        targetLangs: [...remainingLangs, ...cachedLangs],
      });
    }

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
            langName: `번역 중... (${chunksCompleted}/${totalChunks})`,
            current: chunksCompleted, total: totalChunks,
            isChunkUpdate: true, // 청크마다 로그 카드로 쌓이지 않도록 (라벨/진행바만 갱신)
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
        errors.push({ lang: lang.name, message: '번역 실패' });
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
        // perLang: 작업 전체 실패가 아니라 개별 언어 실패 — sidebar가 종료/이력저장 하지 않도록 구분
        broadcast({ type: MSG.TRANSLATION_ERROR, error: detail, lang: code, perLang: true });
      }
    }

    // 중지로 업로드를 시도하지 못한 언어도 캐시 저장 대상에 포함 (번역 결과 유실 방지 — 과금은 이미 발생)
    if (state.shouldStop) {
      for (const code of allUploadLangs) {
        if (!uploadSucceeded.includes(code) && !uploadFailed.includes(code) &&
            !failedLangs.has(code) && allLangResults[code]?.length) {
          uploadFailed.push(code);
        }
      }
    }

    // 업로드 성공 언어 캐시 삭제, 실패 언어 캐시 저장 (번역된 언어만)
    await clearSavedTranslations(videoId, uploadSucceeded);
    await saveTranslations(videoId, allLangResults, uploadFailed);

    // 6-1. 제목/설명 번역 (크레딧 모드 — 자막과 별도 mini job)
    let metaDone = false;
    if ((settings.translateTitle || settings.translateDescription) && !state.shouldStop) {
      try {
        await translateAndUploadMetadataCredits(
          videoId, videoSnippet, settings.targetLangs,
          getLangName(trackInfo.language), settings
        );
        metaDone = true;
      } catch (err) {
        log(`제목/설명 번역 실패: ${err.message}`, LOG_LEVEL.WARN);
      }
    }

    // 7. job 완료 처리 → 크레딧 차감 (신규 번역이 있었을 때만)
    // 자막 업로드는 이미 끝났으므로, PATCH 실패가 "전체 실패"로 오보고되지 않도록 catch로 격리
    if (jobId) {
      const finalStatus = state.shouldStop ? 'stopped' : 'completed';
      await updateTranslationJob(jobId, { status: finalStatus })
        .catch(e => log(`job 완료 처리 실패 (업로드는 완료됨): ${e.message}`, LOG_LEVEL.WARN));
    }

    // 8. 잔여 크레딧 조회 (실패 시 null — 이력에 금액을 오표기하지 않기 위해)
    let creditsRemaining = null;
    try {
      const updated = await fetchCredits();
      creditsRemaining = updated.balance;
    } catch (err) {
      log(`잔여 크레딧 조회 실패: ${err.message}`, LOG_LEVEL.WARN);
    }

    const successCount = uploadedCount;
    await reportTranslationResult({ videoId, errors, total: allUploadLangs.length, success: successCount });

    // 처리 이력용 언어별 결과 (성공/실패)
    const historyItems = allUploadLangs.map(code => {
      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      return {
        code,
        name: lang?.nativeName || code,
        ok:   uploadSucceeded.includes(code),
      };
    });
    // 잔액 조회가 성공했을 때만 차감액 계산 (실패 시 null → 이력에 금액 미표시)
    const creditsUsed = (creditsRemaining != null && balance != null)
      ? Math.max(0, balance - creditsRemaining)
      : null;

    const savedTabId   = state.tabId;
    const wasStopped   = state.shouldStop;
    resetState();

    const record = {
      ts:           nowISO(),
      videoId,
      videoTitle:   videoSnippet?.title || videoId,
      items:        historyItems,
      skippedLangs: alreadyTranslated || [],
      metaTitle:    metaDone && settings.translateTitle,
      metaDesc:     metaDone && settings.translateDescription,
      successCount, failCount: errors.length,
      creditsUsed, creditsRemaining,
      stopped:      wasStopped,
    };
    await saveHistoryToStorage(record);
    broadcast({ type: MSG.TRANSLATION_COMPLETE, record, creditsRemaining }, savedTabId);

  } catch (err) {
    log(err.message, LOG_LEVEL.ERROR, { action: 'runTranslationCredits' });
    await reportError(err, { action: 'runTranslationCredits' });

    if (jobId) {
      await updateTranslationJob(jobId, { status: 'failed', error_message: err.message })
        .catch(e => log(`job 상태 업데이트 실패: ${e.message}`, LOG_LEVEL.WARN));
    }

    const savedTabId = state.tabId;
    resetState();
    const errText = friendlyError(err);
    const record = {
      ts: nowISO(), videoId: vId, videoTitle: vTitle,
      items: [], successCount: 0, failCount: 1, errorText: errText,
    };
    await saveHistoryToStorage(record);
    broadcast({ type: MSG.TRANSLATION_ERROR, error: errText, record }, savedTabId);
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
    runTranslationCredits(tabId, settings);
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
