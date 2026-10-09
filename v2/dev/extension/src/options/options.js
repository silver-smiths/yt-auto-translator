import {
  TARGET_LANGUAGES,
  TRANSLATION_MODES,
  API_BASE,
  PAYMENT_URL,
} from '../lib/constants.js';
import { loadSettings, saveSettings } from '../lib/storage.js';
import { t, applyI18n } from '../lib/i18n.js';
import { installGlobalErrorHandler } from '../lib/logger.js';

// 옵션 페이지 전역 에러도 텔레그램까지 보고 (웰컴/claim 포함)
installGlobalErrorHandler('options');

// ── DOM refs ──────────────────────────────────────────────────────────────────
const welcomeCard      = document.getElementById('welcomeCard');
const btnWelcomeClaim  = document.getElementById('btnWelcomeClaim');
const welcomeClaimStatus = document.getElementById('welcomeClaimStatus');
const creditBalance    = document.getElementById('creditBalance');
const btnTopup         = document.getElementById('btnTopup');
const sourceLang       = document.getElementById('sourceLang');
const langGrid         = document.getElementById('langGrid');
const btnSelectAll     = document.getElementById('btnSelectAll');
const btnDeselectAll   = document.getElementById('btnDeselectAll');
const translateSubtitlesCb  = document.getElementById('translateSubtitles');
const translateTitleCb      = document.getElementById('translateTitle');
const translateDescCb       = document.getElementById('translateDescription');
const btnSave               = document.getElementById('btnSave');
const saveStatus            = document.getElementById('saveStatus');

let selectedLangs = new Set();

// ── 웰컴 카드 ─────────────────────────────────────────────────────────────────
document.getElementById('btnDismissWelcome').addEventListener('click', async () => {
  welcomeCard.style.display = 'none';
  const settings = await loadSettings();
  await saveSettings({ ...settings, welcomeDismissed: true });
});

// ── 크레딧 잔액 조회 ──────────────────────────────────────────────────────────
let creditReady = false; // 로그인 + 잔액 조회 성공 여부 (충전 진입 게이트)

function getGoogleToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) reject(new Error('auth'));
      else resolve(token);
    });
  });
}

