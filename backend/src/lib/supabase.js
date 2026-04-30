import { createClient } from '@supabase/supabase-js';

/**
 * Supabase 클라이언트 (service_role — RLS 우회)
 * Cloudflare Workers env에서 호출
 */
export function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}
