import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth.js';
import creditsRouter   from './routes/credits.js';
import translateRouter from './routes/translate.js';
import webhookRouter   from './routes/webhook.js';

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────
app.use('*', cors({
  origin: ['chrome-extension://*'],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS']
}));

// ── 헬스체크 ──────────────────────────────────────────────
app.get('/health', (c) => c.json({ ok: true, version: '1.0.0' }));

// ── 웹훅 (인증 불필요 — Portone이 직접 호출) ─────────────
app.route('/webhook', webhookRouter);

// ── 인증 필요 라우트 ──────────────────────────────────────
app.use('/credits/*',   authMiddleware);
app.use('/translate/*', authMiddleware);

app.route('/credits',   creditsRouter);
app.route('/translate', translateRouter);

// ── 404 ───────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
app.onError((err, c) => {
  console.error('[API Error]', err);
  return c.json({ error: 'SERVER_ERROR', detail: err.message }, 500);
});

export default app;
