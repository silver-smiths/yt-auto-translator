// 공유 상수 — 단가/환율 변경 시 이 파일만 수정
// 단가 출처: ai.google.dev/gemini-api/docs/pricing (2026-07 확인)
export const INPUT_PER_M       = 0.30;   // Gemini 2.5 Flash input  $/1M tokens
export const OUTPUT_PER_M      = 2.50;   // Gemini 2.5 Flash output $/1M tokens (thinking 포함)
export const CREDIT_MULTIPLIER = 15.0;   // API 원가 대비 사용자 청구 배율
export const KRW_TO_USD_RATE   = 1350;   // 고정 환율 (KRW → USD)

export const MAX_SUBTITLES  = 500;  // 청크당 자막 최대 개수
export const MAX_TARGET_LANGS = 10; // 동시 번역 최대 언어 수

// 진행 중 작업 마무리용 소액 초과 허용 (USD) — 잔액 소진 시점에 시작된 번역이 끊기지 않도록.
// job 생성 시 잔액>0 검사와 조합되어 사용자당 최대 부채는 이 값으로 상한.
export const OVERDRAFT_USD = 2.0;
