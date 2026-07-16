import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const router = new Hono();

const MAX_MSG = 2000;
const MAX_CTX = 4000;

// 텔레그램 알림(실패해도 오류 보고 자체는 성공 처리 — 알림은 부가 기능)
async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const payload = { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    if (env.TELEGRAM_ERROR_THREAD_ID) payload.message_thread_id = parseInt(env.TELEGRAM_ERROR_THREAD_ID, 10);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch { /* 알림 실패는 무시 */ }
}

// ── 공개: 클라이언트/서버 오류 보고 ──────────────────────
// 인증 없음(오류는 미인증 시점에도 발생). 크기 제한 + 지문 필수. (rate-limit은 Phase 2 하드닝)
router.post('/errors', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }

  const fingerprint = String(body.fingerprint || '').slice(0, 200);
  if (!fingerprint) return c.json({ error: 'MISSING_FINGERPRINT' }, 400);

  const source  = String(body.source || 'extension').slice(0, 20);
  const version = String(body.version || '').slice(0, 40);
  const message = String(body.message || '').slice(0, MAX_MSG);
  const anon    = String(body.anon_hash || '').slice(0, 64);
  let context = body.context ?? null;
  try { if (context && JSON.stringify(context).length > MAX_CTX) context = { truncated: true }; }
  catch { context = null; }

  const sb = getSupabase(c.env);
  const { data: isNew, error } = await sb.rpc('record_error', {
    p_source: source, p_version: version, p_fingerprint: fingerprint,
    p_message: message, p_context: context, p_anon_hash: anon,
  });
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  // 신규 지문만 알림(같은 오류 도배 방지). 재발은 집계만 증가.
  if (isNew) await notify(c.env, `🐞 [YTAT/${source}] 새 오류\n\`${fingerprint}\`\n${message || '(no message)'}`);
  return c.json({ ok: true });
});

// ── 공개: 원격 설정 조회 (익스텐션이 폴링) ────────────────
router.get('/config', async (c) => {
  const sb = getSupabase(c.env);
  const { data, error } = await sb.from('app_config').select('key, value');
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);
  const cfg = {};
  for (const row of data || []) cfg[row.key] = row.value;
  return c.json(cfg);
});

// ── 관리자: 스위치 변경 (kill-switch). index.js에서 authMiddleware+adminMiddleware로 보호 ──
router.patch('/config', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }
  const { key, value } = body;
  if (!key) return c.json({ error: 'MISSING_KEY' }, 400);

  const sb = getSupabase(c.env);
  const { error } = await sb.from('app_config').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: c.get('email') },
    { onConflict: 'key' }
  );
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  await notify(c.env, `⚙️ [YTAT] 설정 변경: \`${key}\` = ${JSON.stringify(value)} (by ${c.get('email') || '?'})`);
  return c.json({ ok: true });
});

export default router;
