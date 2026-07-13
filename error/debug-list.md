# YTAT 디버깅 목록

최종 점검일: 2026-07-12 (시나리오/UX/코드리뷰 3종 최종 검증)

---

## 🔒 2026-07-12 보안 전면 점검 결과

**핵심 방어는 견고 (✅ 확인):** aud 검증(다른 앱 토큰 차단), 서버측 admin 강제(admin_accounts 조회 — 버튼 숨김은 장식), Portone 재검증(위조 지급 불가), 릴레이 화이트리스트, 크레딧/결제 위조 경로 없음, 시크릿 클라이언트 미노출, CORS/SQL인젝션 안전.

**🔴 R1 (오픈 전 개선 권장) — OAuth force-ssl 토큰을 웹페이지에 위임:** silver-smiths.com 페이지가 `YTAT_GET_AUTH_TOKEN`으로 youtube.force-ssl 스코프 토큰을 받아감. 관리자 페이지는 sessionStorage 저장, 결제 페이지는 관리자 버튼 노출용. 결제·관리자 페이지의 3rd-party 스크립트(GTM/Portone/Chart.js CDN) 침해나 XSS 시 → 사용자 YouTube 계정 탈취 가능. origin 검증(silver-smiths.com 한정)은 있으나 "그 origin 자체"가 표면.
- 완화안 (선택 필요): ① 결제 페이지에서 토큰 요청 제거(관리자 버튼 삭제) → 일반 사용자 경로 노출 원천 차단 ② 관리자 페이지는 백엔드 단기 세션ID 교환으로 force-ssl 토큰 웹 노출 제거 ③ Chart.js 등 CDN 자체 호스팅

**🟡 R2 레이트리밋 부재** (오픈 후) — aud 검증으로 무차별은 차단되나 정상 사용자 남용/DoS 방어 없음. Cloudflare Rate Limiting 권장.
**🟡 R4 host_permissions 과도** (오픈 후) — `generativelanguage.googleapis.com/*`는 API키 모드 잔재(익스텐션이 Gemini 직접 호출 안 함). 제거 권장.
**🟢 R5/R6** — ytat-admin 이메일·sidebar addLog 미이스케이프 (self-XSS 수준, 방어적 이스케이프 권장).

---

## ✅ 2026-07-12 일괄 수정 완료 (커밋 f16e46f, 6c60856 / Workers·Vercel 배포)

F1, F2, F3, F4, F5, F6, F10, F12, F13, F14, F15, SB-2 — 아래 목록의 해당 항목 전부 수정·배포됨.
검증: 전 파일 문법/번들 통과, 릴레이 실번역 재확인, 악의적 base 차단 유지.

**미수정 잔여 (정책·구조 판단 필요):**
- deduct 동시 PATCH 레이스 (SQL 멱등성 — 단일 사용자 자기손해, 낮음)
- R1 보안 (OAuth 토큰 웹 위임): A(결제페이지 토큰요청 제거)는 오픈전 권장 — 미처리

**✅ 2026-07-12 추가 완료:**
- F7 → 제목/설명 이미 등록 언어 건너뛰기 (getVideoLocalizations 필터, 정책: 건너뛰기 확정)
- F8 → 자막 OFF면 다운로드 스킵 + 원본언어 영상메타 대체 (API 절약)
- F9 → 이력 SW 저장 (탭 닫혀도 유지)
- F11 → 크레딧 만료 없음 + 환불 3개월·PG정책 문구로 통일 (결제 페이지)
- 환율 → 1350 통일 (원화 1:1 크레딧 전환으로 근본 해소)
- **원화 크레딧 전환** → USD 표기·환율 개념 제거, 정수 크레딧 표시

---

## 🔴 2026-07-12 최종 검증 발견 (수정 이력 — 위 완료 섹션 참조)

### F1. 크레딧 차감 RPC 에러 은폐 → 무과금 (매출 직결) — 직접 검증 완료

- **위치:** `backend/src/routes/translate.js:346~360` (PATCH /job), 동일 패턴 `:255` (increment_job_tokens)
- **문제:** supabase-js `.rpc()`는 실패해도 throw하지 않고 `{error}`를 반환 — try/catch가 무의미. `deduct_credits`가 실패해도 `deducted_at`이 기록돼 해당 번역이 **영구 무과금**
- **수정 방향:** `const { error } = await sb.rpc(...)` 후 error면 deducted_at 기록하지 않음 (웹훅 grant/refund와 동일 패턴으로)

