import { getSupabase } from './supabase.js';
import { KRW_TO_USD_RATE } from './constants.js';
import { notifyError } from './errors.js';

// PayPal API 베이스 (env에 따라 sandbox/live)
export function paypalBase(env) {
  return env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// OAuth 액세스 토큰 (client_credentials)
export async function getPaypalToken(env) {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) { await notifyError(env, 'paypal/token', new Error(`토큰 발급 실패 ${res.status}`)); return null; }
  const d = await res.json();
  return d.access_token ?? null;
}

// PayPal order → 크레딧 지급. pending 결제만 처리(멱등) → capture·webhook 양쪽에서 안전하게 호출 가능.
// 지급 크레딧 = USD 결제액 × 환율 (원화 1:1 크레딧, 기존 정책과 동일).
export async function grantPaypalOrder(env, orderId) {
  const sb = getSupabase(env);
  const { data: payment } = await sb
    .from('payments').select('*')
    .eq('portone_id', orderId).eq('status', 'pending').single();
  if (!payment) return { granted: false }; // 이미 지급됐거나 없는 주문

  // PayPal에서 실제 결제 금액을 조회해 DB amount_paid와 대조 (금액 위변조·부분캡처·미완료 방어)
  const token = await getPaypalToken(env);
  if (!token) throw new Error('PAYPAL_AUTH_FAILED');
  const ores = await fetch(`${paypalBase(env)}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!ores.ok) throw new Error('PAYPAL_ORDER_FETCH_FAILED');
  const order = await ores.json();
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  const paidValue = Number(cap?.amount?.value);
  if (order.status !== 'COMPLETED' || cap?.status !== 'COMPLETED'
      || cap?.amount?.currency_code !== 'USD'
      || !Number.isFinite(paidValue)
      || Math.abs(paidValue - Number(payment.amount_paid)) > 0.01) {
    await notifyError(env, 'paypal/amount-verify', new Error(
      `결제 검증 실패 order=${order.status} cap=${cap?.status} 실결제=${paidValue} ${cap?.amount?.currency_code} vs 주문=${payment.amount_paid} USD`
    ), { orderId, payment_id: payment.id });
    throw new Error('PAYPAL_AMOUNT_MISMATCH');
  }

  const amountCredits = Math.round(Number(payment.amount_paid) * KRW_TO_USD_RATE);
  const { error } = await sb.rpc('grant_credits', {
    p_user_id: payment.user_id, p_payment_id: payment.id, p_amount_usd: amountCredits,
  });
  if (error) { console.error('[paypal] grant_credits 실패:', error.message, { payment_id: payment.id }); throw new Error('GRANT_FAILED'); }

  await sb.from('payments')
    .update({ credits_granted: amountCredits, updated_at: new Date().toISOString() })
    .eq('id', payment.id);
  return { granted: true, credits: amountCredits, userId: payment.user_id, amountUsd: Number(payment.amount_paid) };
}

// 웹훅 서명 검증 (위조 방지) — PayPal verify-webhook-signature API
export async function verifyPaypalWebhook(env, headers, bodyText) {
  const token = await getPaypalToken(env);
  if (!token) return false;
  let webhookEvent;
  try { webhookEvent = JSON.parse(bodyText); } catch { return false; }
  const res = await fetch(`${paypalBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo:         headers['paypal-auth-algo'],
      cert_url:          headers['paypal-cert-url'],
      transmission_id:   headers['paypal-transmission-id'],
      transmission_sig:  headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id:        env.PAYPAL_WEBHOOK_ID,
      webhook_event:     webhookEvent,
    }),
  });
  if (!res.ok) { await notifyError(env, 'paypal/webhook-verify', new Error(`웹훅 검증 요청 실패 ${res.status}`)); return false; }
  const d = await res.json();
  return d.verification_status === 'SUCCESS';
}
