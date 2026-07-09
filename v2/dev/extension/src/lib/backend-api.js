import { API_BASE } from './constants.js';

function getToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) reject(new Error('AUTH_FAILED'));
      else resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// 401 발생 시 만료 토큰 제거 후 1회 재시도
async function authFetch(url, options = {}) {
  let token = await getToken();
  const doFetch = (t) => fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...options.headers },
  });

  let res = await doFetch(token);
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getToken();
    res = await doFetch(token);
  }
  return res;
}

export async function fetchCredits() {
  const res = await authFetch(`${API_BASE}/credits`);
  if (!res.ok) throw new Error(`CREDITS_FETCH_FAILED_${res.status}`);
  return res.json(); // { balance, tier, multiplier }
}

export async function createTranslationJob(params) {
  const res = await authFetch(`${API_BASE}/translate/job`, {
    method:  'POST',
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`CREATE_JOB_FAILED_${res.status}`);
  return res.json(); // { job_id }
}

export async function translateChunk(params) {
  const res = await authFetch(`${API_BASE}/translate/chunk`, {
    method:  'POST',
    body: JSON.stringify(params),
  });
  if (res.status === 402) throw new Error('INSUFFICIENT_CREDITS');
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (res.status === 504) throw new Error('ALL_FALLBACKS_FAILED');
  if (!res.ok) throw new Error(`TRANSLATE_CHUNK_FAILED_${res.status}`);
  return res.json(); // { translations, model_used, tokens }
}

export async function createCheckout(amount, currency) {
  const res = await authFetch(`${API_BASE}/credits/checkout`, {
    method: 'POST',
    body: JSON.stringify({ amount, currency }),
  });
  if (!res.ok) throw new Error(`CHECKOUT_FAILED_${res.status}`);
  return res.json(); // { payment_id, order_id, amount, currency }
}

export async function updateTranslationJob(jobId, params) {
  const res = await authFetch(`${API_BASE}/translate/job/${jobId}`, {
    method:  'PATCH',
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`UPDATE_JOB_FAILED_${res.status}`);
}
