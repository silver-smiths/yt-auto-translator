import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const router = new Hono();
const PAGE_SIZE = 10;

// Public: 공지 목록 (body 제외)
router.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const sb = getSupabase(c.env);

  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const { data, error, count } = await sb
    .from('notices')
    .select('id, title, type, author, created_at, updated_at', { count: 'exact' })
    .eq('published', true)
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
  return c.json(data);
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
