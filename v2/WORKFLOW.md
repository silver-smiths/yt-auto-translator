# YTAT v2 — 워크플로우

## 브랜치 전략

- `main` — 배포 가능 상태 (v1 유지)
- `v2/dev` — v2 개발 통합 브랜치
- `v2/module-{이름}` — 모듈별 작업 브랜치

## 커밋 규칙

```
type(scope): description

type: feat · fix · docs · style · refactor · test · chore
scope: backend · sidebar · options · sw · lib · infra
```

예시:
```
feat(backend): add /credits endpoint with Google auth
feat(sidebar): inject sidebar into YouTube Studio
fix(sw): handle credit mode stop signal
```

---

## 개발 → QA 체크리스트

### 모듈 단위 QA (REDTEAM 기준)

**기능 동작**
- [ ] 정상 시나리오 동작 확인
- [ ] 에러 시나리오 처리 확인 (잔액 부족, 네트워크 오류, 인증 실패)
- [ ] 중단(stop) 처리 확인

**UI 일치**
- [ ] 목업(design/mockup/)과 픽셀 레벨 비교
- [ ] 다크 배경(사이드바) / 라이트 배경(옵션) 정확 적용

**데이터 정합성**
- [ ] 크레딧 차감액 = api_cost × multiplier (소수점 6자리 일치)
- [ ] 잔액 0 미만 방지 (DB CHECK 제약 + API 레벨 이중 확인)
- [ ] translation_jobs 상태 전이 정확 (pending→running→completed/failed)

**보안**
- [ ] Google OAuth 토큰 검증 필수 (미인증 요청 401)
- [ ] 타 사용자 크레딧 접근 불가 (RLS 확인)
- [ ] 웹훅 서명 검증 (Portone 미서명 요청 거부)

---

## 에러 기록 규칙

`error/` 폴더에 카테고리별 기록:

```
error/
  backend-{날짜}.md   — Worker API 오류
  extension-{날짜}.md — Extension 오류
  payment-{날짜}.md   — 결제/크레딧 오류
```

형식:
```markdown
## [날짜] 에러명
**증상**: ...
**원인**: ...
**해결**: ...
**재발 방지**: ...
```

---

## 테스트 환경

### Extension 로컬 테스트
1. `chrome://extensions` → 개발자 모드
2. `v2/dev/extension/` 폴더 로드
3. YouTube Studio 실제 영상으로 테스트

### Backend 로컬 테스트
```bash
cd v2/dev/backend
wrangler dev --local
```

### 크레딧 모드 테스트 시나리오
1. 신규 사용자: 크레딧 0 → 충전 → 번역 → 차감 확인
2. 잔액 부족: 크레딧 0.001 → 번역 시도 → INSUFFICIENT_CREDITS 에러
3. 중단: 번역 중 stop → 사용한 만큼만 차감 확인

---

## 배포

### Extension
- Chrome Web Store → v1과 동일 Extension ID로 업데이트 (v2 기능 추가)
- `v2/dev/extension/` → zip → 스토어 업로드

### Backend
```bash
cd v2/dev/backend
wrangler deploy
```

### Supabase
- v1/supabase/migrations/ 스키마 이미 작성됨
- Supabase 대시보드 SQL Editor에서 마이그레이션 실행
