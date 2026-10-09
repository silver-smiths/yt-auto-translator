// 서버 에러 → 텔레그램 알림 (원인 파악 가능 수준 + PII/시크릿 마스킹 + 지문 집계로 도배 방지)
// 클라이언트 에러(/ops/errors)와 동일한 record_error 파이프라인을 재사용 → 신규 지문만 전송.
import { getSupabase } from './supabase.js';

// 토큰·이메일·긴 키 문자열을 가림 (텔레그램·DB에 민감정보 유출 방지)
export function mask(text) {
  return String(text == null ? '' : text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, '***@***')
    .replace(/\b[A-Za-z0-9._\-]{24,}\b/g, '***'); // 토큰/JWT/키 등 긴 문자열
}

// 텔레그램(Markdown) 특수문자 무력화 — 주입 방지. UUID·이메일 등 보존이 필요한 식별자엔 이것만 적용.
export function tgEscape(text) {
  return String(text == null ? '' : text).replace(/[`*_\[\]]/g, ' ');
}

// 비신뢰 입력용 — 토큰·이메일 마스킹 + Markdown 이스케이프.
export function tgSafe(text) {
  return tgEscape(mask(text));
}

// 지문 — 같은 유형을 묶기 위해 메시지를 정규화(숫자·URL·긴ID 제거)
function fingerprintOf(scope, message) {
  const norm = String(message || '')
    .replace(/https?:\/\/[^\s)]+/g, 'URL')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'ID')
    .replace(/\d+/g, 'N')
    .slice(0, 160);
  return `backend:${scope}:${norm}`.slice(0, 200);
}

// 서버 장애 보고. 절대 throw하지 않음(알림이 본 로직을 깨면 안 됨).
export async function notifyError(env, scope, err, ctx = {}) {
  const rawMsg = err?.message || String(err);
  const message = tgSafe(rawMsg).slice(0, 2000);
  const stack = tgSafe((err?.stack || '').split('\n').slice(1, 3).join('\n')).slice(0, 600);

  console.error(`[${scope}]`, rawMsg, ctx);

  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return;

  try {
    const sb = getSupabase(env);
    const fingerprint = fingerprintOf(scope, message);
    const { data: isNew } = await sb.rpc('record_error', {
      p_source: 'backend', p_version: '', p_fingerprint: fingerprint,
      p_message: message, p_context: { scope, ...ctx }, p_anon_hash: '',
    });
    if (!isNew) return; // 같은 장애 반복 → 집계만, 도배 방지

    let text = `🛑 [YTAT/backend] ${scope}\n\`${fingerprint}\`\n${message}`;
    if (stack) text += `\n\n${stack}`;

    const payload = { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    if (env.TELEGRAM_ERROR_THREAD_ID) payload.message_thread_id = parseInt(env.TELEGRAM_ERROR_THREAD_ID, 10);

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[notifyError] 자체 실패:', e.message); // 알림 실패는 삼킴(본 로직 보호)
  }
}
