/**
 * YouTube Data API v3 - Captions API
 *
 * 토큰 관리 완전 캡슐화 — 외부에서는 videoId와 데이터만 넘기면 됨.
 * 401 발생 시 자동으로 토큰 갱신 후 1회 재시도.
 */

const YT_API_BASE    = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

// =============================================
// 내부 토큰 관리
// =============================================

let _cachedToken = null;

async function getToken(interactive = false) {
  if (_cachedToken) return _cachedToken;
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(
      { interactive, scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'] },
      (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error(chrome.runtime.lastError?.message || '토큰 획득 실패'));
        } else {
          _cachedToken = token;
          resolve(token);
        }
      }
    );
  });
}

async function refreshCachedToken() {
  if (_cachedToken) {
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token: _cachedToken }, resolve));
    _cachedToken = null;
  }
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(
      { interactive: true, scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'] },
      (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(new Error('토큰 갱신 실패 — 다시 로그인해 주세요.'));
        } else {
          _cachedToken = token;
          resolve(token);
        }
      }
    );
  });
}

/**
 * API 요청 래퍼 — 401 발생 시 토큰 갱신 후 1회 자동 재시도
 */
async function apiFetch(url, options = {}, retry = true) {
  const token = await getToken();
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers }
  });

  if (res.status === 401 && retry) {
    await refreshCachedToken();
    return apiFetch(url, options, false); // 재시도 1회
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const reason = err.error?.errors?.[0]?.reason;

    if (res.status === 403 && reason === 'quotaExceeded') {
      throw new Error('유튜브 API 할당량이 초과되었습니다. (일일 업로드 제한)');
    }
    if (res.status === 403 && reason === 'forbidden') {
      throw new Error('접근 권한이 없습니다. 본인의 영상인지 확인해 주세요.');
    }
    throw new Error(err.error?.message || `API 오류 (${res.status})`);
  }

  return res;
}

// =============================================
// Public API — 인증
// =============================================

/**
 * 최초 로그인 팝업 (익스텐션 시작 시 1회 호출)
 */
export async function authorizeYouTube() {
  _cachedToken = null;
  return getToken(true);
}

// =============================================
// Public API — 유틸리티
// =============================================

/**
 * YouTube Studio URL에서 video ID 추출
 */
