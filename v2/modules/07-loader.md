# 모듈 07 — 콘텐츠 스크립트 로더 (content/loader.js)

## 기능 설명
YouTube Studio 페이지에서 사이드바를 마운트하는 진입점.
v1의 loader.js를 사이드바 방식으로 수정.

## 변경 내용
- v1: content-script.js 동적 로드 (팝업과 연동)
- v2: sidebar.js 동적 로드 + DOM 감시 (SPA 네비게이션 대응)

## 처리 흐름
1. YouTube Studio URL 패턴 확인 (`/video/*/edit`)
2. `#ytat-sidebar-root` 이미 존재하면 skip
3. sidebar.js + sidebar.css를 페이지에 inject
4. MutationObserver로 SPA 라우팅 감지 → 페이지 전환 후에도 사이드바 유지

## QA 기준
- [ ] YouTube Studio 최초 진입 시 사이드바 삽입
- [ ] 다른 영상으로 이동 시 사이드바 유지 (중복 삽입 없음)
- [ ] YouTube Studio 외 페이지에서는 미삽입
