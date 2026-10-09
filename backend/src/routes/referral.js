import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { notifyError } from '../lib/errors.js';

const router = new Hono();

function genReferralCode() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8); // 8자 (링크용, 타이핑 대상 아님)
}

// ── 피추천인이 추천 코드로 연결 (1회·불변·본인 불가) ──
router.post('/apply', async (c) => {
  const userId = c.get('userId');
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }
  const code = String(body.code || '').trim();
  if (!code) return c.json({ error: 'MISSING_CODE' }, 400);

  const sb = getSupabase(c.env);

  // 이미 연결돼 있으면 거부(불변)
  const { data: me } = await sb.from('users').select('id, referred_by').eq('id', userId).single();
  if (!me) return c.json({ error: 'USER_NOT_FOUND' }, 404);
  if (me.referred_by) return c.json({ error: 'ALREADY_SET' }, 409);

  // 코드로 추천인 조회
  const { data: referrer } = await sb.from('users').select('id, referred_by').eq('referral_code', code).single();
  if (!referrer) return c.json({ error: 'INVALID_CODE' }, 404);
  if (referrer.id === userId) return c.json({ error: 'SELF_REFERRAL' }, 400);      // 자기 자신 불가
  if (referrer.referred_by === userId) return c.json({ error: 'CIRCULAR_REFERRAL' }, 400); // 맞추천(A↔B) 불가

  const { error } = await sb.from('users')
    .update({ referred_by: referrer.id, referred_at: new Date().toISOString() })
    .eq('id', userId)
    .is('referred_by', null); // 경합 방어(동시 요청 시 1회만)
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({ ok: true });
});

// ── 추천인 본인 현황(익스텐션 표시용): 내 추천 코드·누적 적립·피추천 수·최근 이력 ──
router.get('/', async (c) => {
  const userId = c.get('userId');
  const sb = getSupabase(c.env);

  // 추천 코드가 없으면 생성(최초 조회 시). 희박한 충돌은 1회 재시도.
  const { data: u } = await sb.from('users').select('referral_code, referred_by').eq('id', userId).single();
  let code = u?.referral_code;
  const referred = !!u?.referred_by; // 이미 추천 코드로 연결됐는지 (입력창 노출 판단용)
  if (!code) {
    for (let i = 0; i < 2 && !code; i++) {
      const candidate = genReferralCode();
      // .select()로 실제 갱신 행을 확인 — 동시요청으로 0행 갱신 시 candidate를 확정하지 않음(경합 방지)
      const { data: upd, error } = await sb.from('users')
        .update({ referral_code: candidate }).eq('id', userId).is('referral_code', null)
        .select('referral_code');
      if (!error && upd && upd.length > 0) code = candidate;
    }
    // 경합으로 이미 생성됐을 수 있으니 재조회
    if (!code) { const { data: re } = await sb.from('users').select('referral_code').eq('id', userId).single(); code = re?.referral_code; }
  }

  // 정확한 누적 적립·추천 인원 (전체 집계 — RPC)
  const { data: summary } = await sb.rpc('referral_summary', { p_referrer: userId });
  const s = (summary && summary[0]) || { total_earned: 0, referee_count: 0 };

  // 최근 적립 내역(표시용 20건)
  const { data: rewards } = await sb.from('referral_rewards')
    .select('amount_krw, reward_date')
    .eq('referrer_id', userId)
    .order('reward_date', { ascending: false })
    .limit(20);

  return c.json({
    referral_code: code || null,     // 공유 링크: PAYMENT_URL?ref=<code> (익스텐션에서 조합)
    referred,                        // 내가 이미 추천 코드로 연결됐는지
    total_earned: Math.round(Number(s.total_earned || 0)),
    referee_count: Number(s.referee_count || 0),
    recent: (rewards || []).map(r => ({ date: r.reward_date, amount: Math.round(Number(r.amount_krw || 0)) })),
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

// KST 기준 N일 전 날짜(YYYY-MM-DD)
function kstDateBack(days) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - days);
  return kst.toISOString().slice(0, 10);
}
export function yesterdayKST() { return kstDateBack(1); }

// 크론용(매일 KST 00:00 = UTC 15:00 실행): 최근 3일 재계산 + 만료 세션 정리
// - accrue는 멱등(unique referee+date)이라 이미 적립된 날은 건너뜀 → 배포/장애로 밤을 놓쳐도
//   다음 실행이 놓친 날(최대 2일 전까지)을 자동 catch-up.
export async function runReferralAccrual(env) {
  const sb = getSupabase(env);
  for (let back = 1; back <= 3; back++) {
    const date = kstDateBack(back);
    const { error } = await sb.rpc('accrue_referral_rewards', { p_date: date });
    if (error) await notifyError(env, 'referral/accrual', new Error(error.message), { date });
  }
  // 만료 세션 정리 (#1 보완 — admin_sessions 비대·유효토큰 누적 방지)
  await sb.from('admin_sessions').delete().lt('expires_at', new Date().toISOString());
}

export default router;
