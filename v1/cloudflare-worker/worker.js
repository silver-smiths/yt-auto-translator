/**
 * Cloudflare Worker - YT Auto Translator 에러 로그 중계기
 *
 * 환경변수 (Cloudflare Dashboard > Settings > Variables에서 설정):
 *   TELEGRAM_BOT_TOKEN  : 텔레그램 봇 토큰
 *   TELEGRAM_CHAT_ID    : 모니터링 그룹 Chat ID
 *   LOG_SECRET          : 익스텐션과 공유하는 시크릿 키
 */

export default {
  async fetch(request, env) {
    // CORS preflight 처리
    if (request.method === 'OPTIONS') {
      return corsResponse();
    }

    // POST 요청만 허용
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 시크릿 키 검증 (익스텐션에서 X-Log-Secret 헤더로 전송)
    const secret = request.headers.get('X-Log-Secret');
    if (env.LOG_SECRET && secret !== env.LOG_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // 텔레그램 메시지 포맷 구성
    const message = formatMessage(body);

    // 텔레그램 전송
    try {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message, env.TELEGRAM_THREAD_ID);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};

// =============================================
// 메시지 포맷
// =============================================

function formatMessage(body) {
  const { type, videoId, errors = [], total = 0, success = 0, message, stack, action, currentLang, timestamp } = body;
  const time = timestamp ? new Date(timestamp).toLocaleString('ko-KR') : new Date().toLocaleString('ko-KR');

  // 번역 에러 (언어별 실패)
  if (type === 'translation_error' && errors.length > 0) {
    const failList = errors.map(e => `  • ${e.lang}: ${e.message}`).join('\n');
    return [
      `🚨 *[YT 자동번역] 번역 오류 발생*`,
      ``,
      `📹 영상 ID: \`${videoId || '알 수 없음'}\``,
      `📊 결과: ${success}/${total} 성공`,
      ``,
      `❌ 실패 언어:`,
      failList,
      ``,
      `🕐 ${time}`
    ].join('\n');
  }

  // 일반 에러 (치명적 오류)
  return [
    `🔴 *[YT 자동번역] 오류 발생*`,
    ``,
    `📌 액션: \`${action || '알 수 없음'}\``,
    currentLang ? `🌐 언어: ${currentLang}` : '',
    ``,
    `💬 메시지: ${message || '알 수 없는 오류'}`,
    stack ? `\`\`\`\n${stack.slice(0, 300)}\n\`\`\`` : '',
    ``,
    `🕐 ${time}`
  ].filter(Boolean).join('\n');
}

// =============================================
// 텔레그램 전송
// =============================================

async function sendTelegram(token, chatId, text, threadId) {
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다.');

  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (threadId) payload.message_thread_id = parseInt(threadId, 10);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Telegram API 오류: ${err.description || res.status}`);
  }
}

// =============================================
// CORS 헬퍼
// =============================================

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Log-Secret'
  };
}

function corsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
