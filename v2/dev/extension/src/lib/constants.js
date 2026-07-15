/**
 * YTAT v2 — Constants
 */

// ── 번역 모드 (v2.0부터 크레딧 단일 모드) ───────────────────────────────────
export const TRANSLATION_MODES = {
  CREDITS: 'credits',
};

// ── 지원 언어 (26개) ──────────────────────────────────────────────────────────
// region: 설정 화면 언어 그룹핑용 (지역·지역 내부 모두 사용자 수 내림차순 정렬)
export const TARGET_LANGUAGES = [
  // 글로벌 (여러 대륙에서 폭넓게 사용)
  { code: 'en',    name: 'English',                nativeName: 'English',          ytCode: 'en',      region: '글로벌' },
  { code: 'es',    name: 'Spanish',                nativeName: 'Español',          ytCode: 'es',      region: '글로벌' },
  { code: 'fr',    name: 'French',                 nativeName: 'Français',         ytCode: 'fr',      region: '글로벌' },
  { code: 'ar',    name: 'Modern Standard Arabic', nativeName: 'العربية',          ytCode: 'ar',      region: '글로벌' },
  { code: 'pt',    name: 'Portuguese',             nativeName: 'Português',        ytCode: 'pt',      region: '글로벌' },
  // 동아시아
  { code: 'zh-CN', name: 'Mandarin (Simplified)',  nativeName: '中文(简体)',        ytCode: 'zh-Hans', region: '동아시아' },
  { code: 'zh-TW', name: 'Chinese (Traditional)',  nativeName: '中文(繁體)',        ytCode: 'zh-Hant', region: '동아시아' },
  { code: 'ja',    name: 'Japanese',               nativeName: '日本語',            ytCode: 'ja',      region: '동아시아' },
  { code: 'ko',    name: 'Korean',                 nativeName: '한국어',            ytCode: 'ko',      region: '동아시아' },
  // 남아시아
  { code: 'hi',    name: 'Hindi',                  nativeName: 'हिन्दी',            ytCode: 'hi',      region: '남아시아' },
  { code: 'bn',    name: 'Bengali',                nativeName: 'বাংলা',             ytCode: 'bn',      region: '남아시아' },
  { code: 'ur',    name: 'Urdu',                   nativeName: 'اردو',              ytCode: 'ur',      region: '남아시아' },
  { code: 'pa',    name: 'Western Punjabi',        nativeName: 'پنجابی',           ytCode: 'pa',      region: '남아시아' },
  { code: 'ta',    name: 'Tamil',                  nativeName: 'தமிழ்',             ytCode: 'ta',      region: '남아시아' },
  // 유럽
  { code: 'ru',    name: 'Russian',                nativeName: 'Русский',          ytCode: 'ru',      region: '유럽' },
  { code: 'de',    name: 'German',                 nativeName: 'Deutsch',          ytCode: 'de',      region: '유럽' },
  { code: 'it',    name: 'Italian',                nativeName: 'Italiano',         ytCode: 'it',      region: '유럽' },
  { code: 'pl',    name: 'Polish',                 nativeName: 'Polski',           ytCode: 'pl',      region: '유럽' },
  { code: 'nl',    name: 'Dutch',                  nativeName: 'Nederlands',       ytCode: 'nl',      region: '유럽' },
  // 동남아시아
  { code: 'id',    name: 'Indonesian',             nativeName: 'Bahasa Indonesia', ytCode: 'id',      region: '동남아시아' },
  { code: 'vi',    name: 'Vietnamese',             nativeName: 'Tiếng Việt',       ytCode: 'vi',      region: '동남아시아' },
  { code: 'tl',    name: 'Tagalog',                nativeName: 'Tagalog',          ytCode: 'fil',     region: '동남아시아' },
  { code: 'th',    name: 'Thai',                   nativeName: 'ไทย',               ytCode: 'th',      region: '동남아시아' },
  // 중동·서아시아
  { code: 'tr',    name: 'Turkish',                nativeName: 'Türkçe',           ytCode: 'tr',      region: '중동·서아시아' },
  { code: 'fa',    name: 'Persian',                nativeName: 'فارسی',             ytCode: 'fa',      region: '중동·서아시아' },
  // 아프리카
  { code: 'sw',    name: 'Swahili',                nativeName: 'Kiswahili',        ytCode: 'sw',      region: '아프리카' },
];

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
  translationMode:      TRANSLATION_MODES.CREDITS,
  sourceLang:           'auto',
  targetLangs:          TARGET_LANGUAGES.map(l => l.code).filter(c => c !== 'ko'),
  welcomeDismissed:     false,
  translateSubtitles:   true,
  translateTitle:       true,
  translateDescription: true,
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

