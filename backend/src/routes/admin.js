import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { INPUT_PER_M, OUTPUT_PER_M, CREDIT_MULTIPLIER } from '../lib/constants.js';

const router = new Hono();

function calcRevenue(inputTokens, outputTokens) {
  return Math.round(
    (inputTokens * INPUT_PER_M + outputTokens * OUTPUT_PER_M) / 1_000_000 * CREDIT_MULTIPLIER * 10000
  ) / 10000;
}

// 관리자 여부 확인
router.get('/check', (c) => c.json({ ok: true, email: c.get('email') }));

// 통계
router.get('/stats', async (c) => {
  const { from, to } = c.req.query();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    return c.json({ error: 'INVALID_PARAMS' }, 400);
  }

  const sb = getSupabase(c.env);

  const [jobsRes, paymentsRes] = await Promise.all([
    sb
      .from('translation_jobs')
      .select('user_id, input_tokens, output_tokens, created_at')
      .gte('created_at', from + 'T00:00:00Z')
      .lte('created_at', to   + 'T23:59:59Z')
      .eq('status', 'completed'),
    sb
      .from('payments')
      .select('user_id, amount_usd, amount_paid, currency, created_at')
      .gte('created_at', from + 'T00:00:00Z')
      .lte('created_at', to   + 'T23:59:59Z')
      .eq('status', 'completed'),
  ]);

  if (jobsRes.error || paymentsRes.error) return c.json({ error: 'SERVER_ERROR' }, 500);

  // 일별 집계 (jobs)
  const jobsByDay = {};
  for (const job of jobsRes.data) {
    const day = job.created_at.slice(0, 10);
    if (!jobsByDay[day]) jobsByDay[day] = { users: new Set(), inputTokens: 0, outputTokens: 0 };
    jobsByDay[day].users.add(job.user_id);
    jobsByDay[day].inputTokens  += (job.input_tokens  || 0);
    jobsByDay[day].outputTokens += (job.output_tokens || 0);
  }

  // 일별 집계 (payments)
  const paymentsByDay = {};
  for (const p of paymentsRes.data) {
    const day = p.created_at.slice(0, 10);
    if (!paymentsByDay[day]) paymentsByDay[day] = { count: 0, amountUsd: 0, amountKrw: 0 };
    paymentsByDay[day].count     += 1;
    paymentsByDay[day].amountUsd += p.amount_usd || 0;
    if (p.currency === 'KRW') paymentsByDay[day].amountKrw += p.amount_paid || 0;
  }

  const days = [...new Set([...Object.keys(jobsByDay), ...Object.keys(paymentsByDay)])].sort();

  const daily = days.map(day => {
    const j = jobsByDay[day];
    const pay = paymentsByDay[day];
    return {
      date:       day,
      users:      j?.users.size || 0,
      tokens:     (j?.inputTokens || 0) + (j?.outputTokens || 0),
      revenue:    calcRevenue(j?.inputTokens || 0, j?.outputTokens || 0),
      payments:   pay?.count     || 0,
      chargedUsd: Math.round((pay?.amountUsd || 0) * 10000) / 10000,
      chargedKrw: pay?.amountKrw || 0,
    };
  });

  // 사용자별 집계
  const userMap = {};
  for (const job of jobsRes.data) {
    if (!userMap[job.user_id]) userMap[job.user_id] = { inputTokens: 0, outputTokens: 0, chargedUsd: 0, chargedKrw: 0 };
    userMap[job.user_id].inputTokens  += (job.input_tokens  || 0);
    userMap[job.user_id].outputTokens += (job.output_tokens || 0);
  }
  for (const p of paymentsRes.data) {
    if (!userMap[p.user_id]) userMap[p.user_id] = { inputTokens: 0, outputTokens: 0, chargedUsd: 0, chargedKrw: 0 };
    userMap[p.user_id].chargedUsd += p.amount_usd || 0;
    if (p.currency === 'KRW') userMap[p.user_id].chargedKrw += p.amount_paid || 0;
  }

  const userIds = Object.keys(userMap);
  let userEmails = {};
  if (userIds.length) {
    const { data: users, error: usersError } = await sb.from('users').select('id, email').in('id', userIds);
    if (!usersError) for (const u of users || []) userEmails[u.id] = u.email;
  }

  const byUser = Object.entries(userMap)
    .map(([id, s]) => ({
      user_id:    id,
      email:      userEmails[id] || id,
      tokens:     s.inputTokens + s.outputTokens,
      revenue:    calcRevenue(s.inputTokens, s.outputTokens),
      chargedUsd: Math.round(s.chargedUsd * 10000) / 10000,
      chargedKrw: s.chargedKrw,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return c.json({ daily, byUser });
});

export default router;
