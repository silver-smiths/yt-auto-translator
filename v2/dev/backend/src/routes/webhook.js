import { getSupabase } from '../lib/supabase.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const KRW_TO_USD = 1400; // 고정 환율

export async function handleWebhook(request, env) {
  // Portone 서명 검증
  const signature = request.headers.get('Portone-Signature');
  if (!signature) return json({ error: 'Missing signature' }, 400);

  const rawBody = await request.text();
  const isValid = await verifyPortoneSignature(rawBody, signature, env.PORTONE_SECRET_KEY);
  if (!isValid) return json({ error: 'Invalid signature' }, 400);

  const body = JSON.parse(rawBody);
  if (body.type !== 'Transaction.Paid') return json({ ok: true }); // 관심 없는 이벤트 무시

  const { paymentId, amount, currency, customer, status } = body.data || {};
  if (status !== 'PAID') return json({ ok: true });

  const db = getSupabase(env);

  // 멱등성: 이미 처리된 결제인지 확인
  const { data: existing } = await db
    .from('payments')
    .select('id')
    .eq('portone_id', paymentId)
    .single();

  if (existing) return json({ ok: true }); // 중복 웹훅 무시

  // 이메일로 사용자 조회
  const { data: user } = await db
    .from('users')
    .select('id')
    .eq('email', customer?.email)
    .single();

  if (!user) return json({ error: 'User not found' }, 500);

  // USD 환산
  const amountRaw = amount?.total ?? 0;
  const amountUsd = currency === 'KRW'
    ? Math.round((amountRaw / KRW_TO_USD) * 1_000_000) / 1_000_000
    : amountRaw;

  // payments 레코드 INSERT
  const { data: payment, error: payErr } = await db
    .from('payments')
    .insert({
      user_id:         user.id,
      portone_id:      paymentId,
      pg_provider:     currency === 'KRW' ? 'toss' : 'stripe',
      amount_paid:     amountRaw,
      currency,
      amount_usd:      amountUsd,
      credits_granted: amountUsd,
      status:          'completed',
      metadata:        body.data,
    })
    .select('id')
    .single();

  if (payErr) return json({ error: payErr.message }, 500);

  // 크레딧 지급
  const { error: grantErr } = await db.rpc('grant_credits', {
    p_user_id:    user.id,
    p_payment_id: payment.id,
    p_amount_usd: amountUsd,
  });

  if (grantErr) return json({ error: grantErr.message }, 500);

  return json({ ok: true });
}

async function verifyPortoneSignature(rawBody, signature, secretKey) {
  // Portone V2 서명: HMAC-SHA256(timestamp.rawBody, secretKey)
  // signature 헤더 형식: "t=<timestamp>,v1=<hmac>"
  try {
    const parts = Object.fromEntries(signature.split(',').map(p => p.split('=')));
    const timestamp = parts.t;
    const expected  = parts.v1;
    if (!timestamp || !expected) return false;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const msgData = encoder.encode(`${timestamp}.${rawBody}`);

    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const sigHex    = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    return sigHex === expected;
  } catch {
    return false;
  }
}
