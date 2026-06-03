const GOOGLE_TOKENINFO = 'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=';

/**
 * Google OAuth 토큰 검증 + Supabase 사용자 upsert
 * @returns {{ id, google_id, email }} or null
 */
export async function verifyGoogleToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const res = await fetch(`${GOOGLE_TOKENINFO}${token}`);
    if (!res.ok) return null;

    const info = await res.json();
    if (info.error || !info.sub || !info.email) return null;

    const { getSupabase } = await import('./supabase.js');
    const db = getSupabase(env);

    // users 테이블 upsert (최초 접속 시 자동 생성)
    const { data: user, error } = await db
      .from('users')
      .upsert({ google_id: info.sub, email: info.email, display_name: info.name || null },
               { onConflict: 'google_id' })
      .select('id, google_id, email')
      .single();

    if (error) { console.error('[auth] upsert error:', error.message); return null; }

    // credit_accounts 없으면 생성
    await db
      .from('credit_accounts')
      .upsert({ user_id: user.id, balance: 0, tier: 'light' }, { onConflict: 'user_id' });

    return user;
  } catch (err) {
    console.error('[auth] verifyGoogleToken error:', err.message);
    return null;
  }
}
