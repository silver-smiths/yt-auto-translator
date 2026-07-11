import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { KRW_TO_USD_RATE, INPUT_PER_M, OUTPUT_PER_M, CREDIT_MULTIPLIER } from '../lib/constants.js';

const app = new Hono();

// ── 잔액 조회 ─────────────────────────────────────────────
app.get('/', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  const { data, error } = await sb
    .from('credit_accounts')
    .select('balance, cumulative_used')
    .eq('user_id', userId)
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({
    balance:         parseFloat(data.balance),
    cumulative_used: parseFloat(data.cumulative_used),
    // 익스텐션의 시작 전 비용 추정용 단가 (하드코딩 중복 방지)
    pricing: {
      input_per_m:  INPUT_PER_M,
      output_per_m: OUTPUT_PER_M,
      multiplier:   CREDIT_MULTIPLIER,
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
      pg_provider: currency === 'KRW' ? 'toss' : 'stripe',
      amount_paid: amount,
      currency,
      amount_usd:       currency === 'USD' ? amount : amount / KRW_TO_USD_RATE,
      credits_granted:  0, // 웹훅 수신 후 업데이트
      status:     'pending'
    })
    .select('id')
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({
    payment_id: payment.id,
    order_id:   orderId,
    pg_provider: currency === 'KRW' ? 'toss' : 'stripe',
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
