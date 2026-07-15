import { getSupabase } from '../lib/supabase.js';

/**
 * Google OAuth 토큰 검증 미들웨어
 * 익스텐션이 chrome.identity.getAuthToken()으로 받은 토큰을 Authorization 헤더로 전달
 * → Google tokeninfo 엔드포인트로 검증 → Supabase users 테이블에 upsert
 */
export async function authMiddleware(c, next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const token = authHeader.slice(7);

  // ── 세션 토큰 경로 (웹페이지용 — YouTube 권한 없는 단기 토큰) ──────────
  if (token.startsWith('ytat_sess_')) {
    const sb = getSupabase(c.env);
    const { data: sess } = await sb
      .from('admin_sessions')
      .select('user_id, email, expires_at')
      .eq('token', token)
      .single();
    if (!sess || new Date(sess.expires_at) < new Date()) {
      return c.json({ error: 'SESSION_EXPIRED' }, 401);
    }
    c.set('userId', sess.user_id);
    c.set('email',  sess.email);
    await next();
    return;
  }

  // ── Google OAuth 토큰 경로 (익스텐션 직접 호출) ──────────────────────
  // Google tokeninfo로 검증
  let info;
  try {
    const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    if (!res.ok) {
      return c.json({ error: 'INVALID_TOKEN' }, 401);
    }
    info = await res.json();
  } catch {
    return c.json({ error: 'AUTH_SERVICE_UNAVAILABLE' }, 503);
  }

  if (!info.sub || !info.email) {
    return c.json({ error: 'INVALID_TOKEN' }, 401);
  }

  // aud 검증: 우리 앱에서 발급된 토큰인지 확인
  const expectedClientId = c.env.GOOGLE_CLIENT_ID;
  if (!expectedClientId) {
    console.error('[auth] GOOGLE_CLIENT_ID 환경변수 미설정');
    return c.json({ error: 'SERVER_MISCONFIGURED' }, 500);
  }
  if (info.aud !== expectedClientId) {
    return c.json({ error: 'INVALID_TOKEN' }, 401);
  }

  // Supabase에 사용자 upsert (첫 방문 시 자동 생성)
  const sb = getSupabase(c.env);
  const { data: user, error } = await sb
    .from('users')
    .upsert(
      { google_id: info.sub, email: info.email, updated_at: new Date().toISOString() },
      { onConflict: 'google_id', returning: 'representation' }
    )
    .select('id, email')
    .single();

  if (error) {
    console.error('User upsert 실패:', error);
    return c.json({ error: 'SERVER_ERROR' }, 500);
  }

  // credit_accounts가 없으면 생성
  await sb
    .from('credit_accounts')
    .upsert({ user_id: user.id }, { onConflict: 'user_id' });

  c.set('userId', user.id);
  c.set('email',  user.email);
  await next();
}
