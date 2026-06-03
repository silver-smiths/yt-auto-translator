import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const app = new Hono();

// ── 잔액 조회 ─────────────────────────────────────────────
app.get('/', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  const { data, error } = await sb
    .from('credit_accounts')
    .select('balance, cumulative_used, tier')
    .eq('user_id', userId)
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({
    balance:        parseFloat(data.balance),
    cumulative_used: parseFloat(data.cumulative_used),
    tier:           data.tier,
    multiplier:     data.tier === 'heavy' ? 1.1 : data.tier === 'standard' ? 1.2 : 1.3
  });
});

// ── 결제 세션 생성 (Portone) ─────────────────────────────
app.post('/checkout', async (c) => {
  const userId = c.get('userId');
  const { amount, currency } = await c.req.json();

  // 최소 충전 금액 검증
  const minUSD = 10;
  const minKRW = 15000;

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
      amount_usd:       currency === 'USD' ? amount : amount / 1350, // 고정 환율 (실서비스에선 실시간 환율 API 사용)
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
