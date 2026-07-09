// 공유 상수 — 단가/환율 변경 시 이 파일만 수정
export const INPUT_PER_M       = 0.075;  // Gemini 2.5 Flash input  $/1M tokens
export const OUTPUT_PER_M      = 0.30;   // Gemini 2.5 Flash output $/1M tokens
export const CREDIT_MULTIPLIER = 3.0;    // API 원가 대비 사용자 청구 배율
export const KRW_TO_USD_RATE   = 1350;   // 고정 환율 (KRW → USD)

export const MAX_SUBTITLES  = 500;  // 청크당 자막 최대 개수
export const MAX_TARGET_LANGS = 10; // 동시 번역 최대 언어 수
