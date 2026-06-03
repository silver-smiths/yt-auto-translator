# 모듈 02 — 백엔드 /translate/chunk (확정 스펙)

## 번역 처리 아키텍처

### Extension ↔ Worker 역할 분리
- **Extension**: 청크 분할, 병렬 호출 조율 (MAX_CONCURRENT=20)
- **Worker**: 단일 청크의 번역 + 폴백 + 토큰 추적

### 청크 크기 (언어 수 기반 동적)
| 언어 수 | 청크 크기 |
|--------|---------|
| 1~3개  | 150줄   |
| 4~8개  | 100줄   |
| 9~15개 | 80줄    |
| 16개+  | 60줄    |

### 출력 방식: JSON + 하이브리드 ID
- `response_mime_type: 'application/json'` 사용
- 입력에 `[ID]` 포함 → 응답 배열 길이 불일치 시 ID로 위치 복구
- 배열 길이 검증 후 누락 자리는 원본 텍스트로 채움

---

## API 스펙

### POST /translate/chunk
```
Authorization: Bearer <google_oauth_token>

Body:
{
  "job_id": "uuid",
  "subtitles": [{ "text": "안녕하세요" }, ...],  // 청크 단위
  "offset": 0,           // 전역 ID 계산용 (0-based)
  "target_langs": ["en", "ja", "zh"],
  "source_lang": "Korean",
  "model": "gemini-2.5-flash"  // 선호 모델, Worker가 폴백 결정
}

Response 200:
{
  "translations": {
    "en": ["Hello", "Today..."],
    "ja": ["こんにちは", "今日は..."]
  },
  "model_used": "gemini-2.5-flash-lite",  // 실제 처리 모델
  "tokens": { "input": 234, "output": 890 }
}

Error 402: 잔액 부족
Error 504: 모든 폴백 실패
```

---

## 폴백 체인

### v2 출시 (Gemini 내)
```
1순위: gemini-2.5-flash       timeout=90s
  ↓ 타임아웃 or 서버 오류
2순위: gemini-2.5-flash-lite  timeout=60s, 청크 절반 분할 동시 적용
  ↓ 타임아웃 or 서버 오류
3순위: gemini-2.0-flash       timeout=60s
  ↓ 전부 실패
원본 텍스트 유지 (번역 포기)
```

### v2.x (외부 프로바이더 추가)
```
4순위: gpt-4o-mini  (어댑터 인터페이스 준비됨, 키 미설정 시 skip)
```

---

## 처리 흐름 (Worker 내부)

```
POST /translate/chunk 수신
  ↓
인증 (Google OAuth 토큰 검증)
  ↓
job 소유권 확인 (user_id 일치)
  ↓
translateWithFallback(chunk, langs, model)
  ↓
  ┌─ 1순위 모델 시도 (90s timeout)
  │    ↓ 성공: JSON 파싱 → 길이 검증 → 누락 보정
  │    ↓ 실패: 청크 절반 분할 + 2순위 모델
  └─ 2/3순위 폴백 (60s timeout)
       ↓ JSON 파싱 실패 → [ID] Text 방식 폴백
       ↓ 전부 실패 → 원본 텍스트 유지
  ↓
Supabase increment_job_tokens() 호출
  ↓
{ translations, model_used, tokens } 반환
```

---

## QA 기준
- [ ] 정상 번역 → JSON 배열 길이 일치, 인덱스 매핑 정확
- [ ] 1순위 타임아웃 → 2순위로 자동 전환 (Extension 모름)
- [ ] JSON 파싱 실패 → [ID] Text 방식으로 자동 전환
- [ ] 배열 길이 불일치 → 원본 텍스트로 채움
- [ ] 전체 폴백 실패 → 504, Extension에서 해당 청크 원본 유지
- [ ] token 수 Supabase 누적 정확
- [ ] 타 사용자 job_id → 403
