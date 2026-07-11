import { Hono } from 'hono';

const app = new Hono();

// ── Gemini 릴레이 ──────────────────────────────────────────
// Vercel(미국 리전 iad1)에 배포된 이 엔드포인트가 Gemini를 대신 호출한다.
// Cloudflare Workers는 홍콩 콜로로 라우팅될 수 있어 Gemini 지역 차단(400)에 걸리므로,
// Workers는 이 릴레이를 경유해 미국에서 Gemini를 호출한다.
app.post('/', async (c) => {
  const secret = c.req.header('x-relay-secret');
  const expected = c.env.GEMINI_RELAY_SECRET;
  if (!expected || secret !== expected) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const { model, base, payload } = await c.req.json();
  if (!model || !payload) {
    return c.json({ error: 'INVALID_REQUEST' }, 400);
  }

  // base는 Google 공식 엔드포인트만 허용 (임의 URL로 API 키가 유출되는 것을 차단)
  const ALLOWED_BASES = new Set([
    'https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1',
  ]);
  const baseUrl = base || 'https://generativelanguage.googleapis.com/v1beta';
  if (!ALLOWED_BASES.has(baseUrl)) {
    return c.json({ error: 'INVALID_BASE' }, 400);
  }
  // model은 경로에 주입되므로 안전한 문자만 허용
  if (!/^[a-z0-9.\-]+$/i.test(model)) {
    return c.json({ error: 'INVALID_MODEL' }, 400);
  }

  const upstream = await fetch(
    `${baseUrl}/models/${model}:generateContent?key=${c.env.GEMINI_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }
  );

  // Gemini 응답(성공/에러 모두)을 상태코드째 그대로 전달
  const text = await upstream.text();
  return new Response(text, {
    status:  upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

export default app;
