-- 웹페이지(결제·관리자)용 단기 세션 토큰 (2026-07-12)
-- youtube.force-ssl OAuth 토큰을 웹에 노출하지 않기 위해, 익스텐션이 백엔드에서
-- 세션 토큰(YouTube 권한 없음)을 교환받아 웹페이지에 전달한다.

CREATE TABLE IF NOT EXISTS public.admin_sessions (
  token       text PRIMARY KEY,                       -- 'ytat_sess_...' 랜덤
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  is_admin    boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON public.admin_sessions(expires_at);
