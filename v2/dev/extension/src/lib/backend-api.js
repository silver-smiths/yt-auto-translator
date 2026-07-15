import { API_BASE } from './constants.js';

// interactive=false면 이미 로그인된 경우에만 토큰을 조용히 반환(동의 팝업 없음).
// 미로그인 시 NOT_SIGNED_IN으로 거부 — 수동적 잔액 조회가 무단 OAuth 팝업을 띄우지 않도록.
function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(interactive ? 'AUTH_FAILED' : 'NOT_SIGNED_IN'));
      } else resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// 401 발생 시 만료 토큰 제거 후 1회 재시도
async function authFetch(url, options = {}, interactive = true) {
  let token = await getToken(interactive);
  const doFetch = (t) => fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...options.headers },
  });

  let res = await doFetch(token);
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getToken(interactive);
    res = await doFetch(token);
  }
  return res;
}

export async function fetchCredits(interactive = true) {
  const res = await authFetch(`${API_BASE}/credits`, {}, interactive);
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

// Google 토큰 → 웹페이지용 세션 토큰 교환 (YouTube 권한 없는 단기 토큰)
export async function exchangeSession() {
  const res = await authFetch(`${API_BASE}/auth/session`, { method: 'POST' });
  if (!res.ok) throw new Error(`SESSION_FAILED_${res.status}`);
  return res.json(); // { session_token, is_admin, email }
}
