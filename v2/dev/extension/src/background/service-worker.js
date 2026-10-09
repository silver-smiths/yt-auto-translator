import { MSG, TARGET_LANGUAGES, getChunkSize, API_BASE } from '../lib/constants.js';
import { loadSettings } from '../lib/storage.js';
import { reportError, reportTranslationDetail, installGlobalErrorHandler, log, LOG_LEVEL, initSentry } from '../lib/logger.js';
import { t } from '../lib/i18n.js';
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
  resetUnitsUsed,
  getUnitsUsed,
} from '../lib/youtube-api.js';
import {
  fetchCredits,
  fetchReferral,
  applyReferral,
  createCheckout,
  createTranslationJob,
  translateChunk,
  updateTranslationJob,
  exchangeSession,
} from '../lib/backend-api.js';
import {
  getSavedTranslations,
  saveTranslations,
  clearSavedTranslations,
} from '../lib/translation-cache.js';

installGlobalErrorHandler('background');

// 콜당 언어 수 — 2개면 출력이 3개 대비 1/3 줄어 25s 타임아웃에 여유(실측 median 19s→~13s).
// 긴 영상은 언어당 청크가 20개+라 콜 하나만 타임아웃해도 그 언어가 통째로 실패하므로,
// 콜당 부담을 낮춰 1차 성공률을 올리는 게 완주율에 결정적. (재시도와 함께 동작)
const MAX_LANGS_PER_CALL = 2;
// 동시 Gemini 호출 상한 — 청크×언어배치가 폭증(긴 영상×다국어)해도 이 수를 넘지 않게 풀 실행.
// 넘치면 Gemini/릴레이가 한도·타임아웃으로 연쇄 실패(ALL_FALLBACKS_FAILED)하므로 안전값으로 고정.
const GEMINI_CONCURRENCY = 4;

