import { API_BASE } from './constants.js';

function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) reject(new Error('AUTH_FAILED'));
      else resolve(token);
    });
  });
}

async function authHeaders() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function fetchCredits() {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/credits`, { headers });
  if (!res.ok) throw new Error(`CREDITS_FETCH_FAILED_${res.status}`);
  return res.json(); // { balance, tier, multiplier }
}

export async function createTranslationJob(params) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/translate/job`, {
    method:  'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`CREATE_JOB_FAILED_${res.status}`);
  return res.json(); // { job_id }
}

export async function translateChunk(params) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/translate/chunk`, {
    method:  'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (res.status === 402) throw new Error('INSUFFICIENT_CREDITS');
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (res.status === 504) throw new Error('ALL_FALLBACKS_FAILED');
  if (!res.ok) throw new Error(`TRANSLATE_CHUNK_FAILED_${res.status}`);
  return res.json(); // { translations, model_used, tokens }
}

export async function updateTranslationJob(jobId, params) {
  const headers = await authHeaders();
  await fetch(`${API_BASE}/translate/job/${jobId}`, {
    method:  'PATCH',
    headers,
    body: JSON.stringify(params),
  });
}
