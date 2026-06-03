const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = (sourceLang, targetLangs, count) =>
  `You are a professional subtitle translator.
Translate the following ${count} subtitles from ${sourceLang} into these languages: ${targetLangs.join(', ')}.

Each subtitle is labeled [ID]. Return a JSON object where each key is a language code and each value is an array of exactly ${count} translated strings, preserving the original order.

Rules:
1. Translate EVERY subtitle independently. Never merge, skip, or deduplicate lines.
2. Each language array must contain exactly ${count} strings.
3. Do not include [ID] labels in your output strings.
4. Preserve meaning and subtitle style.`;

export async function callGemini({ model, subtitles, offset, targetLangs, sourceLang, apiKey, signal }) {
  const inputText = subtitles
    .map((s, i) => `[${offset + i + 1}] ${s.text}`)
    .join('\n');

  const properties = Object.fromEntries(
    targetLangs.map(lang => [lang, { type: 'ARRAY', items: { type: 'STRING' } }])
  );

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT(sourceLang, targetLangs, subtitles.length) }]
    },
    contents: [{ parts: [{ text: inputText }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 65536,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties,
        required: targetLangs,
      }
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ]
  };

  const res = await fetch(`${BASE_URL}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data.candidates?.[0]?.finishReason;
  const usage = data.usageMetadata || {};

  if (!text) throw new Error(`Empty response (finishReason: ${finishReason})`);

  // JSON 파싱 시도
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON 파싱 실패 → [ID] Text 방식 폴백 파싱
    parsed = parseIdTextFallback(text, targetLangs, subtitles, offset);
  }

  return {
    translations: parsed,
    tokens: {
      input: usage.promptTokenCount || 0,
      output: usage.candidatesTokenCount || 0,
    }
  };
}

// [ID] Text 방식 폴백 파싱 (JSON 실패 시)
// 응답에서 언어별로 구분할 수 없으므로 첫 번째 언어만 추출 후 나머지는 원본 유지
function parseIdTextFallback(text, targetLangs, subtitles, offset) {
  const map = new Map();
  const regexes = [
    /^\[(\d+)\][\s.:-]*\s*(.+)$/,
    /^(\d+)[\s.:-]+\s*(.+)$/,
  ];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const re of regexes) {
      const m = trimmed.match(re);
      if (m) {
        const id = parseInt(m[1], 10);
        if (!map.has(id)) map.set(id, m[2].trim());
        break;
      }
    }
  }

  const firstLang = targetLangs[0];
  const fallbackArr = subtitles.map((s, i) => map.get(offset + i + 1) || s.text);

  // 나머지 언어는 원본으로 채움 (JSON 실패 상황에서의 최선)
  return Object.fromEntries(
    targetLangs.map(lang => [lang, lang === firstLang ? fallbackArr : subtitles.map(s => s.text)])
  );
}
