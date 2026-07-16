import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const router = new Hono();

// ── 피추천인이 추천인 이메일로 연결 (1회·불변·본인 불가) ──
router.post('/apply', async (c) => {
  const userId = c.get('userId');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }
  const email = String(body.referrer_email || '').trim().toLowerCase();
  if (!email) return c.json({ error: 'MISSING_EMAIL' }, 400);

  const sb = getSupabase(c.env);

  // 이미 연결돼 있으면 거부(불변)
  const { data: me } = await sb.from('users').select('id, email, referred_by').eq('id', userId).single();
  if (!me) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  if (me.referred_by) return c.json({ error: 'ALREADY_SET' }, 409);
  if (String(me.email || '').toLowerCase() === email) return c.json({ error: 'SELF_REFERRAL' }, 400);

  // 추천인 조회(로그인 이력이 있어야 존재)
  const { data: referrer } = await sb.from('users').select('id').ilike('email', email).single();
  if (!referrer) return c.json({ error: 'REFERRER_NOT_FOUND' }, 404);
  if (referrer.id === userId) return c.json({ error: 'SELF_REFERRAL' }, 400);

  const { error } = await sb.from('users')
    .update({ referred_by: referrer.id, referred_at: new Date().toISOString() })
    .eq('id', userId)
    .is('referred_by', null); // 경합 방어(동시 요청 시 1회만)
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({ ok: true });
});

// ── 추천인 본인 현황(익스텐션 표시용): 내 코드(이메일)·누적 적립·피추천 수·최근 이력 ──
router.get('/', async (c) => {
  const userId = c.get('userId');
  const email  = c.get('email') || '';
  const sb = getSupabase(c.env);

  const { data: rewards } = await sb.from('referral_rewards')
    .select('referee_id, amount_krw, reward_date')
    .eq('referrer_id', userId)
    .order('reward_date', { ascending: false })
    .limit(60);

  const rows = rewards || [];
  const totalEarned = rows.reduce((s, r) => s + Number(r.amount_krw || 0), 0);
  const refereeCount = new Set(rows.map(r => r.referee_id)).size;

  return c.json({
    referral_code: email,            // 로그인 이메일이 곧 추천 코드
    total_earned: Math.round(totalEarned),
    referee_count: refereeCount,     // 최근 60건 기준(대략치)
    recent: rows.slice(0, 20).map(r => ({ date: r.reward_date, amount: Math.round(Number(r.amount_krw || 0)) })),
  });
});

// ── 관리자: 특정 날짜 적립 배치 수동 실행(테스트). index.js에서 admin 보호 ──
router.post('/accrue', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { /* 본문 없으면 어제 */ }
  const date = body.date || yesterdayKST();
  const sb = getSupabase(c.env);
  const { data, error } = await sb.rpc('accrue_referral_rewards', { p_date: date });
  if (error) return c.json({ error: 'SERVER_ERROR', detail: error.message }, 500);
  return c.json({ ok: true, date, accrued: data });
});

// KST 기준 "어제" 날짜(YYYY-MM-DD)
export function yesterdayKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

// 크론용: 어제분 적립 실행
export async function runReferralAccrual(env) {
  const sb = getSupabase(env);
  const date = yesterdayKST();
  const { error } = await sb.rpc('accrue_referral_rewards', { p_date: date });
  if (error) console.error('[referral accrual]', error.message);
}

export default router;
