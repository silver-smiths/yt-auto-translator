-- 016: 공지 다국어 — 게시 시 자동 번역 결과를 언어별로 저장.
-- translations = { "_src": "<번역 근거가 된 원문 title+body>", "en": {"title":"...","body":"..."} , ... }
-- _src로 원문 변경 여부를 판단해 불필요한 재번역을 막는다.

alter table public.notices
  add column if not exists translations jsonb not null default '{}'::jsonb;
