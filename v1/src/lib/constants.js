/**
 * YouTube Auto-Translator Extension - Constants
 * Gemini 전용 (OAuth + API Key 양방식 지원)
 */

// 지원 언어 목록 (26개)
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
  { code: 'ko',    name: 'Korean',                    nativeName: '한국어',            ytCode: 'ko'      }
];

// Gemini 전용 설정
// ※ Google AI API 공식 표준 endpoint: v1beta
//   - system_instruction 필드는 v1beta에서만 지원 (v1에서 400 오류 발생)
//   - 모델 목록은 2026년 4월 기준 GA(정식) 출시 모델만 포함
export const GEMINI_CONFIG = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  models: [
    { id: 'gemini-2.5-flash',      name: 'Gemini 2.5 Flash (권장)' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (경량)' },
    { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro (고품질)' }
  ],
  defaultModel: 'gemini-2.5-flash',
  apiKeyUrl: 'https://aistudio.google.com/apikey'
};

// Gemini API 요금제별 요청 속도 설정
// intervalMs: 연속 요청 사이 최소 대기 시간
export const RATE_CONFIGS = {
  free:        { intervalMs: 5000,  rpmLabel: '~12 RPM', desc: '무료 티어 자동 (5초 간격)' },
  paid_fast:   { intervalMs: 500,   rpmLabel: '~120 RPM', desc: '빠름 (0.5초 간격)' },
  paid_normal: { intervalMs: 2000,  rpmLabel: '~30 RPM',  desc: '보통 (2초 간격)' },
  paid_slow:   { intervalMs: 5000,  rpmLabel: '~12 RPM',  desc: '느리게 (5초 간격)' }
};

// 기본 설정값
export const DEFAULT_SETTINGS = {
  useGeminiOAuth: false,    // true: Google OAuth / false: API Key
  geminiApiKey: '',
  geminiTier: 'free',       // 'free' | 'paid'
  paidSpeed: 'normal',      // 'fast' | 'normal' | 'slow' (유료 선택 시)
  selectedModel: 'gemini-2.5-flash',
  sourceLang: 'ko',
  targetLangs: TARGET_LANGUAGES.map(l => l.code).filter(c => c !== 'ko'),
  delayMin: 1000,
  delayMax: 3000
};

// 메시지 타입
export const MSG = {
  START_TRANSLATION:    'START_TRANSLATION',
  STOP_TRANSLATION:     'STOP_TRANSLATION',
  TRANSLATION_PROGRESS: 'TRANSLATION_PROGRESS',
  TRANSLATION_COMPLETE: 'TRANSLATION_COMPLETE',
  TRANSLATION_ERROR:    'TRANSLATION_ERROR',
  GET_STATUS:           'GET_STATUS',
  LOG_ERROR:            'LOG_ERROR'
};

// 번역 프롬프트 템플릿
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
