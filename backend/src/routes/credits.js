import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { KRW_TO_USD_RATE, INPUT_PER_M, OUTPUT_PER_M, CREDIT_PER_USD } from '../lib/constants.js';
import { paypalBase, getPaypalToken, grantPaypalOrder } from '../lib/paypal.js';
import { notifyError } from '../lib/errors.js';

const app = new Hono();

const PAYPAL_MIN_USD = 5;
const WELCOME_BONUS_CREDITS = 1500; // 신규 가입 웰컴 무료체험 크레딧 (계정당 1회)

// ── 웰컴 무료체험 크레딧 수령 (계정당 1회, 멱등) ────────────
app.post('/claim-welcome', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  const { data: granted, error } = await sb.rpc('claim_welcome_bonus', {
    p_user_id: userId, p_amount: WELCOME_BONUS_CREDITS,
  });
  if (error) { await notifyError(c.env, 'credits/claim-welcome', new Error(error.message), { userId }); return c.json({ error: 'SERVER_ERROR' }, 500); }

  const grantedNum = Number(granted) || 0;

  const { data: acct } = await sb.from('credit_accounts')
    .select('balance, referral_balance').eq('user_id', userId).single();
  const balance = acct ? Number(acct.balance) + Number(acct.referral_balance || 0) : null;

  return c.json({ already: grantedNum === 0, granted: grantedNum, balance });
});

// ── PayPal 주문 생성 (USD) ────────────────────────────────
app.post('/paypal/order', async (c) => {
  const userId = c.get('userId');
  const { amount } = await c.req.json();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < PAYPAL_MIN_USD) {
    return c.json({ error: `최소 충전 금액은 $${PAYPAL_MIN_USD}입니다.` }, 400);
  }

  const token = await getPaypalToken(c.env);
  if (!token) return c.json({ error: 'PAYPAL_AUTH_FAILED' }, 502);

  const res = await fetch(`${paypalBase(c.env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: amount.toFixed(2) } }],
    }),
  });
  if (!res.ok) { await notifyError(c.env, 'credits/paypal-order', new Error(`order 생성 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`), { userId }); return c.json({ error: 'ORDER_FAILED' }, 502); }
  const order = await res.json();

  // pending 결제 기록 (portone_id 칸에 PayPal order id 저장 — grant/webhook가 이 키로 조회)
  const sb = getSupabase(c.env);
  const { error } = await sb.from('payments').insert({
    user_id: userId, portone_id: order.id, pg_provider: 'paypal',
    amount_paid: amount, currency: 'USD', amount_usd: amount,
    credits_granted: 0, status: 'pending',
  });
  if (error) { await notifyError(c.env, 'credits/paypal-pending-insert', new Error(error.message), { userId, orderId: order.id }); return c.json({ error: 'SERVER_ERROR' }, 500); }

  return c.json({ id: order.id });
});

// ── PayPal 캡처 → 크레딧 지급 ─────────────────────────────
app.post('/paypal/capture', async (c) => {
  const userId = c.get('userId');
  const { orderId } = await c.req.json();
  if (!orderId) return c.json({ error: 'MISSING_ORDER' }, 400);

  // 내 주문인지 확인 (타인 주문 캡처 차단)
  const sb = getSupabase(c.env);
  const { data: pay } = await sb.from('payments').select('user_id, status').eq('portone_id', orderId).single();
  if (!pay || pay.user_id !== userId) return c.json({ error: 'FORBIDDEN' }, 403);

  const token = await getPaypalToken(c.env);
  if (!token) return c.json({ error: 'PAYPAL_AUTH_FAILED' }, 502);

  const res = await fetch(`${paypalBase(c.env)}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const cap = await res.json();
  if (!res.ok || cap.status !== 'COMPLETED') {
    await notifyError(c.env, 'credits/paypal-capture', new Error(`capture 실패: ${JSON.stringify(cap).slice(0, 300)}`), { userId, orderId });
    return c.json({ error: 'CAPTURE_FAILED' }, 502);
  }

  // 지급 (멱등). 실패해도 웹훅이 재시도하므로 결제 자체는 성공 처리.
  try { await grantPaypalOrder(c.env, orderId); }
  catch (e) { await notifyError(c.env, 'credits/paypal-grant(capture)', e, { userId, orderId }); }

  const { data: acct } = await sb.from('credit_accounts')
    .select('balance, referral_balance').eq('user_id', userId).single();
  return c.json({ ok: true, balance: acct ? Number(acct.balance) + Number(acct.referral_balance || 0) : null });
});

