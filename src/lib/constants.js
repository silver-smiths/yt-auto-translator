/**
 * YTAT v2 — Constants
 */

// ── 번역 모드 ────────────────────────────────────────────────────────────────
export const TRANSLATION_MODES = {
  API_KEY: 'api_key',
  CREDITS: 'credits',
};

// ── 지원 언어 (26개) ──────────────────────────────────────────────────────────
export const TARGET_LANGUAGES = [
  { code: 'en',    name: 'English',                   nativeName: 'English',          ytCode: 'en'      },
  { code: 'zh-CN', name: 'Mandarin (Simplified)',      nativeName: '中文(简体)',        ytCode: 'zh-Hans' },
  { code: 'hi',    name: 'Hindi',                     nativeName: 'हिन्दी',            ytCode: 'hi'      },
  { code: 'es',    name: 'Spanish',                   nativeName: 'Español',          ytCode: 'es'      },
  { code: 'fr',    name: 'French',                    nativeName: 'Français',         ytCode: 'fr'      },
  { code: 'ar',    name: 'Modern Standard Arabic',    nativeName: 'العربية',          ytCode: 'ar'      },
  { code: 'pt',    name: 'Portuguese',                nativeName: 'Português',        ytCode: 'pt'      },
  { code: 'bn',    name: 'Bengali',                   nativeName: 'বাংলা',             ytCode: 'bn'      },
  { code: 'ru',    name: 'Russian',                   nativeName: 'Русский',          ytCode: 'ru'      },
  { code: 'ur',    name: 'Urdu',                      nativeName: 'اردو',              ytCode: 'ur'      },
  { code: 'id',    name: 'Indonesian',                nativeName: 'Bahasa Indonesia', ytCode: 'id'      },
  { code: 'de',    name: 'German',                    nativeName: 'Deutsch',          ytCode: 'de'      },
  { code: 'ja',    name: 'Japanese',                  nativeName: '日本語',            ytCode: 'ja'      },
  { code: 'pcm',   name: 'Nigerian Pidgin',           nativeName: 'Naijá',            ytCode: 'pcm'     },
  { code: 'arz',   name: 'Egyptian Arabic',           nativeName: 'مصرى',             ytCode: 'arz'     },
  { code: 'mr',    name: 'Marathi',                   nativeName: 'मराठी',             ytCode: 'mr'      },
  { code: 'vi',    name: 'Vietnamese',                nativeName: 'Tiếng Việt',       ytCode: 'vi'      },
  { code: 'te',    name: 'Telugu',                    nativeName: 'తెలుగు',            ytCode: 'te'      },
  { code: 'tr',    name: 'Turkish',                   nativeName: 'Türkçe',           ytCode: 'tr'      },
  { code: 'pa',    name: 'Western Punjabi',           nativeName: 'پنجابی',           ytCode: 'pa'      },
  { code: 'sw',    name: 'Swahili',                   nativeName: 'Kiswahili',        ytCode: 'sw'      },
  { code: 'tl',    name: 'Tagalog',                   nativeName: 'Tagalog',          ytCode: 'fil'     },
  { code: 'ta',    name: 'Tamil',                     nativeName: 'தமிழ்',             ytCode: 'ta'      },
  { code: 'yue',   name: 'Yue Chinese (Cantonese)',   nativeName: '粵語',              ytCode: 'yue'     },
  { code: 'wuu',   name: 'Wu Chinese (Shanghainese)', nativeName: '吴语',              ytCode: 'wuu'     },
  { code: 'ko',    name: 'Korean',                    nativeName: '한국어',            ytCode: 'ko'      },
];

// ── Gemini 설정 ───────────────────────────────────────────────────────────────
export const GEMINI_CONFIG = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  models: [
    { id: 'gemini-2.5-flash',      name: 'Gemini 2.5 Flash (권장)' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (경량)' },
    { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro (고품질)' },
  ],
  defaultModel: 'gemini-2.5-flash',
  apiKeyUrl: 'https://aistudio.google.com/apikey',
};

// ── Rate Limit (API 키 모드 무료 티어 전용) ───────────────────────────────────
export const RATE_CONFIGS = {
  free: { intervalMs: 5000, rpmLabel: '~12 RPM', desc: '무료 티어 (5초 간격)' },
};

// ── 백엔드 API ────────────────────────────────────────────────────────────────
export const API_BASE = 'https://yt-auto-translator-api.1009yjh.workers.dev';
export const PAYMENT_URL = 'https://silver-smiths.com/project/ytat-credits.html';

// ── 언어 수 기반 동적 청크 크기 (크레딧 모드) ─────────────────────────────────
export function getChunkSize(langCount) {
  if (langCount <= 3)  return 150;
  if (langCount <= 8)  return 100;
  if (langCount <= 15) return 80;
  return 60;
}

// ── 기본 설정값 ───────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
  translationMode:  TRANSLATION_MODES.API_KEY,
  geminiApiKey:     '',
  selectedModel:    'gemini-2.5-flash',
  sourceLang:       'auto',
  targetLangs:      TARGET_LANGUAGES.map(l => l.code).filter(c => c !== 'ko'),
  welcomeDismissed: false,
};

// ── 메시지 타입 ───────────────────────────────────────────────────────────────
export const MSG = {
  START_TRANSLATION:    'START_TRANSLATION',
  STOP_TRANSLATION:     'STOP_TRANSLATION',
  TRANSLATION_PROGRESS: 'TRANSLATION_PROGRESS',
  TRANSLATION_COMPLETE: 'TRANSLATION_COMPLETE',
  TRANSLATION_ERROR:    'TRANSLATION_ERROR',
  GET_STATUS:           'GET_STATUS',
  LOG_ERROR:            'LOG_ERROR',
  OPEN_OPTIONS:         'OPEN_OPTIONS',
};

// ── 번역 프롬프트 (API 키 모드용) ─────────────────────────────────────────────
export const TRANSLATION_PROMPT = `You are a professional subtitle translator.
Your goal is to translate subtitles from {sourceLang} into {targetLang} accurately while maintaining the original meaning, tone, and subtitle style.

CRITICAL RULES:
1. Return ONLY the translated lines in {targetLang}.
2. NO preamble, NO postamble, NO explanations, NO markdown code blocks.
3. Format each line strictly as: [ID] Translated Text (e.g., [1] 안녕하세요)
4. Keep exactly the same number of lines as input. DO NOT skip, merge, or omit any lines.
5. DO NOT echo back the {sourceLang} text. YOU MUST translate into {targetLang}.
6. Your response must consist ONLY of the numbered lines.
7. Translate EVERY line independently. Even if consecutive lines appear identical or very similar in the source, you MUST output a separate translation for each — do NOT deduplicate, collapse, or skip any line.

Input Subtitles ({sourceLang} -> {targetLang}):
{subtitles}`;
