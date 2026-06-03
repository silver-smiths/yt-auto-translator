# YTAT v2 — 기술 스택

## Chrome Extension

| 항목 | 기술 |
|------|------|
| Manifest | V3 |
| 언어 | Vanilla JS (ES Module) |
| 스타일 | CSS (no framework) |
| 빌드 | 없음 (직접 로드) |
| 번들러 | 없음 |

### 구성 요소
- `manifest.json` — 권한·리소스 선언
- `src/background/service-worker.js` — 번역 오케스트레이션
- `src/content/` — YouTube Studio 사이드바 injection
- `src/options/` — 설정 페이지
- `src/lib/` — 공통 유틸리티 (constants, storage, youtube-api, llm-api, backend-api)

---

## Backend (Cloudflare Workers)

| 항목 | 기술 |
|------|------|
| 런타임 | Cloudflare Workers (V8 isolates) |
| 언어 | JavaScript (ES Module) |
| 설정 | wrangler.toml |
| DB 클라이언트 | Supabase JS SDK (fetch 기반) |

### API 엔드포인트 (Workers)
- `yt-auto-translator-api.1009yjh.workers.dev` — 메인 API 서버
  - `GET /credits` — 크레딧 잔액 조회
  - `POST /translate/job` — 번역 작업 생성
  - `PATCH /translate/job/:id` — 작업 상태 업데이트
  - `POST /translate/chunk` — Gemini 프록시 (청크 번역)
  - `POST /webhook/portone` — 결제 완료 웹훅

---

## Database (Supabase)

| 항목 | 기술 |
|------|------|
| DB | PostgreSQL (Supabase 관리형) |
| 인증 | Google OAuth (chrome.identity + Supabase Auth) |
| RLS | 활성화 (사용자 본인 데이터만 접근) |

### 주요 테이블
- `users` — Google 계정 기반 사용자
- `credit_accounts` — 크레딧 잔액 + 누적 사용량 + 티어
- `payments` — Portone 결제 기록
- `credit_transactions` — 충전/차감 이력
- `translation_jobs` — 번역 작업 단위 (토큰·비용·크레딧 기록)

---

## 결제 (Portone)

| 항목 | 기술 |
|------|------|
| PG | Toss Payments (KRW) / Stripe (USD) |
| 연동 | Portone V2 API |
| 웹훅 | Cloudflare Worker `/webhook/portone` |

---

## 린터 / 포맷터

별도 린터 없음. VSCode 기본 포맷 사용.

---

## 환경변수 (Cloudflare Workers Secrets)

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
PORTONE_SECRET_KEY
GEMINI_API_KEY          ← 크레딧 모드용 서버 측 키
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
LOG_SECRET
```
