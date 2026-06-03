import { verifyGoogleToken } from '../lib/auth.js';
import { getSupabase } from '../lib/supabase.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const TIER_MULTIPLIER = { light: 1.3, standard: 1.2, heavy: 1.1 };

export async function handleCredits(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const db = getSupabase(env);
  const { data: account, error } = await db
    .from('credit_accounts')
    .select('balance, tier')
    .eq('user_id', user.id)
    .single();

  if (error) return json({ error: error.message }, 500);

  return json({
    credits:    Math.round((account.balance ?? 0) * 100) / 100,
    tier:       account.tier ?? 'light',
    multiplier: TIER_MULTIPLIER[account.tier] ?? 1.3,
  });
}
