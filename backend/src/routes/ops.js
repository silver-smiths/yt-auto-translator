import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { tgSafe, tgEscape } from '../lib/errors.js';

const router = new Hono();

const MAX_MSG = 2000;
const MAX_CTX = 4000;

// 텔레그램 알림(실패해도 오류 보고 자체는 성공 처리 — 알림은 부가 기능)
async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const payload = { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
    if (env.TELEGRAM_ERROR_THREAD_ID) payload.message_thread_id = parseInt(env.TELEGRAM_ERROR_THREAD_ID, 10);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch { /* 알림 실패는 무시 */ }
}

// ── 공개: 클라이언트/서버 오류 보고 ──────────────────────
// 인증 없음(오류는 미인증 시점에도 발생). 크기 제한 + 지문 필수. (rate-limit은 Phase 2 하드닝)
router.post('/errors', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }

  const fingerprint = String(body.fingerprint || '').slice(0, 200);
  if (!fingerprint) return c.json({ error: 'MISSING_FINGERPRINT' }, 400);

  const source  = String(body.source || 'extension').slice(0, 20);
  const version = String(body.version || '').slice(0, 40);
  const message = String(body.message || '').slice(0, MAX_MSG);
  const anon    = String(body.anon_hash || '').slice(0, 64);
  let context = body.context ?? null;
  try { if (context && JSON.stringify(context).length > MAX_CTX) context = { truncated: true }; }
  catch { context = null; }

  const sb = getSupabase(c.env);
  const { data: isNew, error } = await sb.rpc('record_error', {
    p_source: source, p_version: version, p_fingerprint: fingerprint,
    p_message: message, p_context: context, p_anon_hash: anon,
  });
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  // 신규 지문만 알림(같은 오류 도배 방지). 재발은 집계만 증가.
  if (isNew) {
    // /ops/errors는 공개(비인증) → 클라이언트 입력(message·stack·detail)을 텔레그램(Markdown)에 넣기 전
    // 토큰·이메일 마스킹 + Markdown 이스케이프 (운영자 채널로의 주입/민감정보 유출 방지)
    const safe = tgSafe;
    let text = `🐞 [YTAT/${source}] 새 오류\n\`${fingerprint}\`\n${safe(message) || '(no message)'}`;
    const d = (context && typeof context === 'object') ? context.detail : null;
    if (d) {
      text += `\n\n🎯 대상: ${safe(d.targets) || '-'}` +
              `\n🌐 언어: ${safe((d.langs || []).join(', ')) || '-'}` +
              `\n📊 결과: ${safe(d.result) || '-'}`;
      if (d.failNames?.length)   text += `\n❌ 실패대상: ${safe(d.failNames.join(', '))}`;
      if (d.failReasons?.length) text += `\n⚠️ 실패사유: ${safe(d.failReasons.join(', '))}`;
      if (d.videoId)             text += `\n📹 영상: ${safe(d.videoTitle)} (${safe(d.videoId)})`;
      if (d.credits != null)     text += `\n💰 비용: ${safe(d.credits)} 크레딧`;
    }
    // 번역 상세가 없는 일반 에러는 스택을 실어 원인 파악 가능하게
    const st = (context && typeof context === 'object') ? context.stack : null;
    if (st && !d) text += `\n\n${safe(String(st).slice(0, 600))}`;
    await notify(c.env, text);
  }
  return c.json({ ok: true });
});

// ── 공개: 원격 설정 조회 (익스텐션이 폴링) ────────────────
router.get('/config', async (c) => {
  const sb = getSupabase(c.env);
  const { data, error } = await sb.from('app_config').select('key, value');
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);
  const cfg = {};
  for (const row of data || []) cfg[row.key] = row.value;
  return c.json(cfg);
});

