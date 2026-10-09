import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { KRW_TO_USD_RATE } from '../lib/constants.js';
import { verifyPaypalWebhook, grantPaypalOrder } from '../lib/paypal.js';
import { notifyError, tgEscape } from '../lib/errors.js';

const app = new Hono();

// ── PayPal 결제 완료 웹훅 (보조 확인 — 주 지급은 /credits/paypal/capture) ──
app.post('/paypal', async (c) => {
  const bodyText = await c.req.text();
  const headers = {
    'paypal-auth-algo':         c.req.header('paypal-auth-algo'),
    'paypal-cert-url':          c.req.header('paypal-cert-url'),
    'paypal-transmission-id':   c.req.header('paypal-transmission-id'),
    'paypal-transmission-sig':  c.req.header('paypal-transmission-sig'),
    'paypal-transmission-time': c.req.header('paypal-transmission-time'),
  };

  const ok = await verifyPaypalWebhook(c.env, headers, bodyText);
  if (!ok) return c.json({ error: 'INVALID_SIGNATURE' }, 401);

  let event;
  try { event = JSON.parse(bodyText); } catch { return c.json({ ok: true }); }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    // capture webhook의 resource에서 원 order id 추출 (우리 pending 결제 키)
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      try { await grantPaypalOrder(c.env, orderId); }
      catch (e) { await notifyError(c.env, 'webhook/paypal-grant', e, { orderId }); return c.json({ error: 'GRANT_FAILED' }, 500); } // 재전송 유도
    }
  }
  // 환불(PAYMENT.CAPTURE.REFUNDED) 등은 추후 보강
  return c.json({ ok: true });
});

