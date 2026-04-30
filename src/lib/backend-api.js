/**
 * 유료 모드 백엔드 API 클라이언트
 * Cloudflare Workers API 서버와 통신
 */

const API_BASE = 'https://yt-auto-translator-api.1009yjh.workers.dev';

// ── Google OAuth 토큰 획득 ─────────────────────────────────
async function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || '인증 실패'));
      } else {
        resolve(token);
      }
    });
  });
}

async function apiFetch(path, options = {}) {
  const token = await getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || `API 오류 (${res.status})`), { status: res.status, code: err.error });
  }

  return res.json();
}

// ── 크레딧 잔액 조회 ──────────────────────────────────────
export async function getCredits() {
  return apiFetch('/credits');
}

// ── 번역 작업 생성 ────────────────────────────────────────
export async function createJob({ videoId, jobType, sourceLang, targetLangs, model }) {
  return apiFetch('/translate/job', {
    method: 'POST',
    body: JSON.stringify({ video_id: videoId, job_type: jobType, source_lang: sourceLang, target_langs: targetLangs, model })
  });
}

// ── 번역 작업 상태 업데이트 ───────────────────────────────
export async function updateJob(jobId, status, errorMessage = null) {
  return apiFetch(`/translate/job/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, error_message: errorMessage })
  });
}

// ── 청크 번역 (백엔드 Gemini 프록시) ─────────────────────
export async function translateChunk({ jobId, model, prompt, targetLang }) {
  return apiFetch('/translate/chunk', {
    method: 'POST',
    body: JSON.stringify({ job_id: jobId, model, prompt, target_lang: targetLang })
  });
}

/**
 * 자막 번역 — 백엔드 경유 버전
 * llm-api.js의 translateSubtitles()와 동일한 인터페이스
 */
export const CHUNK_SIZE_BACKEND = 50;

export async function translateSubtitlesBackend({
  jobId, model, sourceLang, targetLang, subtitles, onChunkProgress
}) {
  const results = new Array(subtitles.length);
  const totalChunks = Math.ceil(subtitles.length / CHUNK_SIZE_BACKEND);
  let chunksCompleted = 0;

  for (let i = 0; i < subtitles.length; i += CHUNK_SIZE_BACKEND) {
    const chunk  = subtitles.slice(i, i + CHUNK_SIZE_BACKEND);
    const offset = i;

    const subtitleTexts = chunk.map((s, idx) => `[${offset + idx + 1}] ${s.text}`).join('\n');
    const prompt = `Translate the following subtitles from ${sourceLang} to ${targetLang}.\nReturn ONLY lines in [ID] Text format.\n\n${subtitleTexts}`;

    const data = await translateChunk({ jobId, model, prompt, targetLang });

    // 응답 파싱 (llm-api.js의 parseTranslatedLines와 동일한 로직)
    const cleanText = (data.text || '').replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1').trim();
    const parsedMap = parseLines(cleanText);

    chunk.forEach((original, idx) => {
      const translated = parsedMap.get(offset + idx + 1) || parsedMap.get(idx + 1);
      results[offset + idx] = translated
        ? { ...original, text: translated }
        : { ...original };
    });

    chunksCompleted++;
    if (onChunkProgress) onChunkProgress(chunksCompleted, totalChunks);
  }

  return results;
}

function parseLines(text) {
  const map = new Map();
  const regexes = [
    /^\[(\d+)\][\s.:-]*\s*(.*)$/,
    /^\**(\d+)\.\**[\s.:-]*\s*(.*)$/,
    /^(\d+)[\s.:-]+\s*(.*)$/,
    /^(\d+)\)\s*(.*)$/
  ];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const regex of regexes) {
      const match = trimmed.match(regex);
      if (match) {
        const id = parseInt(match[1], 10);
        const content = match[2].trim();
        if (content && !map.has(id)) map.set(id, content);
        break;
      }
    }
  }
  return map;
}
