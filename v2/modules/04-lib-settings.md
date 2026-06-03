# 모듈 04 — lib/constants.js + lib/storage.js (v2 업데이트)

## 기능 설명
v1의 상수 및 스토리지를 v2에 맞게 확장.
핵심 변경: `translationMode` 설정 추가, 크레딧 모드 기본값 정의.

## 변경 내용

### constants.js 추가 사항
```js
// 번역 모드
export const TRANSLATION_MODES = {
  API_KEY: 'api_key',
  CREDITS: 'credits'
};

// v2 기본 설정
export const DEFAULT_SETTINGS = {
  ...기존 v1 설정...,
  translationMode: 'api_key',  // 추가
};

// API Base URL
export const API_BASE = 'https://yt-auto-translator-api.1009yjh.workers.dev';
```

### storage.js 변경 없음
기존 loadSettings / saveSettings 그대로 사용.

## QA 기준
- [ ] DEFAULT_SETTINGS에 translationMode: 'api_key' 포함
- [ ] 기존 v1 사용자 설정 로드 시 translationMode 기본값 폴백 정상