// 청크 재시도 — 504/네트워크 등 "일시적" 실패는 백오프 두고 재시도해 회복.
// 긴 영상에서 청크 하나의 일시 실패가 언어 전체를 죽이는 것을 방지(0.75^21 붕괴 완화).
// 크레딧 부족·권한 오류는 재시도해도 소용없으므로 즉시 실패시킨다.
const CHUNK_MAX_RETRIES = 2;
function isTransientChunkError(msg) {
  return /ALL_FALLBACKS_FAILED|TRANSLATE_CHUNK_FAILED_5|Failed to fetch|NetworkError|network|timeout/i.test(msg || '');
}
async function translateChunkResilient(params) {
  let lastErr;
  for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    try {
      return await translateChunk(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientChunkError(err?.message) || attempt === CHUNK_MAX_RETRIES) throw err;
      // 지수 백오프(1s→2s) — 릴레이 과부하가 가라앉을 시간을 준 뒤 재시도
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// 한 번의 실행에서 시도할 라운드 수(1차 + 보수 2회). 남으면 재클릭으로 이어서 완성.
const MAX_TRANSLATE_ROUNDS = 3;
// 진행 저장 간격(완료 청크 수) — SW가 중간에 종료돼도 이만큼 이내의 작업만 재실행.
const PROGRESS_SAVE_EVERY = 20;

// 언어가 모든 라인 번역을 채웠는지 (빈칸=null 없이 total개 확보)
function isLangComplete(arr, total) {
  if (!Array.isArray(arr) || arr.length < total) return false;
  for (let i = 0; i < total; i++) if (arr[i] == null) return false;
  return true;
}

// 이번 라운드에 번역이 필요한 (청크, 언어배치) 목록 — 빠진 청크만, 청크별로 미완 언어를 배치.
// 재개 시 이미 채워진 청크는 건너뛰므로, 길이가 길어도 남은 것만 처리한다.
function buildMissingPairs(pendingLangs, langResults, subtitleChunks, chunkSize) {
  const pairs = [];
  for (let ci = 0; ci < subtitleChunks.length; ci++) {
    const off = ci * chunkSize;
    const len = subtitleChunks[ci].length;
    const need = pendingLangs.filter(code => {
      const arr = langResults[code];
      for (let j = 0; j < len; j++) if (arr[off + j] == null) return true;
      return false;
    });
    for (let b = 0; b < need.length; b += MAX_LANGS_PER_CALL) {
      pairs.push({ chunk: subtitleChunks[ci], offset: off, langBatch: need.slice(b, b + MAX_LANGS_PER_CALL) });
    }
  }
  return pairs;
}

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

// 언어 동일성 비교 키 — zh는 간체(Hans)/번체(Hant)를 구분해야 하므로 스크립트까지 반영
function langMatchKey(code) {
  const c = String(code || '').toLowerCase();
  const base = c.split('-')[0];
  if (base !== 'zh') return base;
  if (c.includes('hant') || c.includes('tw') || c.includes('hk') || c.includes('mo')) return 'zh-hant';
  if (c.includes('hans') || c.includes('cn') || c.includes('sg')) return 'zh-hans';
  return 'zh'; // 스크립트 불명 → 보수적으로 모든 zh 변형과 동일 취급
}

// 두 언어 코드가 같은 (쓰기) 언어인가 — zh 스크립트 구분, 불명 zh는 보수적으로 매칭
function sameLang(a, b) {
  const ka = langMatchKey(a), kb = langMatchKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if ((ka === 'zh' && kb.startsWith('zh')) || (kb === 'zh' && ka.startsWith('zh'))) return true;
  return false;
}

function getLangName(code) {
  if (!code) return 'Unknown';
  // sameLang로 zh 간체/번체를 구분 (번체 소스를 "간체"로 오식별하지 않도록)
  const lang = TARGET_LANGUAGES.find(l => sameLang(l.code, code) || sameLang(l.ytCode, code));
  if (lang) return `${lang.name} (${lang.nativeName})`;
  return code;
}

// 대상 언어 목록에서 (1) 지원 목록에 없는 코드(과거 제거된 yue 등)와 (2) 콘텐츠 기본(소스) 언어를 제외
// — 설정에 잔존한 유령 코드가 제목/설명 경로로 흘러가 과금되는 것을 방지
function excludeBaseLang(codes, baseLang) {
  return codes.filter(code => {
    const lang = TARGET_LANGUAGES.find(l => l.code === code);
    if (!lang) return false; // 지원하지 않는(제거된) 언어 코드 제외
    if (!baseLang) return true;
    return !sameLang(code, baseLang) && !sameLang(lang.ytCode, baseLang);
  });
}

function friendlyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();

  if (msg.includes('insufficient_credits')) {
    return t('feCredit');
  }
  if (msg.includes('auth_failed') || msg.includes('bad client id') || msg.includes('oauth') ||
      msg.includes('auth token') || msg.includes('identity')) {
    return t('feAuth');
  }
  if (msg.includes('credits_fetch_failed') || msg.includes('create_job_failed') ||
      msg.includes('update_job_failed') || msg.includes('checkout_failed')) {
    return t('feServer');
  }
  if (msg.includes('401') || msg.includes('api_key_invalid') ||
      msg.includes('api key not valid') || msg.includes('invalid api key')) {
    return t('feTemp');
  }
  if (msg.includes('403') || msg.includes('forbidden') ||
      msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return t('fePerm');
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') ||
      msg.includes('resource_exhausted') || msg.includes('too many requests')) {
    return t('feQuota');
  }
  if (msg.includes('all_fallbacks_failed')) {
    return t('feFallback');
  }
  if (msg.includes('failed to fetch') || msg.includes('networkerror') ||
      msg.includes('timeout') || msg.includes('econnrefused')) {
    return t('feNetwork');
  }
  if (msg.includes('subtitle') || msg.includes('자막') || msg.includes('caption')) {
    return t('feNoSub');
  }
  if (msg.includes('video id') || msg.includes('videoid') || msg.includes('영상 id')) {
    return t('feVideoPage');
  }
  return t('feDefault');
}

// ── 업로드 실패 상황별 상세 안내 메시지 ──────────────────────────────────────
function getUploadErrorMessage(err, langName) {
  const msg = (err?.message || String(err)).toLowerCase();

  if (msg.includes('quotaexceeded') || msg.includes('할당량') ||
      (msg.includes('quota') && msg.includes('exceeded'))) {
    return `[${langName}] ${t('ueQuota')}`;
  }
  if (msg.includes('forbidden') || msg.includes('insufficientpermissions') || msg.includes('access denied')) {
    return `[${langName}] ${t('uePerm')}`;
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid credentials') || msg.includes('auth')) {
    return `[${langName}] ${t('ueAuth')}`;
  }
  if (msg.includes('404') || msg.includes('not found') || msg.includes('videonotfound')) {
    return `[${langName}] ${t('ueNotFound')}`;
  }
  if (msg.includes('409') || msg.includes('duplicate') || msg.includes('already exists')) {
    return `[${langName}] ${t('ueDup')}`;
  }
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network')) {
    return `[${langName}] ${t('ueNetwork')}`;
  }
  if (msg.includes('500') || msg.includes('internal server')) {
    return `[${langName}] ${t('ueServer')}`;
  }
  return `[${langName}] ${t('ueDefault')} (${err?.message || t('ueUnknown')}) — ${t('ueContact')}`;
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

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgAuth'), current: 0, total: state.progress.total });
  await authorizeYouTube();

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgVideoInfo'), current: 0, total: state.progress.total });
  const videoSnippet = await getVideoDetails(videoId);

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgCheckSubs'), current: 0, total: state.progress.total });
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

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgLoadSubs'), current: 0, total: state.progress.total });
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

// 대상 언어에 이미 표준(수동 업로드/기존) 자막 트랙이 있는지
function hasStandardCaption(existingCaptions, ytCode) {
  return existingCaptions.some(c =>
    sameLang(c.snippet?.language, ytCode) && c.snippet?.trackKind === 'standard'
  );
}

// 대상 언어 중 아직 표준 자막이 없는(=새로 번역할) 언어가 하나라도 있는지.
// 원본 다운로드(200u) 전 판정용 — 기본언어 제외와 무관하게 '존재'만 확인해
// 소스언어 오판으로 다운로드를 잘못 건너뛰지 않도록 보수적으로 처리.
function hasUntranslatedSubtitleTarget(settings, existingCaptions) {
  return (settings.targetLangs || []).some(code => {
    const lang = TARGET_LANGUAGES.find(l => l.code === code);
    return lang && !hasStandardCaption(existingCaptions, lang.ytCode);
  });
}

function filterTargetLangs(settings, trackInfo, existingCaptions) {
  const sourceLang = trackInfo.language;
  const alreadyTranslated = [];

  const targetLangs = settings.targetLangs.filter(code => {
    const lang = TARGET_LANGUAGES.find(l => l.code === code);
    if (!lang) return false;

    // 콘텐츠 기본(소스) 언어는 설정 선택 여부·자동감지/ASR 여부와 무관하게 항상 제외
    // (zh 간체/번체는 서로 다른 언어로 취급 — sameLang가 스크립트 구분)
    if (sameLang(code, sourceLang) || sameLang(lang.ytCode, sourceLang)) {
      return false;
    }

    if (hasStandardCaption(existingCaptions, lang.ytCode)) {
      alreadyTranslated.push(lang.name); return false;
    }

    return true;
  });

  return { targetLangs, alreadyTranslated };
}

// ── 제목/설명 번역 — 크레딧 모드 ──────────────────────────────────────────────

// YouTube localization 제약(제목 100자·설명 5000자, '<' '>' 금지)에 맞춰 안전하게 자름.
// 한 언어라도 초과하면 YouTube가 localizations PUT 전체를 400(invalidVideoMetadata)으로 거부한다.
function clampLocalized(text, max) {
  const clean = String(text).replace(/[<>]/g, '');
  const cp = [...clean]; // 코드포인트 기준 길이 (CJK·이모지 안전)
  return cp.length > max ? cp.slice(0, max).join('').trimEnd() : clean;
}

// 실패 원인을 사용자 표시용 카테고리로 분류 (에러코드·원문 등 기술 상세는 UI에 노출 안 함).
function classifyFailure(rawMsg = '') {
  const m = String(rawMsg).toLowerCase();
  if (/402|insufficient_credits|크레딧/.test(m))                                    return '크레딧 부족';
  if (/quotaexceeded|할당량|일일 api 한도|quota.*exceeded|ratelimit|rate.?limit/.test(m)) return 'YouTube 일일 사용량 한도 소진';
  if (/409|duplicate|already.?exists|이미 해당 언어/.test(m))                        return '이미 등록된 자막 있음';
  if (/401|unauthorized|invalid credentials|인증 만료/.test(m))                     return '로그인 만료';
  if (/forbidden|insufficientpermissions|access denied|권한 오류/.test(m))          return '채널 권한 오류';
  if (/404|not found|videonotfound|영상을 찾을 수 없/.test(m))                       return '영상을 찾을 수 없음';
  if (/failed to fetch|networkerror|\bnetwork\b|네트워크/.test(m))                   return '네트워크 오류';
  return '일시적 오류';
}

async function translateAndUploadMetadataCredits(videoId, snippet, targetLangs, sourceLangName, settings, chargeUnits = false) {
  const items = [];
  if (settings.translateTitle       && snippet?.title)       items.push({ text: snippet.title });
  if (settings.translateDescription && snippet?.description) items.push({ text: snippet.description.slice(0, 3000) });
  if (!items.length || !targetLangs.length) return false;

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
  if (!metaTargets.length) return false; // 전부 이미 등록됨
  targetLangs = metaTargets;

  broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgMetaTranslating'), current: 0, total: 1 });

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
          if (t) entry.title = clampLocalized(t, 100); // YouTube 제목 100자 제한
        }
        if (settings.translateDescription) {
          const d = translated[idx];
          if (d) entry.description = clampLocalized(d, 5000); // YouTube 설명 5000자 제한
        }
        if (Object.keys(entry).length) localizations[lang.ytCode] = entry;
      }
    } catch (err) {
      metaFailCount++;
      log(`메타데이터 번역 실패 (${langBatch.join(',')}): ${err.message}`, LOG_LEVEL.WARN);
    }
  }

  // 자막 job이 없는(제목/설명만) 경우엔 quota를 여기서 정산 (자막 job이 있으면 그쪽이 정산)
  // success(등록된 언어 수)를 함께 보내 — 서버가 성공 0이면 과금 면제
  const metaSuccess = Object.keys(localizations).length;
  await updateTranslationJob(metaJobId,
    chargeUnits ? { status: 'completed', units: getUnitsUsed(), success: metaSuccess } : { status: 'completed', success: metaSuccess });

  if (Object.keys(localizations).length) {
    await updateVideoLocalizations(videoId, localizations);
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgMetaDone'), current: 1, total: 1 });
    return true;
  } else if (metaFailCount > 0) {
    // 전 배치 실패 — 침묵하지 않고 사용자에게 안내
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgMetaFail'), current: 1, total: 1 });
  }
  return false;
}