## 🟡 2026-07-12 발견 (미수정)

| # | 내용 | 위치 |
|---|------|------|
| F2 | 업로드 전부 성공 후 job PATCH 실패 시 "전체 실패"로 오보고 + 성공 이력 유실 | service-worker.js:538 (try 블록 안) |
| F3 | 쿼터 초과 전용 안내("내일 무료 자동 등록") 도달 불가 — youtube-api가 한국어로 throw하는데 매칭 토큰이 영어 | youtube-api.js:74 ↔ service-worker.js getUploadErrorMessage |
| F4 | 청크 진행 메시지가 매번 로그 카드로 쌓임 (isChunkUpdate 미송신 — 크레딧 모드 회귀) + 언어 칩이 번역 단계 내내 빈 상태 (targetLangs 미송신) | service-worker.js broadcast ↔ sidebar 필터 |
| F5 | fatal 실패/allSkipped 이력 카드 제목이 항상 "영상" (videoId/videoTitle 미탑재) | service-worker.js:316, :597 |
| F6 | 번역 실행 중 설정 저장 시 변경 영구 유실 (isRunning 가드가 재적용 없이 버림) | sidebar.js storage.onChanged |
| F7 | 반복 실행마다 제목/설명 재번역·재과금 (기등록 여부 무관, targetLangs 무필터) | service-worker.js 메타데이터 호출부 |
| F8 | 자막 OFF(제목/설명만)여도 원본 자막 없으면 전체 실패 | prepareSubtitles 무조건 실행 |
| F9 | 번역 중 탭 닫으면 완료 이력·차감 내역 표시 유실 (이력 저장이 사이드바 수신 측에만 존재) — 구조적 | sidebar.js 이력 시스템 |
| F10 | startTranslation이 SW 거부 응답("이미 진행 중") 무시 — 두 번째 탭에서 무반응 | sidebar.js startTranslation |
| F11 | 카피 모순: 사이드바(데드 패널) "만료되지 않습니다" vs 결제 페이지 "3개월 자동 소멸" + 백엔드 만료 로직 미구현 — 법무 검토 필요 | sidebar.js ↔ ytat-credits.html |
| F12 | 막다른 오류 문구 3건 (API 키 재확인/모드 전환/앱 로그 — 존재하지 않는 UI 안내) | service-worker.js friendlyError |
| F13 | 계좌송금 버튼 초기 라벨 ₩20,000 하드코딩 (로드 시 updateAll 미호출) + formsubmit 제출 후 외부 페이지 이탈 | ytat-credits.html |
| F14 | 중지 버튼 클릭 시 즉시 피드백 없음 (배치 종료까지 무반응) | sidebar.js / SW |
| F15 | 시작 전 예상 차감액 미표시 (estCostPerLang 계산값 미노출) | service-worker.js |

## ❎ 검증 과정에서 기각된 오보

- ~~웹훅이 이메일로 사용자 매칭 → 지급 실패~~ → 실제로는 merchant_uid(portone_id) 매칭. buyer_email 공백 무해
- ~~환율 불일치 해소됨~~ → 여전히 페이지 1,400 vs 백엔드 1,350 (사장님 보류 지시 항목)
- perLang/creditsUsed/릴레이 화이트리스트 — 마지막 3건 수정의 회귀 없음 확인

---

## 🔴 심각 (미수정 — 설계 결정 필요)

### R3. `service-worker.js` — 외부 웹페이지에 YouTube 전체 권한 OAuth 토큰 전달

- **문제:** `YTAT_GET_AUTH_TOKEN` 메시지로 silver-smiths.com 페이지에 `youtube.force-ssl` 스코프 토큰 원본 반환
- **완화 장치 존재:** `sender.origin` 검증 + manifest `externally_connectable`이 silver-smiths.com으로 제한됨
- **잔여 리스크:** 해당 사이트에 XSS가 있으면 사용자 채널 전체 탈취 가능
- **수정 방향:** 토큰 대신 백엔드 발급 단기 세션 ID 전달 — 백엔드 세션 교환 엔드포인트 신설 필요 (설계 결정 대기)

---

## 🟡 미수정 (낮은 우선순위)

### Y-a. PATCH /job 동시 호출 시 이중 차감 레이스 (추정) — `translate.js`

- `deducted_at` 멱등성이 read-then-write 패턴. `deduct_credits` RPC 내부에 자체 가드가 있는지 확인 필요 — 있다면 무해

