import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware }  from './middleware/auth.js';
import { adminMiddleware } from './middleware/admin.js';
import creditsRouter   from './routes/credits.js';
import translateRouter from './routes/translate.js';
import webhookRouter   from './routes/webhook.js';
import noticesRouter   from './routes/notices.js';
import adminRouter     from './routes/admin.js';
import authRouter      from './routes/auth.js';
import geminiRelayRouter from './routes/gemini-relay.js';
import opsRouter         from './routes/ops.js';

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*';
    if (origin.startsWith('chrome-extension://')) return origin;
    if (origin === 'https://silver-smiths.com') return origin;
    return null;
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: false,
}));

// ── 헬스체크 ──────────────────────────────────────────────
app.get('/health', (c) => c.json({ ok: true, version: '1.0.0' }));

// ── 웹훅 (인증 불필요 — Portone이 직접 호출) ─────────────
app.route('/webhook', webhookRouter);

// ── Gemini 릴레이 (자체 시크릿 인증 — Workers가 미국 리전 경유 호출) ─────────
app.route('/gemini/relay', geminiRelayRouter);

// ── 공지 어드민 라우트 (GET 포함 전 메서드) ──────────────
app.use('/notices/admin/*', authMiddleware, adminMiddleware);
// ── 공지 쓰기/수정/삭제 (POST /notices, PATCH·DELETE /notices/:id)
app.on(['POST', 'PATCH', 'DELETE'], ['/notices', '/notices/*'],
  authMiddleware, adminMiddleware);

// ── Ops: 설정 변경(PATCH)만 관리자 보호. POST /ops/errors·GET /ops/config는 공개 ──
app.on(['PATCH'], ['/ops/config'], authMiddleware, adminMiddleware);

// ── 인증 필요 라우트 ──────────────────────────────────────
app.use('/auth/*',            authMiddleware); // Google 토큰 → 세션 토큰 교환
app.use('/credits/*',         authMiddleware);
app.use('/translate/*',       authMiddleware);
app.use('/admin/*',           authMiddleware, adminMiddleware);

app.route('/auth',      authRouter);
app.route('/credits',   creditsRouter);
app.route('/translate', translateRouter);
app.route('/admin',     adminRouter);
app.route('/notices',   noticesRouter);
app.route('/ops',       opsRouter);

// ── 404 ───────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
app.onError((err, c) => {
  console.error('[API Error]', err);
  const isDev = c.env?.ENVIRONMENT !== 'production';
  return c.json({
    error: 'SERVER_ERROR',
    ...(isDev && { detail: err.message }),
  }, 500);
});

export default app;
