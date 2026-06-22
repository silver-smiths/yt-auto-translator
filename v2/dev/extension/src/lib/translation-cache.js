/**
 * Translation Cache — 업로드 실패 시 번역 결과를 로컬에 저장하여 재시도 지원
 *
 * 구조:
 *  chrome.storage.local['ytat_cache_${videoId}'] = {
 *    langResults: { es: ['line1', ...], de: [...] },
 *    savedAt: timestamp,
 *  }
 */

const PREFIX  = 'ytat_cache_';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7일

/**
 * 저장된 번역 결과 조회
 * @returns {Promise<{langResults: Object}|null>}
 */
export async function getSavedTranslations(videoId) {
  const key = PREFIX + videoId;
  const r   = await chrome.storage.local.get(key);
  const hit = r[key];
  if (!hit) return null;

  // 만료 확인
  if (Date.now() - hit.savedAt > MAX_AGE) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return hit;
}

/**
 * 번역 결과 저장 (업로드 실패한 언어만)
 * @param {string}   videoId
 * @param {Object}   langResults   { langCode: ['line', ...] }
 * @param {string[]} failedLangs   저장할 언어 코드 목록
 */
export async function saveTranslations(videoId, langResults, failedLangs) {
  if (!failedLangs.length) return;

  const key = PREFIX + videoId;
  const r   = await chrome.storage.local.get(key);
  const existing = r[key]?.langResults || {};

  // 기존 캐시에 merge
  const merged = { ...existing };
  for (const code of failedLangs) {
    if (langResults[code]) merged[code] = langResults[code];
  }

  await chrome.storage.local.set({
    [key]: { langResults: merged, savedAt: Date.now() },
  });
}

/**
 * 업로드 성공한 언어의 캐시 삭제
 * 모든 언어가 제거되면 키 자체를 삭제
 */
export async function clearSavedTranslations(videoId, succeededLangs) {
  if (!succeededLangs.length) return;

  const key = PREFIX + videoId;
  const r   = await chrome.storage.local.get(key);
  const hit = r[key];
  if (!hit) return;

  for (const code of succeededLangs) delete hit.langResults[code];

  if (Object.keys(hit.langResults).length === 0) {
    await chrome.storage.local.remove(key);
  } else {
    await chrome.storage.local.set({ [key]: hit });
  }
}