### Y-b. webhook 통화(currency) 미대조 — `webhook.js:61`

- 금액만 비교하고 통화를 대조하지 않음. Portone 응답의 통화 단위 정책 확인 후 판단

### Y-c. 공지 뱃지 1페이지만 검사 / 상세에 날짜 미표시 / 재오픈 시 1페이지 리셋 (UX, 경미)

### Y-d. 에러 알림 rate limit/dedup 없음 + API 키 모드 언어 실패 시 이중 알림 (운영, 경미)

### 🔴 Supabase에서 재실행 필요 (2026-07-09 재리뷰 발견)

- **grant_credits RPC 스키마 불일치** — 이전에 실행한 SQL이 생성은 됐지만 런타임에서 반드시 실패하는 상태였음 (`type='purchase'` 제약 위반, `balance_before` 누락, `cumulative_paid` 컬럼 없음). **수정된 `backend/migrations/001_atomic_grant_credits.sql`을 Supabase SQL Editor에서 재실행할 것.** 실행 전까지 결제 시 크레딧 지급이 실패함
- (함께 수정됨) 크레딧 모드 메타데이터 job_type `'metadata'` → `'title_desc'` — 스키마 check 제약 위반으로 job 생성이 500이었음 (service-worker.js)

### 🟡 트레이드오프 (의도적 결정)

- 품질 검증 threshold(20%·최소 2줄)는 **1~2줄짜리 메타데이터 청크에서는 게이트가 사실상 비활성** — 대신 고유명사 제목("MrBeast" 등)이 폴백을 태우는 오탐을 방지. 메타데이터 별도 기준은 필요 시 후속 검토

### 📌 기능 개선 백로그

- ~~환불 프로세스 미구현~~ → **(2026-07-11 구현 완료)** Portone 콘솔에서 결제취소하면 취소 웹훅이 자동으로 크레딧 회수 + refunded 처리 + 텔레그램 💸 알림. 부분취소는 미지원(전액취소만) — refund_credits RPC(migrations/003) 실행 필요
- 잔액 마이너스 상태 UI 안내 ("다음 충전 시 차감됩니다") 미구현

### ⚠️ 확인 필요 (코드 아님 — 운영 대조)

- `logger.js:15` `LOG_SECRET='YT_TRANSLATOR_SECRET'`이 배포된 로거 워커 env와 일치하는지 — 불일치 시 모든 에러 알림 무음 실패. **최근 텔레그램으로 에러를 실제 수신 중이면 정상**
- 로거 워커(`v1/cloudflare-worker/worker.js`) 수정분(마크다운 이스케이프)은 **재배포 필요** (`wrangler deploy`)
- 백엔드 수정분(Cloudflare Workers) **재배포 필요**
- `wrangler.toml`에 `TELEGRAM_THREAD_ID` 미문서화

---

## 🟢 경미 (참고)

- `content-script.js`(611줄)는 데드코드 — loader가 sidebar.js만 로드. 제거 권장
- 3개 번역 대상 체크박스 전부 해제 저장 가능 → 아무것도 안 하면서 "완료 ✓" 표시. options에서 최소 1개 강제 권장
- 크레딧 모드 메타데이터가 `settings.targetLangs` 미필터 사용 → 원본 언어 포함 번역 (크레딧 소폭 낭비)
- `RATE_CONFIGS`에 free만 존재 — paid 키는 항상 free로 폴백 (관련 UI도 없음, 죽은 경로)
- 공지 뱃지가 1페이지만 검사 → 11번째 이후 미읽음 공지는 뱃지 안 뜸 (드묾)
- 공지 상세에 날짜/타입 미표시 (UX 갭)
- 익스텐션 에러 알림에 rate limit/dedup 없음 + API 키 모드 이중 알림 (언어 실패 시 N+1건)
- `wrangler.toml`에 `TELEGRAM_THREAD_ID` 미문서화
- auth.js upsert가 매 요청 UPDATE 실행 (ignoreDuplicates 제거 여파, 기능 무해)

---

## ✅ 텔레그램/공지 점검에서 정상 확인된 것

- 에러 알림 경로 설계 견고: keepalive + 8s 타임아웃 + 2회 재시도, 인증 실패 상황에서도 보고 가능 (별도 워커라 auth 무관)
- 결제 텔레그램 알림(webhook.js): 이스케이프/실패 처리 정상, 알림 실패가 결제에 영향 없음
- 공지 API 계약(응답 형식·페이지네이션) 익스텐션과 일치, 본문 렌더링 textContent로 XSS 안전
- manifest 권한과 실제 fetch 대상 일치
- heartbeat setInterval 자가 정리 정상 (메모리 누수 없음)