// ── 원격 설정(kill-switch) 조회 — 60초 캐시 ────────────────────────────────────
let _appConfig = { value: null, ts: 0 };
async function getAppConfig() {
  const now = Date.now();
  if (_appConfig.value && now - _appConfig.ts < 60000) return _appConfig.value;
  try {
    const res = await fetch(`${API_BASE}/ops/config`);
    if (res.ok) _appConfig = { value: await res.json(), ts: now };
  } catch { /* 실패 시 직전 캐시 사용 */ }
  return _appConfig.value || {};
}

// ── 크레딧 경로 (v2 신규) ──────────────────────────────────────────────────────

async function runTranslationCredits(tabId, settings) {
  // 원격 스위치 반영 — 백엔드 app_config (마스터/자막/메타/언어별 비활성)
  const cfg = await getAppConfig();
  if (cfg['translate.enabled'] === false) {
    broadcast({
      type: MSG.TRANSLATION_ERROR,
      error: '번역 기능이 일시 점검 중입니다.',
      record: { ts: nowISO(), videoId: '', videoTitle: '번역', items: [], failCount: 1,
                errorText: '번역 기능이 일시 점검 중입니다. 잠시 후 다시 시도해 주세요.' },
    }, tabId);
    return;
  }
  const disabledLangs = new Set(Array.isArray(cfg['lang.disabled']) ? cfg['lang.disabled'] : []);
  const cfgSubs = cfg['translate.subtitles.enabled'] !== false;
  const cfgMeta = cfg['translate.metadata.enabled'] !== false;
  settings = {
    ...settings,
    translateSubtitles:   settings.translateSubtitles !== false && cfgSubs,
    translateTitle:       !!settings.translateTitle && cfgMeta,
    translateDescription: !!settings.translateDescription && cfgMeta,
    targetLangs:          (settings.targetLangs || []).filter(c => !disabledLangs.has(c)),
  };

  state = {
    isRunning: true, shouldStop: false, currentLang: null,
    tabId, targetLangs: settings.targetLangs,
    progress: { current: 0, total: settings.targetLangs.length },
  };

  let jobId = null;
  let vId = null, vTitle = null; // 실패 broadcast에서도 영상 식별용 (catch 스코프 공유)

  resetUnitsUsed(); // 이번 번역의 YouTube quota(unit) 소비 집계 시작

  try {
    // 1. 잔액 조회 (실제 검증은 신규 번역이 필요한 경우에만)
    broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgCheckCredit'), current: 0, total: state.progress.total });
    const { balance, pricing } = await fetchCredits();

    // 2. YouTube 인증 + 영상/자막목록 조회 (다운로드 200u 없이 먼저 조회)
    const wantSubtitles = settings.translateSubtitles !== false;
    const prep = await prepareSubtitles(tabId, settings, false);
    const { videoId, videoSnippet, existingCaptions } = prep;
    vId = videoId;
    vTitle = videoSnippet?.title || videoId;

    // 2-1. 원본 자막 다운로드(200u)는 "새로 번역할 자막 언어가 있을 때"만 수행.
    //      이미 모든 대상 언어에 수동/기존 자막이 있으면(재실행 등) 다운로드를 건너뛰어 quota 절약.
    //      (사용자에게는 이 경우에도 여전히 0 크레딧 — 아무것도 등록하지 않으므로)
    let trackInfo = prep.trackInfo;
    let sourceSubtitles = [];
    let subtitlesError = null;
    if (wantSubtitles && hasUntranslatedSubtitleTarget(settings, existingCaptions)) {
      broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: t('pgLoadSubs'), current: 0, total: state.progress.total });
      const wantMeta = settings.translateTitle || settings.translateDescription;
      try {
        const src = await fetchSourceSubtitles(
          existingCaptions, settings.sourceLang,
          videoSnippet?.defaultLanguage, videoSnippet?.defaultAudioLanguage
        );
        if (!src.subtitles.length) throw new Error('원본 자막 내용이 비어 있습니다.');
        sourceSubtitles = src.subtitles;
        trackInfo       = src.trackInfo;
      } catch (subErr) {
        if (!wantMeta) throw subErr;      // 자막만 원했는데 실패 → 전체 실패
        subtitlesError = subErr.message;  // 제목/설명은 살림
      }
    }

    // 자막 준비는 실패했지만 제목/설명 번역은 살아남은 경우 — 자막만 건너뜀
    if (subtitlesError) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: t('pgNoSubs'),
        current: 0, total: state.progress.total,
      });
    }

    const sourceLangName = getLangName(trackInfo.language);
    const trackKindLabel = trackInfo.isASR ? t('pgASR') : t('pgManual');
    broadcast({
      type: MSG.TRANSLATION_PROGRESS,
      langName: `${t('pgDetected')}: ${sourceLangName} ${trackKindLabel}`,
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
        langName: `${t('pgAlreadyA')}${alreadyTranslated.join(', ')}${t('pgAlreadyB')}`,
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

    // 3-1. 이전 번역 캐시 확인 → 완료된 청크는 재번역/재청구 없이 이어서 (재개형)
    const total  = sourceSubtitles.length;
    const cached = await getSavedTranslations(videoId);
    // 라인 단위로 복원 — 원본 길이와 맞는 캐시만(자막 수정 시 인덱스 엇갈림 방지). 빈칸(null)=미완.
    const langResults = {};
    for (const code of targetLangs) {
      langResults[code] = new Array(total).fill(null);
      const c = cached?.langResults?.[code];
      if (Array.isArray(c) && c.length === total) {
        for (let i = 0; i < total; i++) if (c[i] != null) langResults[code][i] = c[i];
      }
    }
    const fullyCachedLangs = targetLangs.filter(c => isLangComplete(langResults[c], total));
    let pendingLangs       = targetLangs.filter(c => !fullyCachedLangs.includes(c));

    // 3-2. 잔액으로 감당 가능한 언어 수만 번역 (예상 차감액 표기는 제거 — 실제 청구는
    //      단계 배수·부분 캐시로 추정과 크게 달라져 오해 소지). 잔액 부족 시 언어 수만 조용히 조정.
    if (pendingLangs.length > 0 && pricing) {
      const totalChars   = sourceSubtitles.reduce((s, x) => s + (x.text?.length || 0), 0);
      const estTokens    = Math.ceil(totalChars * 1.2); // 보수적 토큰 추정 (한국어 1자 ≈ 1토큰 + 여유분)
      // 입력은 언어 배치로 공유, 출력은 언어당 원문 분량만큼 발생 (부분 캐시 시 실제 청구는 더 적음)
      const estCostPerLang =
        ((estTokens / MAX_LANGS_PER_CALL + 500) * pricing.input_per_m + estTokens * pricing.output_per_m)
        / 1_000_000 * pricing.multiplier
        + 40; // YouTube quota: 자막 등록 400 units ÷ 10 = 40 크레딧/언어

      const affordable = Math.floor(balance / estCostPerLang);
      if (affordable <= 0) throw new Error('INSUFFICIENT_CREDITS');
      if (affordable < pendingLangs.length) {
        const kept    = pendingLangs.slice(0, affordable);
        const dropped = pendingLangs.slice(affordable)
          .map(c => TARGET_LANGUAGES.find(l => l.code === c)?.name || c);
        pendingLangs = kept;
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          langName: `${t('pgAffA')}${affordable}${t('pgAffB')}${dropped.join(', ')}${t('pgAffC')}`,
          current: 0, total: targetLangs.length,
        });
      }
    }

    // 언어 칩 초기화용 — 번역 대상 언어 목록을 사이드바에 전달 (pending 칩 표시)
    if (pendingLangs.length > 0 || fullyCachedLangs.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: t('pgStarting'),
        current: 0, total: targetLangs.length,
        targetLangs: [...pendingLangs, ...fullyCachedLangs],
      });
    }

    if (fullyCachedLangs.length > 0) {
      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `${t('pgCachedA')} (${fullyCachedLangs.map(c => TARGET_LANGUAGES.find(l=>l.code===c)?.name||c).join(', ')}) ${t('pgCachedB')}`,
        current: 0, total: targetLangs.length,
      });
    }

    // 4. 미완 청크만 라운드 반복 번역 (재개형) — 완료 청크는 건너뛰고 남은 것만 처리
    const failReasonByCode = {}; // 언어별 실패 사유 카테고리 (표시·운영 보고용)
    let chunksCompleted  = 0;
    let totalChunks      = 0; // 첫 라운드 기준 총 콜 수 (진행바용). 캐시 전용이면 0.
    let totalInputTokens = 0, totalOutputTokens = 0;

    if (pendingLangs.length > 0) {
      // 신규 번역이 있을 때만 잔액 검증 (캐시 재업로드는 크레딧 불필요)
      if (balance <= 0) throw new Error('INSUFFICIENT_CREDITS');

      const { job_id } = await createTranslationJob({
        video_id:    videoId,
        source_lang: trackInfo.language,
        target_langs: pendingLangs,
        model: 'gemini-2.5-flash',
      });
      jobId = job_id;

      // 청크 경계는 전체 언어 수 기준으로 고정 — 재클릭마다 흔들리지 않게(재개 일관성)
      const chunkSize      = getChunkSize(targetLangs.length);
      const subtitleChunks = chunkArray(sourceSubtitles, chunkSize);
      totalChunks          = buildMissingPairs(pendingLangs, langResults, subtitleChunks, chunkSize).length;

      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        langName: `${t('pgTranslating')} (0/${totalChunks})`,
        current: 0, total: totalChunks,
      });

      // Gemini 응답 대기 중 5초마다 경과 시간 안내 (사용자 불안 감소)
      const startTime = Date.now();
      const heartbeat = setInterval(() => {
        if (!state.isRunning) { clearInterval(heartbeat); return; }
        const sec = Math.round((Date.now() - startTime) / 1000);
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          langName: `${t('pgProcessing')} (${sec}${t('pgSecElapsed')})`,
          current: chunksCompleted, total: totalChunks,
        });
      }, 5000);

      // 라운드: 1차 전체 → 남은 것만 보수 재처리. 3라운드 내 못 끝내면 재클릭이 이어받음.
      let lastSaved = 0;
      for (let round = 0; round < MAX_TRANSLATE_ROUNDS; round++) {
        if (state.shouldStop) break;
        const pairs = buildMissingPairs(pendingLangs, langResults, subtitleChunks, chunkSize);
        if (pairs.length === 0) break; // 전부 완성

        if (round > 0) {
          // 보수 라운드 — 부하가 가라앉을 시간을 준 뒤 남은 청크만 재처리
          broadcast({
            type: MSG.TRANSLATION_PROGRESS,
            langName: `${t('pgRepairing')} (${pairs.length})`,
            current: chunksCompleted, total: totalChunks, isChunkUpdate: true,
          });
          await new Promise(r => setTimeout(r, 3000));
        }

        for (let pi = 0; pi < pairs.length; pi += GEMINI_CONCURRENCY) {
          if (state.shouldStop) break;
          const slice = pairs.slice(pi, pi + GEMINI_CONCURRENCY);
          const rs = await Promise.allSettled(
            slice.map(p => translateChunkResilient({
              job_id:       jobId,
              subtitles:    p.chunk.map(s => ({ text: s.text })),
              offset:       p.offset,
              target_langs: p.langBatch,
              source_lang:  sourceLangName,
              model:        'gemini-2.5-flash',
            }))
          );

          for (let k = 0; k < rs.length; k++) {
            const r = rs[k], p = slice[k];
            if (r.status === 'fulfilled') {
              const { translations, tokens } = r.value;
              for (const code of p.langBatch) {
                const arr = translations?.[code] || [];
                // 라인 단위 인덱스 배치 — 빈 자리만 채운다(순서 보존, 재개 시 안전)
                for (let j = 0; j < p.chunk.length; j++) {
                  if (arr[j] != null) langResults[code][p.offset + j] = arr[j];
                }
              }
              totalInputTokens  += tokens?.input  || 0;
              totalOutputTokens += tokens?.output || 0;
            } else {
              const chunkErr = r.reason?.message || '알 수 없는 오류';
              for (const code of p.langBatch) failReasonByCode[code] = classifyFailure(chunkErr);
              log(`청크 번역 실패: ${chunkErr}`, LOG_LEVEL.WARN);
              await reportError(r.reason || new Error(chunkErr), { action: 'chunk_translate', chunk: chunksCompleted });
            }

            chunksCompleted++;
            broadcast({
              type: MSG.TRANSLATION_PROGRESS,
              langName: `${t('pgTranslating')} (${Math.min(chunksCompleted, totalChunks)}/${totalChunks})`,
              current: Math.min(chunksCompleted, totalChunks), total: totalChunks,
              isChunkUpdate: true, // 청크마다 로그 카드로 쌓이지 않도록 (라벨/진행바만 갱신)
            });
          }

          // 진행 저장(스로틀) — SW가 중간에 종료돼도 완료 청크는 보존, 재클릭이 이어받음
          if (chunksCompleted - lastSaved >= PROGRESS_SAVE_EVERY) {
            await saveTranslations(videoId, langResults, pendingLangs);
            lastSaved = chunksCompleted;
          }
        }
      }
      clearInterval(heartbeat);
      // 라운드 종료 후 최종 진행분 저장 (부분 완성 포함 — 재클릭 시 남은 부분만 이어서)
      await saveTranslations(videoId, langResults, pendingLangs);
    }

    // 6. 완성된 언어만 YouTube 업로드 (신규 완성 + 캐시 완성). 미완 언어는 진행분을 남겨 재클릭 시 이어서.
    const completeLangs   = targetLangs.filter(c => isLangComplete(langResults[c], total));
    const incompleteLangs = pendingLangs.filter(c => !completeLangs.includes(c));
    const allUploadLangs   = [...completeLangs, ...incompleteLangs]; // 이력 칩 표시용(미완=실패 칩)
    const errors = [];

    let uploadedCount = 0;
    const uploadSucceeded = []; // 캐시 삭제용

    for (const code of completeLangs) {
      if (state.shouldStop) break;

      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      if (!lang) continue;

      broadcast({
        type: MSG.TRANSLATION_PROGRESS,
        lang: code, langName: `[${lang.name}] ${t('pgUploading')}`,
        current: chunksCompleted, total: totalChunks,
      });

      try {
        const translated = sourceSubtitles.map((s, i) => ({
          ...s,
          text: langResults[code][i] ?? s.text,
        }));
        await uploadCaption(videoId, lang.ytCode, subtitlesToSRT(translated), existingCaptions);
        uploadedCount++;
        uploadSucceeded.push(code);
        broadcast({
          type: MSG.TRANSLATION_PROGRESS,
          lang: code, langName: `[${lang.name}] ${t('pgLangDone')}`,
          current: chunksCompleted, total: totalChunks,
          langDone: true,
        });
      } catch (err) {
        const detail = getUploadErrorMessage(err, lang.name);
        errors.push({ lang: lang.name, message: detail, reason: classifyFailure(err?.message) });
        // perLang: 작업 전체 실패가 아니라 개별 언어 실패 — sidebar가 종료/이력저장 하지 않도록 구분
        broadcast({ type: MSG.TRANSLATION_ERROR, error: detail, lang: code, perLang: true });
      }
    }

    // 미완 언어 안내 — 부분 완료. 진행분은 캐시에 남아, 다시 실행하면 남은 부분만 이어서 번역.
    for (const code of incompleteLangs) {
      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      if (!lang) continue;
      errors.push({ lang: lang.name, message: t('pgPartial'), reason: failReasonByCode[code] || '일시적 오류' });
    }

    // 업로드 성공(완성·등록 끝) 언어만 캐시에서 제거. 미완/업로드실패 언어의 진행분은 그대로 유지(재개용).
    await clearSavedTranslations(videoId, uploadSucceeded);

    // 6-1. 제목/설명 번역 (크레딧 모드 — 자막과 별도 mini job)
    let metaDone = false;
    let metaError = null;
    let metaFailReason = null; // 제목/설명 실패 카테고리
    if ((settings.translateTitle || settings.translateDescription) && !state.shouldStop) {
      try {
        // 제목/설명의 기본 언어(영상 기본 언어 우선, 없으면 소스 트랙 언어)도 대상에서 제외
        const metaBaseLang = videoSnippet?.defaultLanguage || videoSnippet?.defaultAudioLanguage || trackInfo.language;
        // 반환값 = 실제로 제목/설명을 등록했는지 (전부 기등록이면 false → 이력에 허위 "등록" 표시 방지)
        metaDone = await translateAndUploadMetadataCredits(
          videoId, videoSnippet, excludeBaseLang(settings.targetLangs, metaBaseLang),
          getLangName(trackInfo.language), settings,
          !jobId  // 자막 job이 없으면(제목/설명만) quota를 메타 job에서 정산
        );
      } catch (err) {
        // 402(크레딧 부족)를 "완료"로 삼키지 않도록 사용자에게 명시 (자막 성공분은 유지)
        const raw = err?.message || '';
        metaFailReason = classifyFailure(raw);
        metaError = /402|insufficient_credits/i.test(raw)
          ? '크레딧이 부족해 제목/설명 번역을 완료하지 못했습니다. ⚙️ 설정에서 충전 후 다시 시도해 주세요.'
          : `제목/설명 번역에 실패했습니다: ${friendlyError(err)}`;
        log(`제목/설명 번역 실패: ${err.message}`, LOG_LEVEL.WARN);
        // 크레딧 부족(사용자 사정) 외의 실패만 워처에 메타 기능 오류로 보고
        if (!/402|insufficient_credits/i.test(raw)) {
          reportError(err, { action: 'metadata_translate', feature: 'metadata' });
        }
        broadcast({ type: MSG.TRANSLATION_PROGRESS, langName: `⚠️ ${metaError}`, current: 1, total: 1 }, state.tabId);
      }
    }

    // 7. job 완료 처리 → 크레딧 차감 (신규 번역이 있었을 때만)
    // 자막 업로드는 이미 끝났으므로, PATCH 실패가 "전체 실패"로 오보고되지 않도록 catch로 격리
    if (jobId) {
      const finalStatus = state.shouldStop ? 'stopped' : 'completed';
      // 자막 job이 있으면 이번 실행의 전체 YouTube quota(unit)를 여기서 정산(units/10 크레딧 추가 차감)
      // success(업로드 성공 언어 수)를 함께 보내 — 서버가 성공 0이면 과금 면제
      await updateTranslationJob(jobId, { status: finalStatus, units: getUnitsUsed(), success: uploadedCount })
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

    // 잔액 조회가 성공했을 때만 차감액 계산 (실패 시 null → 이력에 금액 미표시)
    const creditsUsed = (creditsRemaining != null && balance != null)
      ? Math.max(0, balance - creditsRemaining)
      : null;

    // ── 표시·운영 보고용 상세 집계 ──
    const targetTypes = [
      settings.translateSubtitles   && '자막',
      settings.translateTitle       && '제목',
      settings.translateDescription && '설명',
    ].filter(Boolean);
    const selLangNames = (settings.targetLangs || []).map(c =>
      TARGET_LANGUAGES.find(l => l.code === c)?.nativeName || c);
    const failNames   = errors.map(e => e.lang);
    const failReasons = [...new Set(errors.map(e => e.reason).filter(Boolean))];
    if (metaError) {
      failNames.push('제목/설명');
      if (metaFailReason && !failReasons.includes(metaFailReason)) failReasons.push(metaFailReason);
    }
    const subResult = {
      ok:   uploadSucceeded.length, fail: errors.length,
      skip: (alreadyTranslated || []).length, selected: (settings.targetLangs || []).length,
    };

    // 실패가 있을 때만 운영자 채널(텔레그램/Supabase)에 표 전체를 상세 보고 (사용자 식별자는 anon 유지)
    if (errors.length || metaError) {
      reportTranslationDetail({
        videoId,
        videoTitle: videoSnippet?.title || videoId,
        targets:    targetTypes.join('·'),
        langs:      selLangNames,
        result:     `성공 ${subResult.ok}·건너뜀 ${subResult.skip}·실패 ${subResult.fail}/선택 ${subResult.selected}`,
        failNames,
        failReasons,
        credits:    creditsUsed,
      });
    }

    // 처리 이력용 언어별 결과 (성공/실패)
    const historyItems = allUploadLangs.map(code => {
      const lang = TARGET_LANGUAGES.find(l => l.code === code);
      return {
        code,
        name: lang?.nativeName || code,
        ok:   uploadSucceeded.includes(code),
      };
    });
    const savedTabId   = state.tabId;
    const wasStopped   = state.shouldStop;
    resetState();

    const record = {
      ts:           nowISO(),
      videoId,
      videoTitle:   videoSnippet?.title || videoId,
      items:        historyItems,
      skippedLangs: alreadyTranslated || [],
      targetTypes,                 // 번역 대상 (자막/제목/설명)
      langNames:    selLangNames,  // 선택한 번역 언어 (표시용)
      subResult,                   // { ok, fail, skip, selected }
      failNames,                   // 실패 대상 (언어명 + '제목/설명')
      failReasons,                 // 실패 사유 카테고리 (중복 제거)
      metaTitle:    metaDone && settings.translateTitle,
      metaDesc:     metaDone && settings.translateDescription,
      metaError,
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
    // 수동적 잔액 조회는 비대화형(팝업 없음). 미로그인이면 NOT_SIGNED_IN 반환.
    fetchCredits(message.interactive === true)
      .then(data => sendResponse({ balance: data.balance }))
      .catch(err => sendResponse({ balance: null, error: err.message }));
    return true; // 비동기 응답
  }

  // 공지 목록 — 콘텐츠 스크립트(사이드바)는 CORS로 직접 호출 불가 → SW 경유(공개 API, 인증 불필요)
  if (message.type === 'GET_NOTICES') {
    fetch(`${API_BASE}/notices?page=1&lang=${chrome.i18n.getUILanguage()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(data => sendResponse({ notices: data.notices || [] }))
      .catch(err => sendResponse({ notices: null, error: err.message }));
    return true;
  }

  // 추천 현황(옵션 페이지 표시용) — 비대화형(팝업 없음)
  if (message.type === 'GET_REFERRAL') {
    fetchReferral(false)
      .then(data => sendResponse({ referral: data }))
      .catch(err => sendResponse({ referral: null, error: err.message }));
    return true;
  }

  // 추천 코드 직접 입력 연결 (링크 미방문 구제) — 사용자 버튼 클릭이므로 대화형 허용
  if (message.type === 'APPLY_REFERRAL') {
    applyReferral(String(message.code || ''), true)
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // 원격 설정(kill-switch/배너) — 사이드바가 폴링
  if (message.type === 'GET_CONFIG') {
    getAppConfig()
      .then(cfg => sendResponse({ config: cfg }))
      .catch(() => sendResponse({ config: {} }));
    return true;
  }

  // 공지 본문(상세)
  if (message.type === 'GET_NOTICE_DETAIL') {
    fetch(`${API_BASE}/notices/${message.id}?lang=${chrome.i18n.getUILanguage()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(data => sendResponse({ notice: data }))
      .catch(err => sendResponse({ notice: null, error: err.message }));
    return true;
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

  // 세션 토큰 교환 — Google 토큰은 익스텐션 내부에서만 쓰고, 웹페이지엔 YouTube 권한 없는
  // 단기 세션 토큰만 넘긴다 (계정 토큰 유출 방지).
  if (message.type === 'YTAT_GET_SESSION') {
    exchangeSession()
      .then(d => sendResponse({ ok: true, sessionToken: d.session_token, isAdmin: d.is_admin }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

console.log('[YT-Auto-Translator] Service worker v2 초기화 완료');
