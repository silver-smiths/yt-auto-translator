# YTAT v2 — 개발 계획

## 개발 순서 (MUB 파이프라인)

목업 → 모듈 스펙 → 모듈별 개발 → 단위 QA → 연결 → 통합 QA

---

## Phase 0: 기반 셋업 ✅ (문서 작성 완료)

- [x] DESCRIPTION.md
- [x] ARCHITECTURE.md
- [x] PLAN.md (이 파일)
- [x] WORKFLOW.md
- [x] STACK.md
- [x] 목업 → design/mockup/ 이동
- [ ] 모듈 스펙 파일 작성 (modules/)
- [ ] v1 코드 → v2/dev/extension/ 복사 (기반)

---

## Phase 1: 백엔드 API 서버 (Cloudflare Worker)

> **왜 먼저?** Extension은 크레딧 모드 테스트를 위해 백엔드가 필요함.
> 현재 `yt-auto-translator-api.1009yjh.workers.dev`는 에러 로그 Worker만 배포됨.

### 모듈 01 — `/credits` 엔드포인트
- Google OAuth 토큰 검증
- Supabase users 테이블 upsert (최초 접속 시 계정 생성)
- credit_accounts 잔액 + 티어 반환
- 검증: 잔액 정확히 반환, 신규 사용자 0 크레딧 생성

### 모듈 02 — `/translate/job` + `/translate/chunk`
- job 생성 (pending → running)
- chunk 번역: Gemini API 서버 키로 호출 (전체 자막, 빠른 속도)
- increment_job_tokens() RPC 호출 (청크 완료마다)
- 번역 완료 후 deduct_credits() 정산
- 검증: 토큰 카운트 정확, 크레딧 차감 일치

### 모듈 03 — `/webhook/portone`
- Portone 서명 검증
- 결제 완료(paid) 이벤트 → grant_credits() 호출
- 중복 웹훅 방지 (portone_id unique 활용)
- 검증: 중복 호출 무시, 금액 정확 지급

---

## Phase 2: Extension — 공통 기반

### 모듈 04 — 설정 + 스토리지 (lib/constants.js, lib/storage.js)
- v2 설정 구조 정의 (translationMode: 'api_key' | 'credits' 추가)
- 크레딧 모드 기본값 추가
- 검증: loadSettings() 기본값 정확

### 모듈 05 — 옵션 페이지 (options.html + options.js)
- 번역 방식 선택 (API 키 / 크레딧)
- 모드별 패널 전환 (API 키 입력 vs 크레딧 잔액)
- 크레딧 충전 버튼 → silver-smiths.com 연결
- 언어 선택, 소스 언어, 모델 선택 (목업 기준)
- 검증: 목업 UI와 1:1 일치, 저장 정상

---

## Phase 3: Extension — 사이드바

### 모듈 06 — 사이드바 UI (content/sidebar.js + sidebar.css)
- YouTube Studio 사이드바 injection (접기/펼치기 탭 포함)
- 목업 상태별 렌더링:
  - 최초 설치: 온보딩 카드 4종
  - A. API 키 대기 / B. 크레딧 대기
  - 번역 중 (진행 로그 카드)
  - 완료 / 에러
- chrome.runtime 메시지 수신 → 로그 카드 동적 추가
- 검증: 목업과 시각적 일치, 접기/펼치기 동작

### 모듈 07 — 로더 (content/loader.js 수정)
- 팝업 방식 제거, 사이드바 inject로 대체
- 검증: YouTube Studio 진입 시 사이드바 자동 표시

---

## Phase 4: Extension — Service Worker

### 모듈 08 — Service Worker v2
- 모드 분기: settings.translationMode에 따라 API 키 or 크레딧 경로 선택
- **API 키 경로**: v1 로직 그대로 (1언어씩, 50줄 청크, 5초 간격)
- **크레딧 경로**:
  - /credits 호출 → 잔액 확인
  - /translate/job 생성
  - 자막 전체 + 3개 언어 병렬 + 빠른 속도
- 진행 메시지 broadcast → 사이드바 수신
- 검증: 두 모드 모두 번역 완료, 크레딧 차감 확인

---

## Phase 5: 통합 QA

- [ ] API 키 모드 End-to-End (YouTube Studio → 자막 업로드)
- [ ] 크레딧 모드 End-to-End (잔액 확인 → 번역 → 차감)
- [ ] 잔액 부족 에러 처리
- [ ] 중단(stop) 동작
- [ ] 온보딩 카드 dismiss 및 재표시 안 됨 확인
- [ ] 설정 페이지 저장/로드 정합성
- [ ] 크레딧 충전 후 잔액 반영 확인

---

## 미결 사항 (개발 전 확인 필요)

| 번호 | 내용 | 우선순위 |
|------|------|---------|
| Q1 | Supabase 프로젝트 URL + service_role 키 확인 필요 | Phase 1 전 |
| Q2 | Portone 가맹점 시크릿 키 확인 필요 | 모듈 03 전 |
| Q3 | 크레딧 모드에서 사용할 서버 측 Gemini API 키 | Phase 1 전 |
| Q4 | 전체 자막 한번에 처리 시 Gemini 토큰 한도 초과 대응 방안 | 모듈 02 |
| Q5 | v2 Extension ID — v1과 동일(업데이트)? 신규? | Phase 2 전 |
