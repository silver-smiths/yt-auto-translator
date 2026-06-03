# 모듈 01 — 백엔드 /credits 엔드포인트

## 기능 설명
Extension이 크레딧 모드로 진입하거나 옵션 페이지를 열 때 호출.
Google OAuth 토큰으로 사용자를 식별하고 크레딧 잔액·티어를 반환한다.
신규 사용자는 최초 호출 시 DB에 자동 생성된다.

## 관련 목업
- design/mockup/02-options.html → 크레딧 패널 (.credit-balance-card)
- design/mockup/01-sidebar.html → B. 크레딧 모드 사이드바 (.s-mode-strip.credits)

## API 스펙

### GET /credits
```
Authorization: Bearer <google_oauth_token>

Response 200:
{
  "credits": 12.42,        // 표시용 (소수점 2자리)
  "tier": "light",         // "light" | "standard" | "heavy"
  "multiplier": 1.3        // 차감 배율
}

Error 401: 토큰 없음 / 검증 실패
Error 500: DB 오류
```

## 처리 흐름
1. Authorization 헤더에서 Google OAuth 토큰 추출
2. Google tokeninfo API로 토큰 검증 → email, sub(google_id) 획득
3. Supabase users 테이블 upsert (google_id 기준)
4. credit_accounts 조회 (없으면 balance=0, tier='light'으로 INSERT)
5. `{ credits: balance, tier, multiplier }` 반환

## 의존성
- Cloudflare Worker (index.js 라우터)
- Supabase: users, credit_accounts 테이블
- Google OAuth tokeninfo API

## 입출력 스펙
- 입력: Google OAuth Bearer 토큰 (Authorization 헤더)
- 출력: credits(숫자), tier(문자열), multiplier(숫자)

## QA 기준
- [ ] 유효 토큰 → 200 + 잔액 정확
- [ ] 무효 토큰 → 401
- [ ] 신규 사용자 → users + credit_accounts 자동 생성, credits=0
- [ ] 기존 사용자 → 기존 잔액 그대로 반환