// ── 잔액 조회 ─────────────────────────────────────────────
app.get('/', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  const { data, error } = await sb
    .from('credit_accounts')
    .select('balance, referral_balance, cumulative_used')
    .eq('user_id', userId)
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  const paid     = parseFloat(data.balance);
  const referral = parseFloat(data.referral_balance || 0);

  return c.json({
    balance:         paid + referral,   // 표시·검사용 합계(유료+추천)
    paid_balance:    paid,              // 유료분(먼저 소진)
    referral_balance: referral,         // 추천 적립분(유료 소진 후 사용)
    cumulative_used: parseFloat(data.cumulative_used),
    // 익스텐션의 시작 전 비용 추정용 단가 (apiCostUsd × multiplier = 크레딧(원))
    pricing: {
      input_per_m:  INPUT_PER_M,
      output_per_m: OUTPUT_PER_M,
      multiplier:   CREDIT_PER_USD, // 배수×환율 → 예상 차감 크레딧(원)
    },
  });
});

// ── 결제 세션 생성 (Portone) ─────────────────────────────
app.post('/checkout', async (c) => {
  const userId = c.get('userId');
  const { amount, currency } = await c.req.json();

  // 입력값 검증
  if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
    return c.json({ error: '유효하지 않은 금액입니다.' }, 400);
  }
  if (!['USD', 'KRW'].includes(currency)) {
    return c.json({ error: '지원하지 않는 통화입니다. (USD, KRW만 허용)' }, 400);
  }

  // 최소 충전 금액 검증 (결제 페이지 ytat-credits.html과 동일하게 유지할 것)
  const minUSD = 5;
  const minKRW = 5000;

  if (currency === 'USD' && amount < minUSD) {
    return c.json({ error: `최소 충전 금액은 $${minUSD}입니다.` }, 400);
  }
  if (currency === 'KRW' && amount < minKRW) {
    return c.json({ error: `최소 충전 금액은 ₩${minKRW.toLocaleString()}입니다.` }, 400);
  }

  // Portone 결제 요청 파라미터 생성 (프론트에서 Portone SDK 호출용)
  const orderId = `order_${userId.slice(0, 8)}_${Date.now()}`;

  // Supabase에 pending 결제 기록
  const sb = getSupabase(c.env);
  const { data: payment, error } = await sb
    .from('payments')
    .insert({
      user_id:    userId,
      portone_id: orderId,
      pg_provider: currency === 'KRW' ? 'kakaopay' : 'manual',
      amount_paid: amount,
      currency,
      amount_usd:       currency === 'USD' ? amount : amount / KRW_TO_USD_RATE,
      credits_granted:  0, // 웹훅 수신 후 업데이트
      status:     'pending'
    })
    .select('id')
    .single();

  if (error) {
    await notifyError(c.env, 'credits/checkout-insert', new Error(error.message), { userId, currency });
    return c.json({ error: 'SERVER_ERROR' }, 500);
  }

  return c.json({
    payment_id: payment.id,
    order_id:   orderId,
    pg_provider: currency === 'KRW' ? 'kakaopay' : 'manual',
    amount,
    currency
  });
});

// ── 거래 이력 ─────────────────────────────────────────────
app.get('/history', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  const { data, error } = await sb
    .from('credit_transactions')
    .select('id, type, amount, balance_after, description, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({ transactions: data });
});

export default app;
