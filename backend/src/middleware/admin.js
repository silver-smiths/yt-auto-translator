import { getSupabase } from '../lib/supabase.js';

export async function adminMiddleware(c, next) {
  const email = c.get('email');
  if (!email) return c.json({ error: 'UNAUTHORIZED' }, 401);

  const sb = getSupabase(c.env);
  const { data } = await sb
    .from('admin_accounts')
    .select('id')
    .eq('email', email)
    .single();

  if (!data) return c.json({ error: 'FORBIDDEN' }, 403);
  await next();
}
