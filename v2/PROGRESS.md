# YTAT v2 — 진행 현황

최종 업데이트: 2026-05-10

## 현재 단계: Phase 1 진행 중

---

## Phase 0: 기반 셋업

| 항목 | 상태 |
|------|------|
| 목업 — 사이드바 | ✅ design/mockup/01-sidebar.html |
| 목업 — 옵션 페이지 | ✅ design/mockup/02-options.html |
| DESCRIPTION.md | ✅ |
| ARCHITECTURE.md | ✅ |
| PLAN.md | ✅ |
| WORKFLOW.md | ✅ |
| STACK.md | ✅ |
| 모듈 스펙 파일 | ⬜ |
| v1 코드 → v2/dev/extension/ 복사 | ⬜ |

---

## Phase 1: 백엔드 API 서버

| 모듈 | 상태 |
|------|------|
| 01 — /credits 엔드포인트 | ✅ src/routes/credits.js |
| 02 — /translate/job + /chunk (폴백 포함) | ✅ src/routes/translate.js + lib/providers/ |
| 03 — /webhook/portone | ✅ src/routes/webhook.js |

## Phase 2: Extension 공통 기반

| 모듈 | 상태 |
|------|------|
| 04 — 설정 + 스토리지 | ⬜ |
| 05 — 옵션 페이지 | ⬜ |

## Phase 3: Extension 사이드바

| 모듈 | 상태 |
|------|------|
| 06 — 사이드바 UI | ⬜ |
| 07 — 로더 수정 | ⬜ |

## Phase 4: Extension Service Worker

| 모듈 | 상태 |
|------|------|
| 08 — Service Worker v2 | ⬜ |

## Phase 5: 통합 QA

| 항목 | 상태 |
|------|------|
| API 키 모드 E2E | ⬜ |
| 크레딧 모드 E2E | ⬜ |
| 잔액 부족 에러 처리 | ⬜ |
| 중단 처리 | ⬜ |
| 온보딩 동작 | ⬜ |

---

## 미결 사항

| 번호 | 내용 | 상태 |
|------|------|------|
| Q1 | Supabase URL + service_role 키 | ❓ |
| Q2 | Portone 시크릿 키 | ❓ |
| Q3 | 서버 측 Gemini API 키 | ❓ |
| Q4 | 전체 자막 토큰 한도 초과 대응 방안 | ❓ |
| Q5 | v2 Extension ID (v1 업데이트 vs 신규) | ❓ |