// ── Portone 결제 완료 웹훅 ───────────────────────────────
app.post('/portone', async (c) => {
  // 웹훅 시크릿 검증 (Portone V1은 URL ?secret= 방식만 지원)
  const expectedSecret = c.env.PORTONE_WEBHOOK_SECRET;
  if (!expectedSecret) {
    await notifyError(c.env, 'webhook/portone-config', new Error('PORTONE_WEBHOOK_SECRET 미설정'));
    return c.json({ error: 'SERVER_MISCONFIGURED' }, 500);
  }
  const receivedSecret = c.req.query('secret');
  if (receivedSecret !== expectedSecret) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const body = await c.req.json();
  const { imp_uid, merchant_uid, status } = body;

  // ── 결제 취소 → 크레딧 자동 회수 ─────────────────────
  if (status === 'cancelled') {
    const token = await getPortoneToken(c.env);
    if (!token) {
      await notifyError(c.env, 'webhook/portone-token(cancel)', new Error('Portone 토큰 발급 실패'));
      return c.json({ error: 'PORTONE_AUTH_FAILED' }, 502);
    }
    const vr = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!vr.ok) {
      await notifyError(c.env, 'webhook/portone-cancel-verify', new Error(`Portone 취소 조회 실패: ${vr.status}`), { imp_uid });
      return c.json({ error: 'PORTONE_VERIFY_FAILED' }, 502);
    }
    const vd = await vr.json();
    if (vd.response?.status !== 'cancelled') {
      return c.json({ error: 'CANCEL_MISMATCH' }, 400);
    }

    const sb = getSupabase(c.env);
    const { data: payment } = await sb
      .from('payments')
      .select('*')
      .eq('portone_id', merchant_uid)
      .eq('status', 'completed')
      .single();

    if (!payment) return c.json({ ok: true }); // 미지급 결제 or 이미 환불 처리됨

    // 지급했던 크레딧(원화)을 회수. credits_granted가 지급 크레딧 값
    const reclaimCredits = Math.round(payment.credits_granted || 0);
    const { error: refundError } = await sb.rpc('refund_credits', {
      p_user_id:    payment.user_id,
      p_payment_id: payment.id,
      p_amount_usd: reclaimCredits   // 인자명은 레거시(usd)지만 값은 원화 크레딧
    });

    if (refundError) {
      await notifyError(c.env, 'webhook/refund_credits', new Error(refundError.message), { payment_id: payment.id });
      return c.json({ error: 'REFUND_FAILED' }, 500); // Portone 재전송으로 재시도
    }

    const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    await sendTelegram(c.env, c.env.TELEGRAM_PAYMENT_THREAD_ID,
      `💸 *[YTAT] 결제 취소*\n\n` +
      `💰 환불: *${reclaimCredits.toLocaleString('ko-KR')} 크레딧* 회수\n` +
      `🪪 user\\_id: \`${tgEscape(payment.user_id)}\`\n` +
      `🕐 ${time}`
    ).catch(err => console.error('[webhook] 텔레그램 알림 실패:', err.message));

    return c.json({ ok: true });
  }

  if (status !== 'paid') {
    return c.json({ ok: true }); // 실패는 무시
  }

  // Portone API로 결제 검증 (위조 방지)
  const portoneToken = await getPortoneToken(c.env);
  if (!portoneToken) {
    await notifyError(c.env, 'webhook/portone-token', new Error('Portone 토큰 발급 실패'));
    return c.json({ error: 'PORTONE_AUTH_FAILED' }, 502);
  }

  const verifyRes = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
    headers: { Authorization: `Bearer ${portoneToken}` }
  });
  if (!verifyRes.ok) {
    await notifyError(c.env, 'webhook/portone-verify', new Error(`Portone 결제 조회 실패: ${verifyRes.status}`), { imp_uid });
    return c.json({ error: 'PORTONE_VERIFY_FAILED' }, 502);
  }
  const verifyData = await verifyRes.json();

  if (verifyData.response?.status !== 'paid') {
    return c.json({ error: 'PAYMENT_MISMATCH' }, 400);
  }

  const sb = getSupabase(c.env);

  // pending 결제 조회 (금액 검증 전에 먼저 불러옴)

  const { data: payment } = await sb
    .from('payments')
    .select('*')
    .eq('portone_id', merchant_uid)
    .eq('status', 'pending')
    .single();

  if (!payment) return c.json({ ok: true }); // 이미 처리됨

  // 결제 금액 일치 검증 (위변조 방지)
  if (Math.abs(verifyData.response.amount - payment.amount_paid) > 1) {
    return c.json({ error: 'AMOUNT_MISMATCH' }, 400);
  }

  // 지급 크레딧(원화 1:1) — KRW 결제는 그대로, USD 결제는 환율로 환산
  const amountCredits = Math.round(
    payment.currency === 'USD' ? payment.amount_paid * KRW_TO_USD_RATE : payment.amount_paid
  );

  // 크레딧 지급 (원자적 처리 — RPC가 payments status도 pending → completed로 갱신)
  // 주의: 여기서 status를 먼저 completed로 바꾸면 RPC의 멱등성 체크에 걸려 지급이 스킵됨
  const { error: grantError } = await sb.rpc('grant_credits', {
    p_user_id:    payment.user_id,
    p_payment_id: payment.id,
    p_amount_usd: amountCredits   // RPC 인자명은 레거시(usd)지만 값은 원화 크레딧
  });

  if (grantError) {
    await notifyError(c.env, 'webhook/grant_credits', new Error(grantError.message), { payment_id: payment.id });
    // payments는 여전히 pending → Portone 웹훅 재전송 시 재시도 가능
    return c.json({ error: 'GRANT_FAILED' }, 500);
  }

  // 지급 성공 후 부가 필드 기록
  await sb
    .from('payments')
    .update({ credits_granted: amountCredits, updated_at: new Date().toISOString() })
    .eq('id', payment.id);

  // 텔레그램 결제 알림 🎉
  const amountDisplay = payment.currency === 'KRW'
    ? `₩${Number(payment.amount_paid).toLocaleString('ko-KR')}`
    : `$${Number(payment.amount_paid).toFixed(2)}`;
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  await sendTelegram(c.env, c.env.TELEGRAM_PAYMENT_THREAD_ID,
    `🎉 *[YTAT] 결제 완료!*\n\n` +
    `💰 금액: ${amountDisplay} → *${amountCredits.toLocaleString('ko-KR')} 크레딧*\n` +
    `🪪 user\\_id: \`${tgEscape(payment.user_id)}\`\n` +
    `🕐 ${time}`
  ).catch(err => console.error('[webhook] 텔레그램 알림 실패:', err.message)); // 알림 실패가 결제 응답에 영향주면 안 됨

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
  if (!res.ok) {
    console.error(`[webhook] Portone 토큰 요청 실패: ${res.status}`);
    return null;
  }
  const data = await res.json();
  return data.response?.access_token ?? null;
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
