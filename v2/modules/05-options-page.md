# 모듈 05 — 옵션 페이지 (options.html + options.js)

## 기능 설명
확장 프로그램 설정 페이지. v1 옵션 페이지를 v2 목업 기준으로 재구현.

## 관련 목업
design/mockup/02-options.html (전체)

## UI 구성 (목업 기준)

### 웰컴 카드 (최초 설치 시만)
- 3단계 스텝:
  - Step1 (모드 미선택): 기능 소개 + "크레딧 모드 시작" CTA
  - Step2 (크레딧 선택 후): 충전 안내 + "크레딧 충전" CTA
  - Step3 (API 키 선택 후): API 키 입력 안내
- chrome.storage에 `welcomeDismissed: true` 저장하면 이후 미표시

### 번역 방식 선택
- 라디오 버튼 2개: "내 API 키 사용" / "크레딧 사용"
- 선택에 따라 모드 패널 전환

### API 키 패널 (api_key 선택 시)
- Gemini API 키 입력 (password 타입, 눈 아이콘으로 토글)
- "API 키는 이 기기에만 저장" 안내 문구

### 크레딧 패널 (credits 선택 시)
- 크레딧 잔액 카드: `GET /credits` 호출 → "12.42 크레딧" 표시
- 충전 버튼 → silver-smiths.com/project/ytat-credits.html 새 탭 열기
- 잔액 0인 경우: "잔액 없음" 표시 + 충전 유도

### AI 모델
- API 키 모드: 드롭다운 (GEMINI_CONFIG.models)
- 크레딧 모드: "YTAT 추천 모델 (자동)" 고정 표시 (선택 불가)

### 번역 속도 (API 키 모드만 표시)
- v1 동일: 무료/유료 속도 선택

### 언어 설정
- 소스 언어 선택
- 번역 대상 언어 멀티 선택

### 저장 버튼
- chrome.storage.local에 설정 저장

## 의존성
- lib/constants.js (TRANSLATION_MODES, GEMINI_CONFIG)
- lib/storage.js (loadSettings, saveSettings)
- backend-api.js getCredits() (크레딧 잔액 조회)

## QA 기준
- [ ] 목업 UI와 시각적 일치
- [ ] 모드 전환 시 패널 즉시 교체
- [ ] 크레딧 잔액 정확 표시 (소수점 2자리)
- [ ] 충전 버튼 → 새 탭으로 결제 페이지 열림
- [ ] 저장 후 재진입 시 설정 유지
- [ ] 웰컴 카드 dismiss → 재진입 시 미표시
- [ ] 크레딧 모드에서 모델 드롭다운 숨김 처리
