/**
 * Logger — 로컬 저장 + Cloudflare Worker 경유 텔레그램 알림
 *
 * 구조:
 *  - 로컬: chrome.storage.local에 최근 200개 저장 (Options 페이지에서 조회 가능)
 *  - 원격: Cloudflare Worker → Telegram Bot으로 에러 알림
 *          (Bot Token은 Worker 환경변수에만 보관 — 익스텐션 코드 미노출)
 */

// =============================================
// 설정
// =============================================

const LOG_WORKER_URL  = 'https://yt-auto-translator-logger.1009yjh.workers.dev/';
const LOG_SECRET      = 'YT_TRANSLATOR_SECRET';
const MAX_LOG_ENTRIES = 200;
const WORKER_TIMEOUT  = 8000;  // Worker 요청 타임아웃 (ms)
const WORKER_RETRIES  = 2;     // 실패 시 최대 재시도 횟수

// =============================================
// 로그 레벨
// =============================================

export const LOG_LEVEL = {
  DEBUG: 'DEBUG',
  INFO:  'INFO',
  WARN:  'WARN',
  ERROR: 'ERROR'
};

// =============================================
// 글로벌 에러 핸들러
// =============================================

export function installGlobalErrorHandler(source = 'unknown') {
  self.addEventListener('error', e =>
    reportError(e.error || new Error(e.message), { source, action: 'global_error' })
  );
  self.addEventListener('unhandledrejection', e =>
    reportError(e.reason || new Error('Unhandled rejection'), { source, action: 'unhandled_rejection' })
  );
}

// =============================================
// 범용 로깅 (로컬 저장)
// =============================================

/**
 * 범용 로그 — 콘솔 출력 + chrome.storage.local 저장
 */
export async function log(message, level = LOG_LEVEL.INFO, context = {}) {
  const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: msgStr,
    context: {
      ...context,
      url: context.url || (typeof window !== 'undefined' ? window.location.href : 'background'),
      version: chrome.runtime.getManifest().version
    }
  };

  // 콘솔 출력 — context를 인라인 JSON으로 찍어 [object Object] 방지
  const method = level === LOG_LEVEL.ERROR ? 'error' : (level === LOG_LEVEL.WARN ? 'warn' : 'log');
  const ctxStr = Object.keys(context).length ? ` | ${JSON.stringify(context)}` : '';
  console[method](`[YT-Translator][${level}] ${msgStr}${ctxStr}`);

  // 로컬 저장
  try {
    const r = await chrome.storage.local.get('appLogs');
    const logs = [entry, ...(r.appLogs || [])].slice(0, MAX_LOG_ENTRIES);
    await chrome.storage.local.set({ appLogs: logs });
  } catch (e) {
    console.error('[YT-Translator] 로그 저장 실패:', e);
  }

  return entry;
}

// =============================================
// 에러 리포트 (로컬 + Cloudflare Worker)
// =============================================

/**
 * 에러 리포트 — 로컬 저장 + Worker 전송
 */
export async function reportError(error, context = {}) {
  // context 스프레드를 message/stack 뒤에서 분리 — 덮어쓰기 방지
  const message = error?.message || String(error);
  const stack   = error?.stack   || '';

  await log(message, LOG_LEVEL.ERROR, context);

  await sendToWorker({
    type:      'general_error',
    timestamp: new Date().toISOString(),
    level:     LOG_LEVEL.ERROR,
    message,
    stack,
    ...context   // action, currentLang 등 추가 컨텍스트
  });
}

/**
 * 번역 완료 후 결과 리포트 (실패 언어가 있을 때만 Worker 전송)
 */
export async function reportTranslationResult({ videoId, errors, total, success }) {
  if (!errors?.length) return;

  await sendToWorker({
    type:      'translation_error',
    timestamp: new Date().toISOString(),
    videoId,
    errors,
    total,
    success
  });
}

// =============================================
// 로그 조회 / 삭제 (Options 페이지용)
// =============================================

export async function getLogs() {
  const r = await chrome.storage.local.get('appLogs');
  return r.appLogs || [];
}

export async function clearLogs() {
  await chrome.storage.local.remove('appLogs');
}

// =============================================
// 내부: Cloudflare Worker 전송
// =============================================

/**
 * Worker로 페이로드 전송
 *
 * - keepalive: true  → Service Worker 종료 후에도 요청 완료 보장
 * - AbortController → 타임아웃 처리
 * - 재시도           → 최대 WORKER_RETRIES회 (2초 간격)
 */
async function sendToWorker(payload, attempt = 0) {
  if (LOG_WORKER_URL.includes('YOUR_SUBDOMAIN')) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT);

  try {
    const res = await fetch(LOG_WORKER_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'X-Log-Secret': LOG_SECRET },
      body:     JSON.stringify(payload),
      keepalive: true,           // ← Service Worker 생명주기와 무관하게 전송 완료
      signal:   controller.signal
    });
    clearTimeout(timer);

    if (!res.ok && attempt < WORKER_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      return sendToWorker(payload, attempt + 1);
    }

  } catch (e) {
    clearTimeout(timer);
    if (attempt < WORKER_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      return sendToWorker(payload, attempt + 1);
    }
    // 최종 실패는 조용히 처리 (에러 알림 실패로 또 다른 에러 유발 방지)
    console.warn('[YT-Translator] Worker 전송 최종 실패:', e.message);
  }
}

// Sentry 초기화 (레거시 호환 - 현재 미사용)
export async function initSentry(dsn) {
  if (!dsn) return;
  console.log('[YT-Translator] Sentry DSN 설정됨 (현재 Cloudflare Worker 방식 사용 중)');
}
