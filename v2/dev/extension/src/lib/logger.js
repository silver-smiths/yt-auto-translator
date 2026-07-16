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

import { API_BASE } from './constants.js';

const MAX_LOG_ENTRIES = 200;

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

  await sendToOps({ message, stack, action: context.action, at: context.source,
                    feature: context.feature, lang: context.lang });
}

/**
 * 번역 완료 후 결과 리포트 (실패 언어가 있을 때만 Worker 전송)
 */
export async function reportTranslationResult({ videoId, errors, total, success }) {
  if (!errors?.length) return;

  // 개별 언어 실패 요약 (PII 제외 — 영상제목·자막 미포함)
  await sendToOps({
    message: `번역 부분 실패 ${errors.length}/${total} (성공 ${success})`,
    tag: 'translation_result',
    action: 'translation_result',
    feature: 'subtitles',
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
// 내부: 백엔드 /ops/errors 전송 (저장 + 지문 집계 + 신규만 텔레그램)
// =============================================

// 오류 지문 — 같은 유형을 묶기 위해 메시지/스택을 정규화해 해시(숫자·URL·긴ID 제거)
function fingerprintOf(message, stack, tag) {
  const norm = String(message || '')
    .replace(/https?:\/\/[^\s)]+/g, 'URL')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'ID')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
  const frame = String(stack || '').split('\n')[1]?.replace(/:\d+:\d+/g, '').trim().slice(0, 120) || '';
  const raw = (tag || '') + '|' + norm + '|' + frame;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return 'e' + h.toString(16);
}

// 익명 설치 ID — 영향 사용자 수 집계용(PII 아님, 무작위). storage.local에 1회 생성·보관.
async function getAnonId() {
  try {
    const r = await chrome.storage.local.get('anonId');
    if (r.anonId) return r.anonId;
    const id = 'a_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await chrome.storage.local.set({ anonId: id });
    return id;
  } catch { return ''; }
}

// PII 스크럽: message는 앞부분만, context는 안전 필드(action/at/feature/lang)만 전송.
async function sendToOps({ message, stack, tag, action, at, feature, lang }) {
  try {
    await fetch(`${API_BASE}/ops/errors`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,   // SW 종료 후에도 전송 완료
      body: JSON.stringify({
        source:      'extension',
        version:     chrome.runtime.getManifest().version,
        fingerprint: fingerprintOf(message, stack, tag),
        message:     String(message || '').slice(0, 500),
        anon_hash:   await getAnonId(),
        context:     { action: action || undefined, at: at || undefined,
                       feature: feature || undefined, lang: lang || undefined },
      }),
    });
  } catch { /* 전송 실패는 조용히 — 에러 알림 실패로 또 다른 에러 유발 방지 */ }
}

// Sentry 초기화 (레거시 호환 - 현재 미사용)
export async function initSentry(dsn) {
  if (!dsn) return;
  console.log('[YT-Translator] Sentry DSN 설정됨 (현재 Cloudflare Worker 방식 사용 중)');
}
