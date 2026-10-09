import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { notifyError } from '../lib/errors.js';

const router = new Hono();
const PAGE_SIZE = 10;

// 공지를 번역할 UI 언어 (원문은 한국어). 확장 시 여기에 추가: es:'Spanish', ja:'Japanese' ...
const NOTICE_LANGS = { en: 'English' };
const GEMINI_V1BETA = 'https://generativelanguage.googleapis.com/v1beta';

// 요청 언어 → 번역본이 있으면 제목/본문 교체 (없으면 원문 유지). translations 필드는 응답에서 제거.
function applyNoticeLang(n, lang, withBody) {
  const code = (lang || '').slice(0, 2).toLowerCase();
  const tr = (code && code !== 'ko' && n.translations) ? n.translations[code] : null;
  const { translations, ...rest } = n;
  rest.title = tr?.title || n.title;
  if (withBody) rest.body = tr?.body ?? n.body;
  return rest;
}

// 우리 Gemini로 공지 제목·본문 번역 (실패 시 null → 원문 폴백)
async function translateNoticeText(env, title, body, targetLangName) {
  const model = 'gemini-2.5-flash';
  const prompt =
    `Translate this notice from Korean into ${targetLangName}. Preserve any HTML/markdown and line breaks. ` +
    `Return ONLY JSON {"title":"...","body":"..."}.\n\nTITLE:\n${title}\n\nBODY:\n${body}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  try {
    const res = env.GEMINI_RELAY_URL
      ? await fetch(env.GEMINI_RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-relay-secret': env.GEMINI_RELAY_SECRET || '' }, body: JSON.stringify({ model, base: GEMINI_V1BETA, payload }) })
      : await fetch(`${GEMINI_V1BETA}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { await notifyError(env, 'notices/translate', new Error(`번역 실패 ${res.status}`)); return null; }
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return raw ? JSON.parse(raw) : null;
  } catch (e) { await notifyError(env, 'notices/translate-exception', e); return null; }
}

// 게시 상태면 원문(_src) 기준으로 번역본 보강 (원문 그대로면 스킵). 실패는 무시하고 원문 폴백.
async function ensureNoticeTranslation(env, sb, notice) {
  if (!notice?.published) return;
  const src = (notice.title || '') + '\n' + (notice.body || '');
  const existing = notice.translations || {};
  if (existing._src === src && Object.keys(existing).length > 1) return; // 이 원문으로 이미 번역됨
  const out = { _src: src };
  for (const [code, name] of Object.entries(NOTICE_LANGS)) {
    const t = await translateNoticeText(env, notice.title, notice.body, name);
    if (t?.title && t?.body) out[code] = { title: t.title, body: t.body };
  }
  await sb.from('notices').update({ translations: out }).eq('id', notice.id);
}

// Public: 공지 목록 (body 제외)
router.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const sb = getSupabase(c.env);

  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const { data, error, count } = await sb
    .from('notices')
    .select('id, title, translations, type, author, created_at, updated_at', { count: 'exact' })
    .eq('published', true)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  const lang = c.req.query('lang');
  return c.json({
    notices:    data.map(n => applyNoticeLang(n, lang, false)),
    total:      count,
    page,
    totalPages: Math.ceil(count / PAGE_SIZE),
  });
});

// Admin: 목록 전체 (비게시 포함) — /:id 보다 먼저 등록해야 함
router.get('/admin/all', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const sb = getSupabase(c.env);

  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const { data, error, count } = await sb
    .from('notices')
    .select('id, title, type, author, published, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);

  return c.json({
    notices:    data,
    total:      count,
    page,
    totalPages: Math.ceil(count / PAGE_SIZE),
  });
});

// Admin: 공지 상세 (비게시 포함) — 관리자 페이지에서 초안 열람/수정용
router.get('/admin/:id', async (c) => {
  const sb = getSupabase(c.env);
  const { data, error } = await sb
    .from('notices')
    .select('*')
    .eq('id', c.req.param('id'))
    .single();

  if (error || !data) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json(data);
});

// Public: 공지 상세 (body 포함) — /admin/all 뒤에 등록
router.get('/:id', async (c) => {
  const sb = getSupabase(c.env);
  const { data, error } = await sb
    .from('notices')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('published', true)
    .single();

  if (error || !data) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json(applyNoticeLang(data, c.req.query('lang'), true));
});

// Admin: 공지 작성
router.post('/', async (c) => {
  const { title, body, type = 'info', published = false } = await c.req.json();
  if (!title?.trim() || !body?.trim()) return c.json({ error: 'INVALID_PARAMS' }, 400);

  const sb = getSupabase(c.env);
  const { data, error } = await sb
    .from('notices')
    .insert({ title, body, type, published, author: c.get('email') })
    .select()
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);
  await ensureNoticeTranslation(c.env, sb, data); // 게시로 생성되면 자동 번역
  return c.json(data, 201);
});

// Admin: 공지 수정
router.patch('/:id', async (c) => {
  const updates = await c.req.json();
  const allowed = ['title', 'body', 'type', 'published'];
  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );
  if (!Object.keys(filtered).length) return c.json({ error: 'INVALID_PARAMS' }, 400);

  filtered.updated_at = new Date().toISOString();

  const sb = getSupabase(c.env);
  const { data, error } = await sb
    .from('notices')
    .update(filtered)
    .eq('id', c.req.param('id'))
    .select()
    .single();

  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);
  if (!data) return c.json({ error: 'NOT_FOUND' }, 404);
  await ensureNoticeTranslation(c.env, sb, data); // 게시 상태·내용 변경 시 재번역
  return c.json(data);
});

// Admin: 공지 삭제 (복수)
router.delete('/', async (c) => {
  const { ids } = await c.req.json();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'INVALID_PARAMS' }, 400);

  const sb = getSupabase(c.env);
  const { error } = await sb.from('notices').delete().in('id', ids);
  if (error) return c.json({ error: 'SERVER_ERROR' }, 500);
  return c.json({ ok: true });
});

export default router;
