# YTAT v2 — 아키텍처

## 전체 구조

```
┌─────────────────────────────────────────────────────────┐
│                 Chrome Extension (v2)                    │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐  │
│  │   Options    │    │  YouTube Studio (content)     │  │
│  │   Page       │    │                               │  │
│  │  - 모드 선택  │    │  ┌─────────────────────────┐ │  │
│  │  - API 키    │    │  │      사이드바 UI          │ │  │
│  │  - 크레딧 잔액│    │  │  - 접기/펼치기 탭        │ │  │
│  │  - 충전 버튼  │    │  │  - 모드 스트립           │ │  │
│  └──────┬───────┘    │  │  - 번역 시작/중지        │ │  │
│         │            │  │  - 로그 카드 피드         │ │  │
│         │            │  └──────────┬────────────────┘ │  │
│         │            └─────────────┼────────────────┘  │
│         │                         │                     │
│         └─────────┬───────────────┘                     │
│                   ▼                                     │
│          ┌────────────────┐                             │
│          │ Service Worker │                             │
│          │  - 모드 분기    │                             │
│          │  - API 키 모드  │──→ Gemini API (직접)       │
│          │  - 크레딧 모드  │──→ Cloudflare Worker API   │
│          └────────────────┘                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│            Cloudflare Workers API                        │
│                                                         │
│  POST /translate/chunk ──→ Gemini API (서버 키)         │
│  GET  /credits         ──→ Supabase                     │
│  POST /translate/job   ──→ Supabase                     │
│  POST /webhook/portone ──→ Portone 검증 → Supabase      │
└─────────────────────────────────────────────────────────┘

┌────────────┐    ┌────────────┐    ┌────────────────────┐
│  Supabase  │    │  Portone   │    │  silver-smiths.com │
│  (DB+Auth) │    │  (결제)    │    │  (결제 페이지)     │
└────────────┘    └────────────┘    └────────────────────┘
```

---

## 번역 흐름 비교

### API 키 모드 (무료)

```
사이드바 [번역 시작]
  → Service Worker
    → YouTube Captions API (자막 가져오기)
    → for each 언어 (순차):
        → Gemini API (50줄 청크씩, 5초 간격)
        → YouTube Captions API (업로드)
  → 사이드바 [완료]
```

### 크레딧 모드 (유료)

```
사이드바 [번역 시작]
  → Service Worker
    → Cloudflare Worker /credits (잔액 확인)
    → Cloudflare Worker /translate/job (작업 생성)
    → YouTube Captions API (자막 가져오기)
    → 언어 3개씩 병렬:
        → Cloudflare Worker /translate/chunk (전체 자막, 빠른 속도)
          → 내부: Gemini API (서버 키, 유료 RPM)
          → 내부: Supabase increment_job_tokens()
        → YouTube Captions API (업로드)
    → Cloudflare Worker deduct_credits() (완료 후 정산)
  → 사이드바 [완료 + 차감된 크레딧 표시]
```

---

## 크레딧 흐름

```
결제 페이지 (silver-smiths.com)
  → Portone 결제
  → Portone 웹훅 → Cloudflare Worker /webhook/portone
      → 검증 (Portone API)
      → Supabase grant_credits() 호출
      → 크레딧 즉시 지급

Extension 사용
  → /translate/chunk 완료마다 increment_job_tokens() 누적
  → 번역 완료 후 deduct_credits() 일괄 차감
  → credit_accounts.balance 업데이트
```

---

## 크레딧 단위 정의

- 1 크레딧 = $1 USD = ₩1,400 (고정 환율)
- `credit_accounts.balance`: USD 단위 숫자 (e.g. 12.420000)
- 사용자 표시: 소수점 2자리 크레딧 (e.g. "12.42 크레딧")
- 크레딧 차감 = `api_cost_usd × tier_multiplier`
  - light (누적 $0~30): ×1.3
  - standard (누적 $30~100): ×1.2
  - heavy (누적 $100+): ×1.1

---

## Extension 파일 구조 (v2/dev/extension)

```
manifest.json
assets/icons/
_locales/
src/
  background/
    service-worker.js       ← 모드 분기 + 번역 오케스트레이션
  content/
    loader.js               ← 사이드바 마운트 트리거
    sidebar.js              ← 사이드바 UI 로직
    sidebar.css
  options/
    options.html
    options.js
  lib/
    constants.js            ← 언어 목록, 설정 기본값
    storage.js              ← chrome.storage 래퍼
    youtube-api.js          ← YouTube Captions API
    llm-api.js              ← API 키 모드 Gemini 직접 호출
    backend-api.js          ← 크레딧 모드 Cloudflare Worker 호출
    logger.js               ← 에러 리포팅 + 텔레그램
```

---

## Backend 파일 구조 (v2/dev/backend)

```
wrangler.toml
src/
  index.js                  ← 라우터 (fetch handler)
  routes/
    credits.js              ← GET /credits
    translate.js            ← POST /translate/job, /chunk
    webhook.js              ← POST /webhook/portone
  lib/
    auth.js                 ← Google OAuth 토큰 검증
    supabase.js             ← Supabase 클라이언트
    gemini.js               ← Gemini API 호출 (서버 키)
    portone.js              ← Portone 결제 검증
```

---

## 인증 흐름

크레딧 모드에서 사용자 식별:
1. Extension: `chrome.identity.getAuthToken()` → Google OAuth 토큰 획득
2. API 요청: `Authorization: Bearer <google_token>` 헤더 전송
3. Worker: Google tokeninfo API로 토큰 검증 → `google_id` 추출
4. Supabase: `users` 테이블에서 google_id로 사용자 조회/생성

---

## v1 → v2 변경 사항 요약

| 항목 | v1 | v2 |
|------|----|----|
| UI 진입점 | Popup | 사이드바 (content script inject) |
| 번역 모드 | API 키만 | API 키 + 크레딧 |
| 청크 처리 | 항상 50줄씩 | API 키: 50줄씩 / 크레딧: 전체 |
| 병렬 언어 수 | 3개 | API 키: 1개 / 크레딧: 3개 |
| 백엔드 역할 | 에러 로그 중계만 | 크레딧 관리 + Gemini 프록시 |
| 온보딩 | 없음 | 웰컴 카드 + 단계별 안내 |