async function fetchCreditBalance() {
  creditBalance.textContent = t('credLoading');
  try {
    const token = await getGoogleToken(false); // 조용히(팝업 없이) — 미로그인이면 실패
    const res = await fetch(`${API_BASE}/credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('fetch');
    const { balance } = await res.json();
    creditBalance.textContent = `${Math.round(balance || 0).toLocaleString()} ${t('creditsUnit')}`;
    creditReady = true;
    btnTopup.textContent = t('btnTopup');
  } catch {
    // 미로그인 — 충전으로 보내지 말고 로그인부터 유도 (막다른 결제 방지)
    creditReady = false;
    creditBalance.textContent = t('loginNeeded');
    btnTopup.textContent = t('btnLogin');
  }
  updateWelcomeState();
}

// 웰컴 히어로 버튼 라벨을 로그인 상태에 맞춰 갱신 (미로그인: 로그인+수령 / 로그인: 수령)
function updateWelcomeState() {
  if (!btnWelcomeClaim || welcomeCard.style.display === 'none') return;
  btnWelcomeClaim.textContent = creditReady ? t('welClaimBtn') : t('welLoginClaimBtn');
}

// 히어로 버튼: 로그인(권한 부여) → 무료체험 크레딧 수령 (계정당 1회, 서버가 보장)
btnWelcomeClaim?.addEventListener('click', async () => {
  btnWelcomeClaim.disabled = true;
  welcomeClaimStatus.style.display = 'none';
  btnWelcomeClaim.textContent = t('loggingIn');

  let token;
  try {
    token = await getGoogleToken(true); // 대화형 — 로그인/동의 (이미 로그인 시 팝업 없이 즉시)
  } catch {
    btnWelcomeClaim.disabled = false;
    updateWelcomeState();
    showClaimStatus(t('loginFailed'), true);
    return;
  }

  btnWelcomeClaim.textContent = t('claiming');
  try {
    const res = await fetch(`${API_BASE}/credits/claim-welcome`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('claim');
    const data = await res.json();
    showClaimStatus(data.already ? t('welClaimAlready') : t('welClaimDone'), false);
    btnWelcomeClaim.style.display = 'none'; // 수령 후 재클릭 방지
  } catch {
    btnWelcomeClaim.disabled = false;
    updateWelcomeState();
    showClaimStatus(t('welClaimError'), true);
  }

  // 로그인은 성공했으니 화면 전체 갱신
  await fetchCreditBalance();
  renderReferral();
  checkAdminStatus();
});

function showClaimStatus(msg, isError) {
  welcomeClaimStatus.textContent = msg;
  welcomeClaimStatus.classList.toggle('is-error', !!isError);
  welcomeClaimStatus.style.display = 'block';
}

// 미로그인 상태면 '로그인', 로그인 상태면 '충전하기'로 동작 (버튼 라벨과 동작 일치)
btnTopup.addEventListener('click', async () => {
  if (creditReady) {
    chrome.tabs.create({ url: PAYMENT_URL });
    return;
  }
  const prev = btnTopup.textContent;
  btnTopup.disabled = true; btnTopup.textContent = t('loggingIn');
  try {
    await getGoogleToken(true); // 대화형 — Google 로그인/동의 창
  } catch {
    btnTopup.disabled = false; btnTopup.textContent = prev;
    creditBalance.textContent = t('loginFailed');
    return;
  }
  btnTopup.disabled = false;
  await fetchCreditBalance(); // 로그인 후 잔액 표시 + 버튼이 '충전하기'로 전환
  renderReferral();           // 추천 정보도 갱신
  checkAdminStatus();         // 관리자 버튼 노출 재확인
  // 로그인 직후엔 결제 사이트로 바로 넘기지 않음 — 잔액을 확인하고 다시 '충전하기'를 누르게
});

// 결제 탭에서 충전 후 설정 화면으로 돌아오면 잔액을 자동 재조회 (수동 새로고침 불필요)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchCreditBalance();
});

// ── 관리자 버튼 노출 ──────────────────────────────────────────────────────────
async function checkAdminStatus() {
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        if (chrome.runtime.lastError || !t) reject(new Error('auth'));
        else resolve(t);
      });
    });

    const res = await fetch(`${API_BASE}/admin/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const btnAdmin = document.getElementById('btnAdmin');
      if (btnAdmin) btnAdmin.style.display = 'flex';
    }
  } catch {
    // 어드민 아니면 조용히 무시
  }
}

// ── 공지사항 ──────────────────────────────────────────────────────────────────
const btnNotice       = document.getElementById('btnNotice');
const noticeBadge     = document.getElementById('noticeBadge');
const noticeModal     = document.getElementById('noticeModal');
const noticeClose     = document.getElementById('noticeClose');
const noticeList      = document.getElementById('noticeList');
const noticeDetail    = document.getElementById('noticeDetail');
const noticeBack      = document.getElementById('noticeBack');
const noticeDetailTitle = document.getElementById('noticeDetailTitle');
const noticeDetailBody  = document.getElementById('noticeDetailBody');
const noticePagination  = document.getElementById('noticePagination');

let noticePage = 1;
let noticeTotalPages = 1;
let readIds = new Set();
let preloadedFirstPage = null; // 페이지 로드 시 미리 받아둔 1페이지 (모달 즉시 표시용)

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function initNotices() {
  const { readNoticeIds = [] } = await chrome.storage.local.get('readNoticeIds');
  readIds = new Set(readNoticeIds);
  try {
    const res = await fetch(`${API_BASE}/notices?page=1`);
    if (!res.ok) return;
    const data = await res.json();
    preloadedFirstPage = data; // 모달 오픈 시 즉시 표시용 프리로드
    const hasUnread = data.notices.some(n => !readIds.has(String(n.id)));
    noticeBadge.style.display = hasUnread ? 'flex' : 'none';
  } catch { /* 네트워크 오류는 조용히 무시 */ }
}

function renderNoticeItems(notices) {
  if (!notices.length) {
    noticeList.innerHTML = '<li style="padding:24px;text-align:center;color:#aaa;list-style:none;">공지사항이 없습니다.</li>';
    return;
  }
  noticeList.innerHTML = notices.map(n => {
    const isRead = readIds.has(String(n.id));
    const date = String(n.created_at || '').slice(0, 10);
    return `<li class="notice-item ${isRead ? 'read' : 'unread'}" data-id="${n.id}">
      <span class="notice-item-title">${escapeHtml(n.title)}</span>
      <span class="notice-item-date">${date}</span>
    </li>`;
  }).join('');
  noticeList.querySelectorAll('.notice-item').forEach(el => {
    el.addEventListener('click', () => openNoticeDetail(el.dataset.id));
  });
}