export function extractVideoId(url) {
  // 1. YouTube Studio: studio.youtube.com/video/VIDEO_ID/...
  const studioMatch = url.match(/studio\.youtube\.com\/video\/([^/?#]+)/);
  if (studioMatch) return studioMatch[1];

  // 2. 일반 YouTube: youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/[?&]v=([^&#]+)/);
  if (watchMatch) return watchMatch[1];

  return null;
}

/**
 * 언어 코드 정규화 (ko-KR → ko)
 */
function normalizeLangCode(code) {
  if (!code) return '';
  return code.split('-')[0].toLowerCase();
}

// =============================================
// Public API — 영상 정보
// =============================================

/**
 * 영상 기본 정보 조회 (defaultLanguage, defaultAudioLanguage 포함)
 */
export async function getVideoDetails(videoId) {
  const res = await apiFetch(`${YT_API_BASE}/videos?part=snippet&id=${videoId}`);
  const data = await res.json();
  return data.items?.[0]?.snippet || null;
}

// =============================================
// Public API — 자막 목록
// =============================================

/**
 * 영상의 자막 트랙 목록 조회
 */
export async function listCaptions(videoId) {
  const res = await apiFetch(`${YT_API_BASE}/captions?part=snippet&videoId=${videoId}`);
  const data = await res.json();
  return data.items || [];
}

// =============================================
// Public API — 원본 자막 다운로드 (5단계 감지)
// =============================================

/**
 * 원본 자막 선정 및 다운로드 (5단계 우선순위)
 *
 * 우선순위:
 *  1) settings.sourceLang과 일치하는 standard 트랙
 *  2) videoDefaultLang과 일치하는 standard 트랙
 *  3) videoAudioDefaultLang과 일치하는 standard 트랙
 *  4) 아무 standard 트랙 (ko/en 우선)
 *  5) ASR(자동생성) 트랙
 *  6) 첫 번째 트랙 (최후의 수단)
 *
 * @param {Array}  captions            listCaptions()의 결과
 * @param {string} sourceLang          설정의 sourceLang ('ko', 'auto' 등)
 * @param {string} [videoDefaultLang]  영상 snippet.defaultLanguage
 * @param {string} [videoAudioDefaultLang] 영상 snippet.defaultAudioLanguage
 * @returns {{ subtitles: Array, trackInfo: object }}
 */
export async function fetchSourceSubtitles(captions, sourceLang, videoDefaultLang, videoAudioDefaultLang) {
  const normSource      = normalizeLangCode(sourceLang !== 'auto' ? sourceLang : null);
  const normVideoDefault = normalizeLangCode(videoDefaultLang);
  const normAudioDefault = normalizeLangCode(videoAudioDefaultLang);

  let target = null;

  // 1) 설정 sourceLang과 일치하는 standard 트랙
  if (normSource) {
    target = captions.find(c =>
      normalizeLangCode(c.snippet?.language) === normSource && c.snippet?.trackKind === 'standard'
    ) || captions.find(c =>
      normalizeLangCode(c.snippet?.language) === normSource
    );
  }

  // 2) 영상 기본 언어와 일치하는 standard 트랙
  if (!target && normVideoDefault) {
    target = captions.find(c =>
      normalizeLangCode(c.snippet?.language) === normVideoDefault && c.snippet?.trackKind === 'standard'
    );
  }

  // 3) 영상 기본 오디오 언어와 일치하는 standard 트랙
  if (!target && normAudioDefault) {
    target = captions.find(c =>
      normalizeLangCode(c.snippet?.language) === normAudioDefault && c.snippet?.trackKind === 'standard'
    );
  }

  // 4) 아무 standard 트랙 (영상 언어 → ko → en → 첫번째)
  if (!target) {
    const standards = captions.filter(c => c.snippet?.trackKind === 'standard');
    if (standards.length > 0) {
      target =
        standards.find(c => normalizeLangCode(c.snippet?.language) === normVideoDefault) ||
        standards.find(c => ['ko', 'en'].includes(normalizeLangCode(c.snippet?.language))) ||
        standards[0];
    }
  }

  // 5) ASR(자동생성) 트랙
  if (!target && normVideoDefault) {
    target = captions.find(c =>
      normalizeLangCode(c.snippet?.language) === normVideoDefault && c.snippet?.trackKind === 'asr'
    );
  }

  // 6) 최후의 수단: 첫 번째 트랙
  if (!target && captions.length > 0) {
    target = captions[0];
  }

  if (!target) {
    throw new Error('원본 자막이 없습니다. 유튜브 스튜디오에서 먼저 자막을 추가해 주세요.');
  }

  const trackInfo = {
    id: target.id,
    language: target.snippet?.language,
    trackKind: target.snippet?.trackKind || 'unknown',
    isASR: target.snippet?.trackKind === 'asr'
  };

  const res = await apiFetch(`${YT_API_BASE}/captions/${target.id}?tfmt=srt`);
  const srtText = await res.text();
  const subtitles = parseSRT(srtText);

  return { subtitles, trackInfo };
}

// =============================================
// Public API — 자막 업로드
// =============================================

/**
 * 자막 업로드 (신규 insert / 기존 standard 트랙 update 자동 판별)
 * ASR 트랙은 update 대상에서 제외하고 새로 insert함
 */
export async function uploadCaption(videoId, ytLangCode, srtContent, existingCaptions = []) {
  const normTarget = normalizeLangCode(ytLangCode);
  const existing = existingCaptions.find(c => {
    return normalizeLangCode(c.snippet?.language) === normTarget &&
           c.snippet?.trackKind === 'standard';
  });

  const action = existing ? `UPDATE (id: ${existing.id})` : 'INSERT';
  console.log(`[YT-Translator] 자막 업로드 시작 — lang: ${ytLangCode}, action: ${action}, videoId: ${videoId}`);

  return existing
    ? _updateCaption(existing.id, ytLangCode, srtContent)
    : _insertCaption(videoId, ytLangCode, srtContent);
}

// =============================================
// 내부 업로드 함수
// =============================================

async function _multipartUpload(url, metadata, srtContent, method = 'POST') {
  const boundary = 'yt_translator_mp_boundary';

  // CR+LF 정규화 (YouTube 서버 선호)
  const normalizedSrt = srtContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  if (!normalizedSrt.trim()) {
    throw new Error('생성된 SRT 내용이 비어 있습니다. 번역 결과를 확인해 주세요.');
  }

  const blob = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata) + '\r\n',
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
    normalizedSrt + '\r\n',
    `--${boundary}--`
  ], { type: `multipart/related; boundary=${boundary}` });

  const res = await apiFetch(url, { method, body: blob });

  // 응답 body 파싱 — 성공 여부 명시적 확인
  const data = await res.json().catch(() => null);

  if (!data?.id) {
    // 200이어도 id 없으면 업로드 실패로 처리
    throw new Error(
      `자막 업로드 응답이 비정상입니다: ${JSON.stringify(data)}` +
      ` (hint: 영상이 내 채널 소유인지, YouTube Studio에서 자막 탭을 확인해 주세요.)`
    );
  }

  console.log(`[YT-Translator] 업로드 성공 — caption id: ${data.id}, lang: ${data.snippet?.language}`);
  return data;
}

async function _insertCaption(videoId, langCode, srtContent) {
  return _multipartUpload(
    `${YT_UPLOAD_BASE}/captions?uploadType=multipart&part=snippet`,
    { snippet: { videoId, language: langCode, name: `[AI] ${langCode.toUpperCase()}`, isDraft: false } },
    srtContent,
    'POST'
  );
}

async function _updateCaption(captionId, langCode, srtContent) {
  return _multipartUpload(
    `${YT_UPLOAD_BASE}/captions?uploadType=multipart&part=snippet`,
    { id: captionId, snippet: { language: langCode, name: `[AI] ${langCode.toUpperCase()}`, isDraft: false } },
    srtContent,
    'PUT'
  );
}

// =============================================
// SRT 파싱 / 생성
// =============================================

/**
 * SRT 텍스트 파싱 → 내부 포맷으로 변환
 */
export function parseSRT(srtText) {
  if (!srtText) return [];

  const normalized = srtText.replace(/\r\n/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/);

  return blocks.map(block => {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return null;

    const timecodeLine = (lines[1] || '').trim();
    if (!timecodeLine.includes(' --> ')) return null;

    const [startRaw, endRaw] = timecodeLine.split(' --> ');
    const startTime = startRaw.trim();
    const endTime   = endRaw.trim().split(/\s+/)[0]; // 좌표 정보 제거
    const text      = lines.slice(2).join(' ').trim();

    return { timecode: startTime, startTime, endTime, text };
  }).filter(s => s && s.text);
}

/**
 * 내부 포맷 → SRT 텍스트 변환
 */
export function subtitlesToSRT(subtitles) {
  return subtitles.map((s, i) =>
    `${i + 1}\n${s.startTime || s.timecode} --> ${s.endTime || s.timecode}\n${s.text}`
  ).join('\n\n');
}
