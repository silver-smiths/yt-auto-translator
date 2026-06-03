# 모듈 08 — Service Worker v2

## 기능 설명
번역 오케스트레이션의 핵심. 설정의 translationMode에 따라 두 경로로 분기한다.

## 분기 로직

```
START_TRANSLATION 수신
  → settings.translationMode 확인
  → 'api_key' → runTranslationApiKey()   (v1 로직 그대로)
  → 'credits'  → runTranslationCredits() (v2 신규)
```

## API 키 경로 (runTranslationApiKey) — v1 동일

- YouTube 인증 → 자막 가져오기
- 1개 언어씩 순차 처리
- 50줄 청크 분할
- Gemini API 직접 호출 (사용자 API 키)
- 5초 간격 Rate Limit

## 크레딧 경로 (runTranslationCredits) — v2 신규

```
1. GET /credits → 잔액 확인 (0이면 에러 브로드캐스트 후 종료)
2. POST /translate/job → job_id 획득
3. YouTube 인증 → 자막 가져오기 (기존 youtube-api.js 재사용)
4. 언어 3개씩 병렬 처리:
   for chunk of languages (3개씩):
     await Promise.allSettled(
       chunk.map(lang =>
         translateOneLangCredit(lang, jobId, subtitles)
       )
     )
5. PATCH /translate/job/{jobId} {status: 'completed'} → 크레딧 정산
6. 잔여 크레딧 포함 TRANSLATION_COMPLETE 브로드캐스트
```

### translateOneLangCredit()
```
1. 전체 자막 → 프롬프트 구성
   (200줄 초과 시 500줄 청크 분할 — 서버에서도 처리하지만 클라이언트 안전망)
2. POST /translate/chunk → 번역 텍스트 획득
3. 번역 결과 파싱 (parseTranslatedLines 재사용)
4. YouTube Captions API 업로드
```

## 메시지 타입 추가

```js
// 크레딧 모드 완료 시 잔여 크레딧 포함
TRANSLATION_COMPLETE: {
  type: 'TRANSLATION_COMPLETE',
  count: 3,
  errors: [],
  creditsCharged: 0.0234,    // 이번 번역에 사용된 크레딧
  creditsRemaining: 12.39    // 차감 후 잔액
}
```

## 의존성
- lib/constants.js, lib/storage.js
- lib/llm-api.js (API 키 경로)
- lib/backend-api.js (크레딧 경로)
- lib/youtube-api.js (공통)
- lib/logger.js (공통)

## QA 기준
- [ ] API 키 모드: v1과 동일하게 번역 완료
- [ ] 크레딧 모드: 3개 언어 병렬 처리 확인
- [ ] 크레딧 모드: 번역 완료 후 크레딧 차감 확인
- [ ] 크레딧 잔액 0 → "크레딧이 부족합니다" 에러 브로드캐스트
- [ ] 중단(STOP) → 사용한 만큼만 차감 (PATCH status: 'stopped')
- [ ] 에러 발생 언어만 실패, 나머지 완료 처리
