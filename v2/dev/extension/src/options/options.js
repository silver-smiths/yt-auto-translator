import {
  TARGET_LANGUAGES,
  TRANSLATION_MODES,
  API_BASE,
  PAYMENT_URL,
} from '../lib/constants.js';
import { loadSettings, saveSettings } from '../lib/storage.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const welcomeCard      = document.getElementById('welcomeCard');
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
async function fetchCreditBalance() {
  creditBalance.textContent = '로딩 중...';
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) reject(new Error('auth'));
        else resolve(token);
      });
    });

    const res = await fetch(`${API_BASE}/credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('fetch');
    const { balance } = await res.json();
    creditBalance.textContent = `${Math.round(balance || 0).toLocaleString('ko-KR')} 크레딧`;
  } catch {
    creditBalance.textContent = '조회 실패 (로그인 필요)';
  }
}

btnTopup.addEventListener('click', () => {
  chrome.tabs.create({ url: PAYMENT_URL });
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
  catch { box.textContent = '추천 정보를 불러오지 못했습니다.'; return; }

  const r = res?.referral;
  if (!r || !r.referral_code) {
    box.textContent = '로그인 후 이용할 수 있습니다. (사이드바에서 번역을 한 번 시작하면 계정·코드가 생성됩니다)';
    return;
  }
  const link = `${PAYMENT_URL}?ref=${encodeURIComponent(r.referral_code)}`;
  box.innerHTML = `
    <div style="margin-bottom:6px;">내 추천 링크</div>
    <div style="display:flex; gap:6px;">
      <input id="refLink" class="date-input" style="flex:1; min-width:0;" readonly>
      <button class="btn" id="btnCopyRef" type="button">복사</button>
    </div>
    <div style="margin-top:10px; display:flex; gap:18px;">
      <div>누적 적립 <strong>${(r.total_earned || 0).toLocaleString('ko-KR')} 크레딧</strong></div>
      <div>추천 <strong>${r.referee_count || 0}명</strong></div>
    </div>`;
  document.getElementById('refLink').value = link; // 값은 DOM 속성으로(HTML 주입 회피)
  document.getElementById('btnCopyRef').addEventListener('click', () => {
    const el = document.getElementById('refLink');
    el.select();
    navigator.clipboard?.writeText(el.value).catch(() => {});
    const b = document.getElementById('btnCopyRef');
    b.textContent = '복사됨'; setTimeout(() => { b.textContent = '복사'; }, 1500);
  });
}

// ── 소스 언어 빌드 ────────────────────────────────────────────────────────────
function buildSourceLang(selected) {
  sourceLang.innerHTML = '<option value="auto">자동 감지 (영상 기본 언어 자동 인식)</option>';
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
  let currentRegion = null;
  TARGET_LANGUAGES.forEach(({ code, name, nativeName, region }) => {
    // 지역이 바뀌면 전체 폭 헤더 + 지역 전체 선택/해제 토글 삽입
    if (region && region !== currentRegion) {
      currentRegion = region;
      const regionCodes = TARGET_LANGUAGES.filter(l => l.region === region).map(l => l.code);
      const allSelected = regionCodes.every(c => selectedLangs.has(c));

      const header = document.createElement('div');
      header.className = 'lang-region';

      const label = document.createElement('span');
      label.textContent = region;

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lang-region-toggle';
      toggle.textContent = allSelected ? '전체 해제' : '전체 선택';
      toggle.addEventListener('click', (e) => { e.preventDefault(); toggleRegion(region); });

      header.appendChild(label);
      header.appendChild(toggle);
      langGrid.appendChild(header);
    }

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

// 지역 전체 선택/해제 — 모두 선택돼 있으면 해제, 아니면 전체 선택 (최소 1개 유지)
function toggleRegion(region) {
  const codes = TARGET_LANGUAGES.filter(l => l.region === region).map(l => l.code);
  const allSelected = codes.every(c => selectedLangs.has(c));
  if (allSelected) {
    codes.forEach(c => selectedLangs.delete(c));
    if (selectedLangs.size === 0) {
      selectedLangs.add(TARGET_LANGUAGES[0].code);
      flashLangNotice('⚠️ 최소 1개 언어는 선택되어 있어야 해 영어를 유지했습니다.');
    }
  } else {
    codes.forEach(c => selectedLangs.add(c));
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
    showStatus('⚠️ 번역할 언어를 1개 이상 선택해 주세요.', 'error');
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
  showStatus('✅ 저장되었습니다!', 'ok');
});

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
