import { createClient } from '@supabase/supabase-js';

// Workers(c.env) 또는 Vercel(process.env) 모두 지원
function e(env, key) {
  return (env && env[key]) || process.env[key];
}

// 요청 단위로 클라이언트 재사용 (env 객체가 동일한 동안)
const cache = new WeakMap();

export function getSupabase(env) {
  if (!cache.has(env)) {
    cache.set(env, createClient(
      e(env, 'SUPABASE_URL'),
      e(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } }
    ));
  }
  return cache.get(env);
}
