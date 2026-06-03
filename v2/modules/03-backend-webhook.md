# 모듈 03 — 백엔드 /webhook/portone

## 기능 설명
Portone 결제 완료 시 서버로 전송되는 웹훅을 처리한다.
결제 검증 후 Supabase에 payments 레코드를 저장하고 크레딧을 즉시 지급한다.

## 관련 목업
design/mockup/02-options.html → 충전 후 크레딧 잔액 갱신

## API 스펙

### POST /webhook/portone
```
Portone-Signature: <서명>

Body (Portone V2 웹훅):
{
  "type": "Transaction.Paid",
  "data": {
    "paymentId": "portone_unique_id",
    "orderName": "YTAT 크레딧 충전",
    "amount": { "total": 20000 },
    "currency": "KRW",
    "customer": { "email": "user@gmail.com" },
    "status": "PAID"
  }
}

Response 200: { "ok": true }
Response 400: 서명 검증 실패 / 이미 처리된 결제
```

## 처리 흐름
1. Portone 서명(Portone-Signature) 검증
2. `type === "Transaction.Paid"` + `status === "PAID"` 확인
3. payments 테이블에서 portone_id 중복 체크 (멱등성)
4. 결제 금액 → USD 환산:
   - KRW: `amount_krw / 1400`
   - USD: 그대로
5. Supabase users 테이블에서 email로 user_id 조회
6. payments 레코드 INSERT (status: 'completed')
7. `grant_credits()` RPC 호출 → 크레딧 즉시 지급
8. 200 반환

## 크레딧 지급 계산 (예시)
```
결제: ₩20,000
→ USD: 20000 / 1400 = 14.2857 (소수점 6자리)
→ credits_granted = 14.285714
→ 사용자 표시: "14.28 크레딧"
```

## 의존성
- Portone API (서명 검증)
- Supabase: users, payments, grant_credits()

## QA 기준
- [ ] 정상 웹훅 → 크레딧 지급 + payments 레코드 생성
- [ ] 동일 portone_id 재전송 → 중복 처리 없이 200 반환
- [ ] 서명 오류 → 400
- [ ] 알 수 없는 이메일 → 500 (사용자 미등록)
- [ ] KRW 20,000 → 14.2857 크레딧 정확 지급
