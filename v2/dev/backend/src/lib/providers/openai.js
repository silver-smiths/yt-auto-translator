/**
 * OpenAI 어댑터 — v2.x 구현 예정
 *
 * 현재: OPENAI_API_KEY 미설정 시 자동 skip
 * 향후: Gemini 전체 장애 시 최종 폴백으로 활성화
 *
 * 구현 시 고려사항:
 *   - response_format: { type: 'json_schema', json_schema: {...} } 사용
 *   - gpt-4o-mini 권장 (속도/비용 균형)
 *   - 토큰 단가가 Gemini와 달라 크레딧 정산은 동일 요율 적용
 */

export async function callOpenAI({ model = 'gpt-4o-mini', subtitles, offset, targetLangs, sourceLang, apiKey, signal }) {
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY not configured'), { code: 'NOT_CONFIGURED' });

  // TODO v2.x: OpenAI API 호출 구현
  throw Object.assign(new Error('OpenAI provider not yet implemented'), { code: 'NOT_IMPLEMENTED' });
}