// ── 관리자: 스위치 변경 (kill-switch). index.js에서 authMiddleware+adminMiddleware로 보호 ──
router.patch('/config', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'BAD_JSON' }, 400); }
  const { key, value } = body;
  if (!key) return c.json({ error: 'MISSING_KEY' }, 400);

  const sb = getSupabase(c.env);
  const { error } = await sb.from('app_config').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: c.get('email') },
    { onConflict: 'key' }
  );
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  await notify(c.env, `⚙️ [YTAT] 설정 변경: \`${tgSafe(key)}\` = ${tgSafe(JSON.stringify(value))} (by ${tgEscape(c.get('email') || '?')})`);
  return c.json({ ok: true });
});

// ── 자동 완화 워처 (Phase 2) ─────────────────────────────
// 최근 창(window) 내 feature별 오류 급증 감지 → 자동 플립(자막/메타만) 또는 알림(결제/마스터).
// 가드레일: 결제·마스터는 자동 플립 안 함(알림만), 자동 재활성 없음(플래핑 방지), 쿨다운 적용.
const FEATURE_SWITCH = {
  subtitles: 'translate.subtitles.enabled',
  metadata:  'translate.metadata.enabled',
};

export async function runAutoHeal(env) {
  const sb = getSupabase(env);

  const { data: cfgRows } = await sb.from('app_config').select('key, value');
  const cfg = {};
  for (const r of cfgRows || []) cfg[r.key] = r.value;

  const ah = cfg['ops.autoheal'] || {};
  if (ah.enabled === false) return { skipped: 'disabled' };
  const windowMin = ah.window_min || 15;
  const minCount  = ah.min_count  || 20;
  const minUsers  = ah.min_users  || 3;

  const sinceIso = new Date(Date.now() - windowMin * 60000).toISOString();
  const { data: rows } = await sb
    .from('error_events')
    .select('feature, anon_hash')
    .gte('created_at', sinceIso)
    .not('feature', 'is', null);

  const byFeature = {};
  for (const r of rows || []) {
    const f = (byFeature[r.feature] = byFeature[r.feature] || { count: 0, users: new Set() });
    f.count++;
    if (r.anon_hash) f.users.add(r.anon_hash);
  }

  const actions = [];
  for (const [feature, agg] of Object.entries(byFeature)) {
    if (agg.count < minCount || agg.users.size < minUsers) continue;
    const switchKey = FEATURE_SWITCH[feature];

    if (!switchKey) {
      // 결제·마스터·미지 기능 → 자동 플립 금지, 알림만
      await notify(env, `⚠️ [YTAT/감시] '${tgSafe(feature)}' 오류 급증 (${agg.count}건/${agg.users.size}명, ${windowMin}분). 수동 점검 권장.`);
      await sb.from('ops_actions').insert({ action: 'auto_alert', target: feature, reason: `${agg.count}건/${agg.users.size}명` });
      continue;
    }
    if (cfg[switchKey] === false) continue; // 이미 off

    // 쿨다운 — 최근 창 안에 같은 스위치 자동조치 있었으면 스킵
    const { data: recent } = await sb.from('ops_actions')
      .select('id').eq('target', switchKey).gte('created_at', sinceIso).limit(1);
    if (recent && recent.length) continue;

    await sb.from('app_config').upsert(
      { key: switchKey, value: false, updated_at: new Date().toISOString(), updated_by: 'autoheal' },
      { onConflict: 'key' });
    await sb.from('ops_actions').insert({ action: 'auto_disable', target: switchKey, reason: `${agg.count}건/${agg.users.size}명 (${windowMin}분)` });
    await notify(env, `🔧 [YTAT/자동수복] '${tgSafe(feature)}' 오류 급증 → \`${switchKey}\` 자동 OFF (${agg.count}건/${agg.users.size}명). 수정 후 어드민에서 재활성 필요.`);
    actions.push(switchKey);
  }
  return { actions, checked: Object.keys(byFeature).length };
}

// 관리자: 워처 수동 실행(테스트/즉시 점검). index.js에서 admin 보호.
router.post('/autoheal/run', async (c) => {
  const result = await runAutoHeal(c.env);
  return c.json({ ok: true, result });
});

export default router;