---

## ❎ 재검증 후 문제 아님으로 판정 (2026-07-09)

### ~~크레딧 모드 source_lang 타입 불일치~~ (`service-worker.js:520`)

- `trackInfo.language`("ko")는 `/translate/job` DB 기록용 — 프롬프트 미사용. 실제 프롬프트는 `sourceLangName` 전달 → 영향 없음

### ~~split 재시도 시 undefined spread~~ (`translate.js:173`)

- `validateAndRepair`가 모든 targetLang 키에 배열 보장 + failed 가드로 보호 → 크래시 경로 없음

---

## ✅ 수정 완료 항목

| 항목 | 파일 | 내용 |
|------|------|------|
| translateSubtitles: false 미처리 | service-worker.js | API 키/크레딧 모드 양쪽에 guard 추가 |
| settings.targetLangs undefined | service-worker.js | `\|\| []` 방어 코드 추가 |
| source language 필터 우회 | service-worker.js | normalizeLangCode 필터 적용 |
| 에러 객체 프로퍼티명 불일치 | service-worker.js | `error` → `message` 통일 |
| 메타데이터 인덱싱 불명확 | service-worker.js | `translated` 변수로 분리 후 idx 접근 |
| 제목/설명 번역 누락 시 빈 값 업로드 (2026-07-09) | service-worker.js | 누락 필드는 localizations 업로드에서 제외 — 크레딧/API 키 모드 모두 |
| ignoreDuplicates 모순 | auth.js | 옵션 제거 |
| users 쿼리 에러 미체크 | admin.js | usersError 체크 추가 |
| Portone 토큰/검증 res.ok | webhook.js | null 체크 및 502 반환 추가 |
| GOOGLE_CLIENT_ID 미설정 | auth.js | 500 반환 및 aud 검증 추가 |
| 상수 중복 선언 | translate.js, credits.js, admin.js, webhook.js | lib/constants.js로 통합 |
| **(2026-07-09 일괄 수정)** | | |
| /notices 라우터 미마운트 (공지 전체 404) | index.js | `app.route('/notices', noticesRouter)` 추가 |
| 크레딧 차감 우회 (완료 job 재사용·잔액소진 무한호출) | translate.js | chunk에 status/deducted_at 검사(409) + 누적요금 반영 잔액검사 + PATCH status 화이트리스트 |
| webhook grant_credits 무력화 (status 선변경 → RPC 조기반환 → 크레딧 미지급) | webhook.js | RPC 먼저 호출 + 에러 시 500(재시도 유도), credits_granted는 성공 후 기록 |
| 품질 검증 과민 (1줄 동일 → 폴백 3~4배 과금) | translate.js | 20% 이상·최소 2줄일 때만 quality 실패 처리 |
| 폴백 전체 실패 시 원본 배열 낭비 생성 | translate.js | translations: null 반환으로 정리 |
| sidebar 메시지 필드 불일치 6건 (로그/오류/칩/allSkipped) | sidebar.js | langName·error·lang 필드로 수정, allSkipped 분기 추가, 진행 라벨 라이브 표시 |
| sidebar 리스너 재마운트 중복 등록 | sidebar.js | 기존 핸들러 removeListener 후 재등록 |
| 크레딧 모드 중지 시 번역 결과 유실 | service-worker.js | 미시도 언어도 uploadFailed에 포함해 캐시 저장 |
| 캐시 복원 인덱스 불일치 | service-worker.js | 원본 자막 개수 일치하는 캐시만 복원 |
| 메타데이터 전체 실패 침묵 | service-worker.js | 실패 시 사용자 안내 broadcast 추가 |
| backend-api 401 미복구 + 오도 메시지 | backend-api.js, service-worker.js | authFetch 토큰 갱신 재시도 + friendlyError에 백엔드 실패 분기 추가 |
| 텔레그램 마크다운 이스케이프 부재 (알림 유실) | v1/cloudflare-worker/worker.js | escapeMd 적용 (⚠️ 워커 재배포 필요) |
| 관리자 초안 공지 열람 불가 | notices.js, ytat-admin.html | GET /notices/admin/:id 신설 + admin 페이지 호출 변경 |
| 공지 제목 XSS | options.js, ytat-admin.html | escapeHtml 적용 |
