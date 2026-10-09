import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { notifyError } from '../lib/errors.js';

const app = new Hono();

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2시간

function newSessionToken() {
  const rand = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  return 'ytat_sess_' + rand;
}

// ── 세션 토큰 발급 ──────────────────────────────────────────
// authMiddleware(Google 토큰)를 통과한 뒤 호출됨. 웹페이지가 쓸 단기 세션 토큰을 발급한다.
// 이 토큰에는 YouTube 권한이 없으므로 유출돼도 계정 탈취 불가.
app.post('/session', async (c) => {
  const userId = c.get('userId');
  const email  = c.get('email');
  const sb = getSupabase(c.env);

  // 관리자 여부 (버튼 노출 판단용 — 실제 권한은 admin API가 서버에서 재확인)
  const { data: admin } = await sb
    .from('admin_accounts')
    .select('id')
    .eq('email', email)
    .single();
  const isAdmin = !!admin;

  // 기존 유효 세션 재사용 — 매 방문마다 새 토큰을 만들지 않아 토큰 남발·유효토큰 수(공격 표면)·테이블 비대를 줄임
  const nowIso = new Date().toISOString();
  const { data: existing } = await sb
    .from('admin_sessions')
    .select('token')
    .eq('user_id', userId)
    .gt('expires_at', nowIso)
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.token) {
    return c.json({ session_token: existing.token, is_admin: isAdmin, email });
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const { error } = await sb
    .from('admin_sessions')
    .insert({ token, user_id: userId, email, is_admin: isAdmin, expires_at: expiresAt });

  if (error) {
    await notifyError(c.env, 'auth/session-insert', new Error(error.message));
    return c.json({ error: 'SERVER_ERROR' }, 500);
  }

  return c.json({ session_token: token, is_admin: isAdmin, email });
});

export default app;
