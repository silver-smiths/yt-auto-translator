# 모듈 06 — 사이드바 UI (content/sidebar.js + sidebar.css)

## 기능 설명
YouTube Studio 영상 편집 페이지 우측에 삽입되는 사이드바 UI.
v1의 팝업 방식을 완전 대체한다.

## 관련 목업
design/mockup/01-sidebar.html (전체 — 7가지 상태 확인)

## 상태 목록 (목업 기준)

| 상태 | 설명 |
|------|------|
| 최초 설치 | 온보딩 카드 4종 표시 |
| 0. 접힌 상태 | 우측에 탭 버튼만 표시 |
| A. API 키 대기 | 번역 시작 버튼 활성, 모드 스트립: "내 API 키" |
| B. 크레딧 대기 | 번역 시작 버튼, 모드 스트립: 잔여 크레딧 수량 |
| C. 번역 중 | 진행 로그 카드, 번역 언어·청크 진행률 |
| D. 완료 | 성공/실패 요약 카드 |
| E. 에러 | 에러 메시지 카드 |

## DOM 삽입 방식
```
YouTube Studio 페이지에 #ytat-sidebar-root div 추가
→ Shadow DOM 사용 (YouTube CSS 충돌 방지)
→ sidebar.css는 Shadow DOM 내부에 주입
```

## 주요 UI 요소

### 헤더
- 로고 + "YouTube 번역 AI" 텍스트
- 닫기(×) 버튼 → 접힌 상태로 전환

### 모드 스트립 (항상 표시, 38px 고정 높이)
- API 키 모드: 회색 점 + "내 API 키" 레이블
- 크레딧 모드: 색상 점 + "X.XX 크레딧" 수량 표시

### 번역 시작/중지 버튼
- 대기 중: "▶ 번역 시작"
- 번역 중: "■ 중지"

### 로그 카드 피드
- 온보딩 카드 (최초 설치, 개별 dismiss 가능)
- 진행 로그 카드 (실시간 append)
- 완료/에러 카드

### 접기/펼치기 탭
- 접힌 상태: 우측 끝에 36×44px 버튼 (로고 아이콘)
- 펼친 상태: 260px 사이드바 표시

### 하단 설정 버튼
- "⚙️ 설정" → chrome.runtime.openOptionsPage()

## 메시지 수신 (Service Worker → 사이드바)
```js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSLATION_PROGRESS') → 진행 카드 업데이트
  if (msg.type === 'TRANSLATION_COMPLETE') → 완료 카드 추가
  if (msg.type === 'TRANSLATION_ERROR')    → 에러 카드 추가
})
```

## 의존성
- lib/constants.js (MSG 타입)
- lib/storage.js (설정 로드 — 모드 확인)
- backend-api.js (크레딧 잔액 표시용 getCredits())
- Service Worker 메시지 API

## QA 기준
- [ ] YouTube Studio 진입 시 자동 삽입
- [ ] 목업 7가지 상태 시각적 일치
- [ ] 접기/펼치기 동작 정상
- [ ] 온보딩 카드 개별 dismiss + 새로고침 후 미표시
- [ ] 번역 중 로그 카드 실시간 추가
- [ ] 크레딧 모드 → 모드 스트립에 크레딧 수량 표시
- [ ] YouTube CSS와 충돌 없음 (Shadow DOM 격리)
