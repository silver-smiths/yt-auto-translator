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

  // Google tokeninfo로 검증
  const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (!res.ok) {
    return c.json({ error: 'INVALID_TOKEN' }, 401);
  }
  const info = await res.json();

  if (!info.sub || !info.email) {
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
    .upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });

  c.set('userId', user.id);
  c.set('email',  user.email);
  await next();
}