async function loadNoticeList(page = 1) {
  noticeDetail.style.display = 'none';
  noticeList.style.display = '';
  noticePagination.style.display = '';

  // 프리로드된 1페이지가 있으면 즉시 표시, 없으면 로딩 표시
  if (page === 1 && preloadedFirstPage) {
    noticePage = 1;
    noticeTotalPages = preloadedFirstPage.totalPages || 1;
    renderNoticeItems(preloadedFirstPage.notices);
    renderNoticePagination();
    return;
  }
  noticeList.innerHTML = '<li style="padding:24px;text-align:center;color:#aaa;list-style:none;">로딩 중...</li>';

  try {
    const res = await fetch(`${API_BASE}/notices?page=${page}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    noticePage = page;
    noticeTotalPages = data.totalPages || 1;
    if (page === 1) preloadedFirstPage = data;
    renderNoticeItems(data.notices);
    renderNoticePagination();
  } catch {
    noticeList.innerHTML = '<li style="padding:24px;text-align:center;color:#f87171;list-style:none;">불러오기 실패</li>';
  }
}

async function openNoticeDetail(id) {
  noticeList.style.display = 'none';
  noticePagination.style.display = 'none';
  noticeDetail.style.display = '';
  noticeDetailTitle.textContent = '로딩 중...';
  noticeDetailBody.textContent = '';

  try {
    const res = await fetch(`${API_BASE}/notices/${id}`);
    if (!res.ok) throw new Error();
    const notice = await res.json();
    noticeDetailTitle.textContent = notice.title;
    noticeDetailBody.textContent = notice.body;

    readIds.add(String(id));
    await chrome.storage.local.set({ readNoticeIds: [...readIds] });
    await initNotices();
  } catch {
    noticeDetailTitle.textContent = '불러오기 실패';
  }
}

function renderNoticePagination() {
  if (noticeTotalPages <= 1) { noticePagination.innerHTML = ''; return; }
  noticePagination.innerHTML = `
    <button class="notice-page-btn" id="noticePrev" ${noticePage <= 1 ? 'disabled' : ''}>← 이전</button>
    <span>${noticePage} / ${noticeTotalPages}</span>
    <button class="notice-page-btn" id="noticeNext" ${noticePage >= noticeTotalPages ? 'disabled' : ''}>다음 →</button>
  `;
  noticePagination.querySelector('#noticePrev')?.addEventListener('click', () => loadNoticeList(noticePage - 1));
  noticePagination.querySelector('#noticeNext')?.addEventListener('click', () => loadNoticeList(noticePage + 1));
}

btnNotice.addEventListener('click', () => {
  noticeModal.style.display = 'flex';
  loadNoticeList(1);
});
noticeClose.addEventListener('click', () => { noticeModal.style.display = 'none'; });
noticeBack.addEventListener('click', () => { loadNoticeList(noticePage); });
noticeModal.addEventListener('click', e => { if (e.target === noticeModal) noticeModal.style.display = 'none'; });

initNotices();

// ── 문의하기 — 외부 폼 이동 전 확인 ──────────────────────────────────────────
document.getElementById('btnFeedback').addEventListener('click', (e) => {
  e.preventDefault();
  if (confirm('문의 페이지(Google Forms)로 이동할까요?')) {
    chrome.tabs.create({ url: 'https://forms.gle/yQkUQJJW3eX2A8AeA' });
  }
});

// ── 친구 추천 ─────────────────────────────────────────────────────────────────
async function renderReferral() {
  const box = document.getElementById('referralBody');
  if (!box) return;
  let res;
  try { res = await chrome.runtime.sendMessage({ type: 'GET_REFERRAL' }); }
  catch { box.textContent = t('refLoadFail'); return; }

  const r = res?.referral;
  if (!r || !r.referral_code) {
    box.textContent = t('refLoginNeeded');
    return;
  }
  const link = `${PAYMENT_URL}?ref=${encodeURIComponent(r.referral_code)}`;

  // 미연결 시에만 "추천 코드 입력" 노출 — 링크를 놓친 피추천인이 코드로 직접 연결
  const applyBlock = r.referred
    ? `<div style="margin-top:12px; font-size:12px; color:var(--text-secondary);">${t('refConnected')}</div>`
    : `<div style="margin-top:12px;">
         <div style="margin-bottom:6px; font-size:12px; color:var(--text-secondary);">${t('refPrompt')}</div>
         <div style="display:flex; gap:6px;">
           <input id="refCodeInput" aria-label="${t('refCodePh')}" placeholder="${t('refCodePh')}"
                  style="flex:1; min-width:0; padding:8px 10px; font-size:13px; border:1px solid var(--border); border-radius:6px; background:#fff; color:var(--text);">
           <button id="btnApplyRef" type="button"
                   style="padding:8px 16px; border:none; border-radius:6px; background:var(--primary); color:#fff; font-weight:600; cursor:pointer; white-space:nowrap;">${t('refConnect')}</button>
         </div>
         <div id="refApplyMsg" style="margin-top:6px; font-size:12px; min-height:1em;"></div>
       </div>`;

  box.innerHTML = `
    <div style="margin-bottom:6px;">${t('refMyLink')}</div>
    <div style="display:flex; gap:6px;">
      <input id="refLink" aria-label="${t('refMyLink')}" readonly
             style="flex:1; min-width:0; padding:8px 10px; font-size:13px; border:1px solid var(--border); border-radius:6px; background:#fff; color:var(--text);">
      <button id="btnCopyRef" type="button"
              style="padding:8px 16px; border:none; border-radius:6px; background:var(--primary); color:#fff; font-weight:600; cursor:pointer; white-space:nowrap;">${t('refCopy')}</button>
    </div>
    <div style="margin-top:10px; display:flex; gap:18px;">
      <div>${t('refEarnedLabel')} <strong>${(r.total_earned || 0).toLocaleString()} ${t('creditsUnit')}</strong></div>
      <div title="${t('refTooltip')}">${t('refPeopleLabel')} <strong>${r.referee_count || 0}${t('refPeopleUnit')}</strong> <span style="color:var(--text-secondary); cursor:help;">ⓘ</span></div>
    </div>
    ${applyBlock}`;
  document.getElementById('refLink').value = link; // 값은 DOM 속성으로(HTML 주입 회피)
  document.getElementById('btnCopyRef').addEventListener('click', () => {
    const el = document.getElementById('refLink');
    el.select();
    navigator.clipboard?.writeText(el.value).catch(() => {});
    const b = document.getElementById('btnCopyRef');
    b.textContent = t('refCopied'); setTimeout(() => { b.textContent = t('refCopy'); }, 1500);
  });

  const btnApply = document.getElementById('btnApplyRef');
  if (btnApply) {
    btnApply.addEventListener('click', async () => {
      const input = document.getElementById('refCodeInput');
      const msg = document.getElementById('refApplyMsg');
      const code = (input.value || '').trim();
      if (!code) { msg.style.color = '#d32f2f'; msg.textContent = t('refEnterCode'); return; }
      btnApply.disabled = true; msg.style.color = 'var(--text-secondary)'; msg.textContent = t('refConnecting');
      let resp;
      try { resp = await chrome.runtime.sendMessage({ type: 'APPLY_REFERRAL', code }); }
      catch { resp = { ok: false, error: 'NETWORK' }; }
      btnApply.disabled = false;
      if (resp?.ok) {
        msg.style.color = '#2e7d32'; msg.textContent = t('refConnectedMsg');
        setTimeout(renderReferral, 1200); // 재조회 → 입력창 숨김
        return;
      }
      const errMap = {
        ALREADY_SET:       t('refErrAlready'),
        INVALID_CODE:      t('refErrInvalid'),
        SELF_REFERRAL:     t('refErrSelf'),
        CIRCULAR_REFERRAL: t('refErrCircular'),
        MISSING_CODE:      t('refEnterCode'),
      };
      msg.style.color = '#d32f2f';
      msg.textContent = errMap[resp?.error] || t('refFail');
    });
  }
}

// ── 소스 언어 빌드 ────────────────────────────────────────────────────────────
function buildSourceLang(selected) {
  sourceLang.innerHTML = `<option value="auto">${t('sourceAuto')}</option>`;
  TARGET_LANGUAGES.forEach(({ code, name, nativeName }) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${nativeName} (${name})`;
    sourceLang.appendChild(opt);
  });
  sourceLang.value = selected || 'auto';
}

