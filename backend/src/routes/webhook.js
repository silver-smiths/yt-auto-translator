import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const app = new Hono();

const GEMINI_INPUT_PER_M  = 0.075;
const GEMINI_OUTPUT_PER_M = 0.30;

// ── Portone 결제 완료 웹훅 ───────────────────────────────
app.post('/portone', async (c) => {
  const body = await c.req.json();
  const { imp_uid, merchant_uid, status } = body;

  if (status !== 'paid') {
    return c.json({ ok: true }); // 실패/취소는 무시
  }

  // Portone API로 결제 검증 (위조 방지)
  const verifyRes = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
    headers: { Authorization: `Bearer ${await getPortoneToken(c.env)}` }
  });
  const verifyData = await verifyRes.json();

  if (verifyData.response?.status !== 'paid') {
    return c.json({ error: 'PAYMENT_MISMATCH' }, 400);
  }

  const sb = getSupabase(c.env);

  // pending 결제 조회
  const { data: payment } = await sb
    .from('payments')
    .select('*')
    .eq('portone_id', merchant_uid)
    .eq('status', 'pending')
    .single();

  if (!payment) return c.json({ ok: true }); // 이미 처리됨

  const amountUsd = payment.currency === 'USD'
    ? payment.amount_paid
    : payment.amount_paid / 1350;

  // 결제 상태 업데이트
  await sb
    .from('payments')
    .update({ status: 'completed', credits_granted: amountUsd, updated_at: new Date().toISOString() })
    .eq('id', payment.id);

  // 크레딧 지급 (원자적 처리 — Supabase RPC)
  await sb.rpc('grant_credits', {
    p_user_id:    payment.user_id,
    p_payment_id: payment.id,
    p_amount_usd: amountUsd
  });

  // 텔레그램 결제 알림 🎉
  const amountDisplay = payment.currency === 'KRW'
    ? `₩${Number(payment.amount_paid).toLocaleString('ko-KR')}`
    : `$${Number(payment.amount_paid).toFixed(2)}`;
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  await sendTelegram(c.env, env.TELEGRAM_PAYMENT_THREAD_ID,
    `🎉 *[YTAT] 결제 완료!*\n\n` +
    `💰 금액: ${amountDisplay} → *$${amountUsd.toFixed(2)}* 크레딧\n` +
    `🪪 user\\_id: \`${payment.user_id}\`\n` +
    `🕐 ${time}`
  ).catch(() => {}); // 알림 실패가 결제 응답에 영향주면 안 됨

  return c.json({ ok: true });
});

// ── Portone 액세스 토큰 발급 ─────────────────────────────
async function getPortoneToken(env) {
  const res = await fetch('https://api.iamport.kr/users/getToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imp_key:    env.PORTONE_IMP_KEY,
      imp_secret: env.PORTONE_IMP_SECRET
    })
  });
  const data = await res.json();
  return data.response?.access_token;
}

// ── 텔레그램 메시지 전송 ──────────────────────────────────
async function sendTelegram(env, threadId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const payload = {
    chat_id:    env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };
  if (threadId) payload.message_thread_id = parseInt(threadId, 10);

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Telegram API 오류: ${err.description || res.status}`);
  }
}

export default app;
