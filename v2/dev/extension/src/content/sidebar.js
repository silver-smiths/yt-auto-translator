import { MSG, PAYMENT_URL, API_BASE, TARGET_LANGUAGES } from '../lib/constants.js';
import { loadSettings } from '../lib/storage.js';

// ── 인라인 CSS (Shadow DOM 내부) ──────────────────────────────────────────────
const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:host {
  position: fixed;
  top: 0; right: 0;
  height: 100%;
  z-index: 2147483647;
  font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Noto Sans KR', sans-serif;
  font-size: 12px;
}

/* ── 접힌 탭 ── */
.toggle-tab {
  position: absolute; top: 50%; transform: translateY(-50%);
  right: 0; width: 36px; height: 44px;
  background: #121212; border: none;
  border-radius: 8px 0 0 8px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  box-shadow: -2px 0 8px rgba(0,0,0,0.3); z-index: 1;
}
.toggle-tab img { width: 22px; height: 22px; border-radius: 4px; }
.toggle-tab .tab-fallback { color: #BB86FC; font-size: 16px; font-weight: 700; }

/* ── 사이드바 ── */
.sidebar {
  position: absolute; top: 0; right: 0;
  width: 260px; height: 100%;
  background: #121212; color: rgba(255,255,255,0.87);
  display: flex; flex-direction: column;
  border-left: 1px solid rgba(255,255,255,0.08);
  transition: transform 0.2s ease;
}
.sidebar.collapsed { transform: translateX(260px); }

/* ── 헤더 ── */
.s-header {
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex; justify-content: space-between; align-items: center;
  flex-shrink: 0;
}
.s-header-left { display: flex; align-items: center; gap: 8px; }
.s-logo { width: 22px; height: 22px; border-radius: 5px; }
.s-logo-fallback { color: #BB86FC; font-size: 16px; font-weight: 700; }
.s-title { font-size: 13px; font-weight: 600; }
.s-close {
  background: none; border: none;
  color: rgba(255,255,255,0.35); font-size: 18px;
  cursor: pointer; line-height: 1; padding: 2px 4px;
}
.s-close:hover { color: rgba(255,255,255,0.7); }

/* ── 공지 배너 ── */
.s-quota-banner {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 8px 14px; flex-shrink: 0;
  background: rgba(255,193,7,0.08);
  border-bottom: 1px solid rgba(255,193,7,0.2);
  font-size: 11px; line-height: 1.5;
  color: rgba(255,255,255,0.75);
}
.s-quota-banner .banner-icon { flex-shrink: 0; }

/* ── 모드 스트립 ── */
.s-mode-strip {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; flex-shrink: 0; height: 38px;
}
.s-mode-strip.apikey {
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.s-mode-strip.credits {
  background: rgba(6,95,212,0.12);
  border-bottom: 1px solid rgba(6,95,212,0.2);
}
.s-mode-strip.credits.low {
  background: rgba(255,107,107,0.1);
  border-bottom: 1px solid rgba(255,107,107,0.2);
}
.strip-left { display: flex; align-items: center; gap: 5px; }
.strip-dot { width: 6px; height: 6px; border-radius: 50%; }
.apikey .strip-dot { background: #888; }
.credits .strip-dot { background: #4da3ff; }
.credits.low .strip-dot { background: #ff6b6b; }
.strip-label { font-size: 11px; color: rgba(255,255,255,0.4); }
.credits.low .strip-label { color: #ff8a8a; }
.strip-value { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.55); }
.credits .strip-value { font-size: 13px; font-weight: 700; color: #4da3ff; }
.credits.low .strip-value { color: #ff6b6b; }
.strip-btn {
  font-size: 11px; color: #4da3ff;
  background: none; border: 1px solid rgba(77,163,255,0.3);
  border-radius: 4px; padding: 2px 8px; cursor: pointer;
}
.credits.low .strip-btn { color: #ff6b6b; border-color: rgba(255,107,107,0.3); }

/* ── 컨트롤 ── */
.s-control {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex; gap: 8px; flex-shrink: 0;
}
.btn-start {
  flex: 1; padding: 9px 12px;
  background: #BB86FC; color: #000;
  border: none; border-radius: 7px;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-start:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-stop {
  flex: 1; padding: 9px 12px;
  background: #CF6679; color: #fff;
  border: none; border-radius: 7px;
  font-size: 12px; font-weight: 600; cursor: pointer;
}

/* ── 진행 바 ── */
.s-progress {
  padding: 10px 14px;
  background: #1E1E1E;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.s-progress-info {
  display: flex; justify-content: space-between;
  font-size: 11px; margin-bottom: 7px;
  color: rgba(255,255,255,0.5);
}
.s-bar-bg { height: 5px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
.s-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg,#BB86FC,#03DAC6); transition: width 0.3s; }

/* ── 로딩 스피너 ── */
@keyframes spin { to { transform: rotate(360deg); } }
.spinner {
  display: inline-block;
  width: 10px; height: 10px;
  border: 1.5px solid rgba(187,134,252,0.3);
  border-top-color: #BB86FC;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 5px;
  vertical-align: middle;
  flex-shrink: 0;
}
.s-progress-label {
  display: flex; align-items: center;
}

@keyframes bar-sweep {
  0%   { background-position: 200% 0; }
  100% { background-position: -100% 0; }
}
.s-bar-fill.running {
  min-width: 6%;
  background: linear-gradient(90deg, #6B3FBF, #BB86FC, #03DAC6, #BB86FC, #6B3FBF);
  background-size: 300% 100%;
  animation: bar-sweep 2s linear infinite;
  transition: none;
}

/* ── 언어 칩 ── */
.s-chips {
  padding: 8px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0;
}
.chip { padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
.chip.pending { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.35); }
.chip.active  { background: rgba(187,134,252,0.2); color: #BB86FC; }
.chip.done    { background: rgba(3,218,198,0.15); color: #03DAC6; }

/* ── 로그 피드 ── */
.s-logs { flex: 1; padding: 10px; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; }

.log-card {
  border-radius: 7px; padding: 8px 10px;
  border-left: 3px solid; flex-shrink: 0;
}
.log-card.info    { background: rgba(255,255,255,0.03); border-color: #BB86FC; }
.log-card.success { background: rgba(255,255,255,0.03); border-color: #03DAC6; }
.log-card.error   { background: rgba(255,255,255,0.03); border-color: #CF6679; }
.log-card.upsell  { background: rgba(3,218,198,0.07);   border-color: #03DAC6; }
.log-card.onboard-welcome { background: rgba(187,134,252,0.08); border-color: #BB86FC; }
.log-card.onboard-credits {
  background: linear-gradient(135deg, rgba(3,218,198,0.08), rgba(6,95,212,0.10));
  border-color: #03DAC6;
}

.log-top  { display: flex; justify-content: space-between; margin-bottom: 3px; }
.log-type { font-size: 9px; font-weight: 700; letter-spacing: 0.5px; }
.log-time { font-size: 9px; color: rgba(255,255,255,0.3); }
.log-msg  { font-size: 11px; color: rgba(255,255,255,0.7); line-height: 1.5; }
.log-cta  { margin-top: 6px; font-size: 11px; color: #03DAC6; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.log-dismiss {
  font-size: 9px; color: rgba(255,255,255,0.3);
  cursor: pointer; background: none; border: none; padding: 0;
}
.log-dismiss:hover { color: rgba(255,255,255,0.6); }

.credit-feature-row { display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; }
.credit-feature-icon { font-size: 11px; flex-shrink: 0; margin-top: 1px; }
.credit-feature-text { font-size: 11px; color: rgba(255,255,255,0.65); line-height: 1.4; }
.credit-feature-text strong { color: #03DAC6; }

/* ── 푸터 ── */
.s-footer {
  padding: 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex; justify-content: center; flex-shrink: 0;
}
.btn-settings {
  background: none; border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.45); border-radius: 5px;
  padding: 5px 16px; font-size: 11px; cursor: pointer;
}
.btn-settings:hover { background: rgba(255,255,255,0.06); }

/* ── 크레딧 모드 알아보기 패널 ── */
.credit-info-panel {
  position: absolute; bottom: 0; left: 0; right: 0;
  height: 82%;
  background: #1a1a2e;
  border-top: 1px solid rgba(77,163,255,0.3);
  border-radius: 10px 10px 0 0;
  display: flex; flex-direction: column;
  z-index: 20;
}
.cip-handle {
  width: 32px; height: 3px; background: rgba(255,255,255,0.15);
  border-radius: 2px; margin: 8px auto 0;
}
.cip-header {
  padding: 10px 14px;
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.cip-title { font-size: 13px; font-weight: 700; color: #4da3ff; }
.cip-close { background: none; border: none; color: rgba(255,255,255,0.3); font-size: 18px; cursor: pointer; line-height: 1; }
.cip-body { flex: 1; padding: 10px 14px; overflow: hidden; display: flex; flex-direction: column; gap: 8px; }
.cip-compare {
  background: rgba(255,255,255,0.03); border-radius: 8px; overflow: hidden;
  border: 1px solid rgba(255,255,255,0.06);
}
.cip-compare-head {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  padding: 7px 10px;
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cip-compare-head span { font-size: 10px; font-weight: 700; letter-spacing: 0.3px; color: rgba(255,255,255,0.4); text-align: center; }
.cip-compare-head span:first-child { text-align: left; }
.cip-compare-head .col-credit { color: #4da3ff; }
.cip-compare-row {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  padding: 7px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  align-items: center;
}
.cip-compare-row:last-child { border-bottom: none; }
.cip-compare-row span { font-size: 11px; text-align: center; }
.row-label { text-align: left !important; color: rgba(255,255,255,0.4); font-size: 10px !important; }
.val-poor { color: rgba(255,255,255,0.3); }
.val-good { color: #03DAC6; font-weight: 700; }
.cip-note { font-size: 10px; color: rgba(255,255,255,0.3); line-height: 1.5; }
.cip-cta-wrap { padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
.cip-cta-btn {
  width: 100%; padding: 10px;
  background: #4da3ff; color: #fff;
  border: none; border-radius: 7px;
  font-size: 12px; font-weight: 700; cursor: pointer;
}
`;

// ── 상태 ──────────────────────────────────────────────────────────────────────
let shadow = null;
let isCollapsed = false;
let isRunning = false;
let settings = null;
let creditBalance = null;
let langChipState = {}; // code → 'pending'|'active'|'done'
let visibilityListenerAttached = false;

// ── 진입점 ────────────────────────────────────────────────────────────────────
export async function mount() {
  if (document.getElementById('ytat-sidebar-root')) return;

  settings = await loadSettings();

  const root = document.createElement('div');
  root.id = 'ytat-sidebar-root';
  document.body.appendChild(root);

  shadow = root.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  renderToggleTab();
  renderSidebar();
  loadCreditBalance();
  setupMessageListener();
  loadLogHistory(); // 이전 번역 기록 복원

  // 충전 탭에서 돌아왔을 때 잔액 자동 갱신
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      // 익스텐션 리로드로 컨텍스트가 무효화된 경우 (chrome.runtime.id 소멸) 조용히 무시
      if (!chrome.runtime?.id) return;
      if (document.visibilityState === 'visible' && !isRunning) loadCreditBalance();
    });
  }
}

// ── 접기 탭 ───────────────────────────────────────────────────────────────────
function renderToggleTab() {
  const tab = document.createElement('button');
  tab.className = 'toggle-tab';
  tab.title = 'YouTube 번역 AI 열기';
  tab.style.display = 'none'; // 처음엔 숨김 (sidebar 표시 중)

  const logoUrl = chrome.runtime.getURL('assets/icons/icon48.png');
  tab.innerHTML = `<img src="${logoUrl}" alt="YTAT" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="tab-fallback" style="display:none">T</span>`;
  tab.addEventListener('click', expand);

  shadow.appendChild(tab);
}

function collapse() {
  isCollapsed = true;
  shadow.querySelector('.sidebar').classList.add('collapsed');
  shadow.querySelector('.toggle-tab').style.display = 'flex';
}

function expand() {
  isCollapsed = false;
  shadow.querySelector('.sidebar').classList.remove('collapsed');
  shadow.querySelector('.toggle-tab').style.display = 'none';
}

// ── 사이드바 HTML ─────────────────────────────────────────────────────────────
function renderSidebar() {
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = buildSidebarHTML();
  shadow.appendChild(sidebar);
  bindSidebarEvents(sidebar);
  renderOnboardingCards();
  updateModeStrip();
}

function buildSidebarHTML() {
  const logoUrl = chrome.runtime.getURL('assets/icons/icon48.png');
  return `
    <div class="s-header">
      <div class="s-header-left">
        <img class="s-logo" src="${logoUrl}" alt="YTAT"
          onerror="this.style.display='none';this.nextElementSibling.style.display=''">
        <span class="s-logo-fallback" style="display:none">T</span>
        <span class="s-title">YouTube 번역 AI</span>
      </div>
      <button class="s-close" id="btn-close">&times;</button>
    </div>

    <div class="s-quota-banner" id="quota-banner">
      <span class="banner-icon">⏳</span>
      <span>YouTube 측의 API 일일 한도 상향 승인을 기다리고 있습니다. 한도 초과 시 번역 결과는 저장되며, 다음 날 다시 시작하면 추가 비용 없이 자동 등록됩니다.</span>
    </div>

    <div class="s-mode-strip" id="mode-strip">
      <div class="strip-left">
        <div class="strip-dot"></div>
        <span class="strip-label" id="strip-label">번역 방식</span>
        <span class="strip-value" id="strip-value">내 API 키</span>
      </div>
      <button class="strip-btn" id="btn-topup" style="display:none">충전</button>
    </div>

    <div class="s-control">
      <button class="btn-start" id="btn-translate">▶&nbsp; 번역 시작</button>
    </div>

    <div class="s-progress" id="progress-section" style="display:none">
      <div class="s-progress-info">
        <span class="s-progress-label">
          <span class="spinner" id="progress-spinner" style="display:none"></span>
          <span id="progress-label">번역 진행률</span>
        </span>
        <span id="progress-pct">0%</span>
      </div>
      <div class="s-bar-bg"><div class="s-bar-fill" id="progress-bar" style="width:0%"></div></div>
    </div>

    <div class="s-chips" id="chips-section" style="display:none"></div>

    <div class="s-logs" id="log-feed"></div>
    <div class="s-logs" id="onboard-feed" style="padding-top:0"></div>

    <div class="s-footer">
      <button class="btn-settings" id="btn-settings">⚙️ 설정</button>
    </div>

    <div class="credit-info-panel" id="credit-info-panel" style="display:none">
      <div class="cip-handle"></div>
      <div class="cip-header">
        <span class="cip-title">⚡ 크레딧 모드란?</span>
        <button class="cip-close" id="btn-cip-close">&times;</button>
      </div>
      <div class="cip-body">
        <div class="cip-compare">
          <div class="cip-compare-head">
            <span></span>
            <span>내 API 키</span>
            <span class="col-credit">크레딧</span>
          </div>
          <div class="cip-compare-row">
            <span class="row-label">번역 속도</span>
            <span class="val-poor">느림</span>
            <span class="val-good">⚡ 최대</span>
          </div>
          <div class="cip-compare-row">
            <span class="row-label">동시 번역</span>
            <span class="val-poor">1개</span>
            <span class="val-good">🌍 26개</span>
          </div>
          <div class="cip-compare-row">
            <span class="row-label">API 키</span>
            <span class="val-poor">필요</span>
            <span class="val-good">✅ 불필요</span>
          </div>
        </div>
        <div class="cip-note">크레딧은 선불 충전 방식이며 만료되지 않습니다.</div>
      </div>
      <div class="cip-cta-wrap">
        <button class="cip-cta-btn" id="btn-cip-topup">크레딧 충전하기 →</button>
      </div>
    </div>
  `;
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindSidebarEvents(sidebar) {
  sidebar.querySelector('#btn-close').addEventListener('click', collapse);

  sidebar.querySelector('#btn-translate').addEventListener('click', () => {
    if (isRunning) {
      chrome.runtime.sendMessage({ type: MSG.STOP_TRANSLATION });
    } else {
      startTranslation();
    }
  });

  sidebar.querySelector('#btn-topup').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: PAYMENT_URL });
  });

  sidebar.querySelector('#btn-settings').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  sidebar.querySelector('#btn-cip-close').addEventListener('click', () => {
    shadow.getElementById('credit-info-panel').style.display = 'none';
  });

  sidebar.querySelector('#btn-cip-topup').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: PAYMENT_URL });
  });
}

// ── 모드 스트립 업데이트 ──────────────────────────────────────────────────────
function updateModeStrip() {
  const strip    = shadow.getElementById('mode-strip');
  const label    = shadow.getElementById('strip-label');
  const value    = shadow.getElementById('strip-value');
  const btnTopup = shadow.getElementById('btn-topup');
  const btnTrans = shadow.getElementById('btn-translate');

  const balance = creditBalance ?? 0;
  const isLow = balance < 0.5;

  strip.className = `s-mode-strip credits${isLow ? ' low' : ''}`;
  label.textContent = isLow ? '크레딧 부족' : '크레딧';
  value.textContent = creditBalance != null ? `$${(Math.floor(balance * 100) / 100).toFixed(2)}` : '로딩 중...';
  btnTopup.style.display = 'block';
  // 버튼은 잠그지 않음 — 저장된 번역 재업로드는 크레딧 없이 가능하고,
  // 실제 부족 여부는 시작 시 SW가 판단해 상황별 안내를 표시함
  btnTrans.disabled = false;
}

// ── 크레딧 잔액 조회 ──────────────────────────────────────────────────────────
async function loadCreditBalance() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GET_CREDITS' });
  } catch (err) {
    // 컨텍스트 무효화(익스텐션 리로드)는 조용히 무시 — 페이지 새로고침 시 정상화
    if (err?.message?.includes('context invalidated')) return;
    res = { error: err.message };
  }
  if (res?.error) {
    console.error('[YTAT] 크레딧 조회 실패:', res.error);
    addLog('error', 'ERROR', `크레딧 조회 실패: ${res.error}`);
  }
  creditBalance = res?.balance ?? null;
  updateModeStrip();
}

// ── 온보딩 카드 ───────────────────────────────────────────────────────────────
const ONBOARD_CARDS = [
  {
    id: 'welcome',
    cls: 'onboard-welcome',
    typeColor: '#BB86FC',
    typeLabel: '📌 공지',
    msg: '자막 자동 번역&등록기에 오신 걸 환영합니다 🎉',
  },
  {
    id: 'howto',
    cls: 'info',
    typeColor: '#BB86FC',
    typeLabel: '📌 공지',
    msg: '영상 수정 페이지에서 <strong style="color:rgba(255,255,255,0.9)">▶ 번역 시작</strong> 버튼을 누르면 선택한 언어로 자막이 자동 번역·등록됩니다.',
  },
  {
    id: 'settings',
    cls: 'info',
    typeColor: '#BB86FC',
    typeLabel: '📌 공지',
    msg: '먼저 <strong style="color:rgba(255,255,255,0.9)">⚙️ 설정</strong>에서 번역 언어를 선택하고 크레딧을 충전하세요.',
  },
];

async function renderOnboardingCards() {
  const result = await new Promise(r => chrome.storage.local.get('dismissedCards', r));
  const dismissed = new Set(result.dismissedCards || []);

  const feed = shadow.getElementById('onboard-feed');
  for (const card of ONBOARD_CARDS) {
    if (dismissed.has(card.id)) continue;
    feed.appendChild(buildOnboardCard(card));
  }
}

function buildOnboardCard(card) {
  const el = document.createElement('div');
  el.className = `log-card ${card.cls}`;
  el.dataset.cardId = card.id;

  el.innerHTML = `
    <div class="log-top">
      <span class="log-type" style="color:${card.typeColor}">${card.typeLabel}</span>
      <button class="log-dismiss">× 닫기</button>
    </div>
    <div class="log-msg">${card.msg}</div>
  `;

  el.querySelector('.log-dismiss').addEventListener('click', () => {
    dismissCard(card.id, el);
  });

  return el;
}

async function dismissCard(id, el) {
  el.remove();
  const result = await new Promise(r => chrome.storage.local.get('dismissedCards', r));
  const dismissed = result.dismissedCards || [];
  if (!dismissed.includes(id)) {
    await new Promise(r => chrome.storage.local.set({ dismissedCards: [...dismissed, id] }, r));
  }
}

// ── 번역 시작 ─────────────────────────────────────────────────────────────────
function startTranslation() {
  chrome.runtime.sendMessage({ type: MSG.START_TRANSLATION, settings });
}

// ── 번역 상태 UI ──────────────────────────────────────────────────────────────
function setRunning(running, targetLangs = []) {
  isRunning = running;
  const btn = shadow.getElementById('btn-translate');
  const progressSection = shadow.getElementById('progress-section');
  const chipsSection = shadow.getElementById('chips-section');

  const bar     = shadow.getElementById('progress-bar');
  const spinner = shadow.getElementById('progress-spinner');
  const label   = shadow.getElementById('progress-label');

  if (running) {
    btn.className = 'btn-stop';
    btn.innerHTML = '■&nbsp; 번역 중지';
    progressSection.style.display = 'block';
    chipsSection.style.display = 'flex';
    bar.classList.add('running');
    bar.style.width = '0%';
    if (spinner) spinner.style.display = 'inline-block';
    if (label)   label.textContent = '번역 처리 중...';

    langChipState = {};
    targetLangs.forEach(code => { langChipState[code] = 'pending'; });
    buildChipLabels(targetLangs);
    renderChips();
  } else {
    btn.className = 'btn-start';
    btn.innerHTML = '▶&nbsp; 번역 시작';
    progressSection.style.display = 'none';
    chipsSection.style.display = 'none';
    bar.classList.remove('running');
    if (spinner) spinner.style.display = 'none';
    if (label)   label.textContent = '번역 진행률';
    langChipState = {};
  }
}

// code → nativeName 매핑 캐시
const chipLabels = {};
function buildChipLabels(codes) {
  codes.forEach(code => {
    const lang = TARGET_LANGUAGES.find(l => l.code === code);
    chipLabels[code] = lang ? lang.nativeName : code;
  });
}

function renderChips() {
  const section = shadow.getElementById('chips-section');
  section.innerHTML = '';
  Object.entries(langChipState).forEach(([code, state]) => {
    const chip = document.createElement('span');
    chip.className = `chip ${state}`;
    chip.textContent = chipLabels[code] || code;
    section.appendChild(chip);
  });
}

function updateProgress(pct, current, total) {
  const bar     = shadow.getElementById('progress-bar');
  const pctEl   = shadow.getElementById('progress-pct');
  const label   = shadow.getElementById('progress-label');
  const spinner = shadow.getElementById('progress-spinner');

  if (pct > 0) {
    bar.classList.remove('running'); // sweep → 확정 바 전환
    bar.style.width = `${pct}%`;
  }
  pctEl.textContent = `${Math.round(pct)}%`;

  // 청크 수 표시
  if (total > 0) {
    if (label) label.textContent = `청크 ${current}/${total}`;
  }

  // 100% 완료 시 스피너 숨김
  if (pct >= 100 && spinner) spinner.style.display = 'none';
}

// ── 로그 저장/복원 ───────────────────────────────────────────────────────────
const MAX_SAVED_LOGS = 20;

async function saveLog(type, label, msg) {
  try {
    const r = await chrome.storage.local.get('sidebarLogs');
    const logs = [
      { type, label, msg, ts: new Date().toISOString() },
      ...(r.sidebarLogs || []),
    ].slice(0, MAX_SAVED_LOGS);
    await chrome.storage.local.set({ sidebarLogs: logs });
  } catch {}
}

async function loadLogHistory() {
  try {
    const r = await chrome.storage.local.get('sidebarLogs');
    const logs = r.sidebarLogs || [];
    if (!logs.length) return;

    const feed = shadow.getElementById('log-feed');
    const divider = document.createElement('div');
    divider.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.2);text-align:center;padding:4px 0;';
    divider.textContent = '── 이전 기록 ──';

    logs.forEach(({ type, label, msg, ts }) => {
      const card = document.createElement('div');
      card.className = `log-card ${type}`;
      const color = type === 'success' ? '#03DAC6' : type === 'error' ? '#CF6679' : '#BB86FC';
      const time = new Date(ts).toLocaleString('ko-KR', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      card.innerHTML = `
        <div class="log-top">
          <span class="log-type" style="color:${color}">${label}</span>
          <span class="log-time">${time}</span>
        </div>
        <div class="log-msg">${msg}</div>
      `;
      feed.appendChild(card);
    });

    feed.appendChild(divider);
  } catch {}
}

// ── 로그 카드 추가 ────────────────────────────────────────────────────────────
function addLog(type, label, msg, labelColor, persist = false) {
  const feed = shadow.getElementById('log-feed');
  const card = document.createElement('div');
  card.className = `log-card ${type}`;

  const color = labelColor || (type === 'success' ? '#03DAC6' : type === 'error' ? '#CF6679' : '#BB86FC');
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  card.innerHTML = `
    <div class="log-top">
      <span class="log-type" style="color:${color}">${label}</span>
      <span class="log-time">${time}</span>
    </div>
    <div class="log-msg">${msg}</div>
  `;

  feed.prepend(card);

  // 완료/오류 로그는 스토리지에 저장
  if (persist) saveLog(type, label, msg);
}

// ── SW 메시지 수신 ────────────────────────────────────────────────────────────
let currentMsgHandler = null;   // 재마운트 시 리스너 중복 등록 방지
let lastProgressLog   = '';     // 동일 진행 메시지 중복 로그 방지

function setupMessageListener() {
  if (currentMsgHandler) chrome.runtime.onMessage.removeListener(currentMsgHandler);

  currentMsgHandler = (msg) => {
    if (!msg?.type) return;

    switch (msg.type) {
      case MSG.TRANSLATION_PROGRESS: {
        if (!isRunning) setRunning(true, msg.targetLangs || []);
        if (msg.langDone && msg.lang) {
          langChipState[msg.lang] = 'done';
          renderChips();
        } else if (msg.lang && langChipState[msg.lang] !== 'done') {
          langChipState[msg.lang] = 'active';
          renderChips();
        }
        if (msg.percent != null) {
          updateProgress(msg.percent, msg.current, msg.total);
        } else if (msg.current != null && msg.total > 0) {
          updateProgress((msg.current / msg.total) * 100, msg.current, msg.total);
        }
        if (msg.langName) {
          const label = shadow.getElementById('progress-label');
          if (label) label.textContent = msg.langName;
          // 청크 단위 갱신·주기적 하트비트는 로그 제외 (스팸 방지)
          if (!msg.isChunkUpdate && !msg.langName.includes('경과') && msg.langName !== lastProgressLog) {
            addLog('info', 'INFO', msg.langName);
            lastProgressLog = msg.langName;
          }
        }
        break;
      }

      case MSG.TRANSLATION_COMPLETE: {
        // 완료된 언어 칩 done 처리
        Object.keys(langChipState).forEach(code => { langChipState[code] = 'done'; });
        renderChips();
        setRunning(false);
        const successCount = msg.successCount ?? 0;
        const failCount    = msg.errors?.length ?? 0;
        if (msg.allSkipped) {
          addLog('success', 'SUCCESS', '💡 선택한 언어가 모두 이미 번역되어 있어 건너뛰었습니다.', null, true);
        } else {
          addLog('success', 'SUCCESS',
            `✅ 번역 완료! ${successCount}개 언어 업로드 성공${failCount > 0 ? ` (${failCount}개 실패)` : ''}`,
            null, true  // persist
          );
        }
        loadCreditBalance();
        break;
      }

      case MSG.TRANSLATION_ERROR: {
        setRunning(false);
        const errText = msg.error || msg.message || '번역 중 오류가 발생했습니다.';
        addLog('error', 'ERROR', `❌ ${errText}`, null, true);
        if (errText.includes('크레딧')) {
          updateModeStrip();
        }
        break;
      }
    }
  };
  chrome.runtime.onMessage.addListener(currentMsgHandler);
}