// ── 언어 그리드 빌드 ──────────────────────────────────────────────────────────
function buildLangGrid() {
  langGrid.innerHTML = '';
  // 15개 언어는 도달 순 평면 목록으로 표시 (지역 그룹은 소그룹이 많아져 제거)
  TARGET_LANGUAGES.forEach(({ code, name, nativeName }) => {
    const item = document.createElement('label');
    item.className = 'lang-item' + (selectedLangs.has(code) ? ' selected' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedLangs.has(code);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'lang-name';
    nameSpan.innerHTML = `${nativeName}<span class="lang-native">${name}</span>`;

    item.appendChild(cb);
    item.appendChild(nameSpan);

    item.addEventListener('click', (e) => {
      e.preventDefault();
      toggleLang(code);
    });

    langGrid.appendChild(item);
  });
}

const LANG_NOTICE_DEFAULT = '✅ 선택한 언어로 자막·제목·설명을 번역합니다. 영상의 기본 언어는 자동으로 제외됩니다.';
let langNoticeTimer = null;
// 언어 그리드 상단 안내를 잠시 경고 문구로 바꿨다가 원복 (최소 1개 규칙 안내)
function flashLangNotice(msg) {
  const el = document.getElementById('langNotice');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('notice-warn');
  clearTimeout(langNoticeTimer);
  langNoticeTimer = setTimeout(() => {
    el.textContent = LANG_NOTICE_DEFAULT;
    el.classList.remove('notice-warn');
  }, 2600);
}

function toggleLang(code) {
  if (selectedLangs.has(code)) {
    if (selectedLangs.size === 1) { flashLangNotice('⚠️ 최소 1개 언어는 선택되어 있어야 합니다.'); return; }
    selectedLangs.delete(code);
  } else {
    selectedLangs.add(code);
  }
  buildLangGrid();
}

btnSelectAll.addEventListener('click', () => {
  TARGET_LANGUAGES.forEach(l => selectedLangs.add(l.code));
  buildLangGrid();
});

btnDeselectAll.addEventListener('click', () => {
  selectedLangs.clear();
  selectedLangs.add(TARGET_LANGUAGES[0].code);
  buildLangGrid();
});

// ── 설정 로드 ─────────────────────────────────────────────────────────────────
async function init() {
  applyI18n(document); // 정적 UI 문자열을 브라우저 언어로 치환 (미지원 언어는 영어 폴백)
  const settings = await loadSettings();

  // 웰컴 카드
  if (settings.welcomeDismissed) {
    welcomeCard.style.display = 'none';
  }

  // 언어
  selectedLangs = new Set(settings.targetLangs || []);

  buildSourceLang(settings.sourceLang);
  buildLangGrid();
  renderReferral();

  // 번역 대상
  translateSubtitlesCb.checked = settings.translateSubtitles !== false;
  translateTitleCb.checked     = !!settings.translateTitle;
  translateDescCb.checked      = !!settings.translateDescription;

  fetchCreditBalance();
  checkAdminStatus();
}

// ── 저장 ──────────────────────────────────────────────────────────────────────
btnSave.addEventListener('click', async () => {
  if (selectedLangs.size === 0) {
    showStatus(t('langMinNotice'), 'error');
    return;
  }

  const settings = await loadSettings();
  const updated = {
    ...settings,
    translationMode:      TRANSLATION_MODES.CREDITS,
    sourceLang:           sourceLang.value,
    targetLangs:          Array.from(selectedLangs),
    translateSubtitles:   translateSubtitlesCb.checked,
    translateTitle:       translateTitleCb.checked,
    translateDescription: translateDescCb.checked,
  };

  await saveSettings(updated);
  showStatus(t('savedMsg'), 'ok');
});

document.getElementById('btnCloseOptions').addEventListener('click', () => window.close());

function showStatus(msg, type) {
  saveStatus.textContent = msg;
  saveStatus.style.color = type === 'error' ? '#d32f2f' : '';
  saveStatus.classList.add('visible');
  setTimeout(() => {
    saveStatus.classList.remove('visible');
    saveStatus.textContent = '';
    saveStatus.style.color = '';
  }, 2500);
}

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
