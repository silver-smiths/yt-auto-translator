import { MSG, PAYMENT_URL, TARGET_LANGUAGES } from '../lib/constants.js';
import { t } from '../lib/i18n.js';
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

/* ── 원격 배너 (kill-switch/공지 배너) ── */
.s-remote-banner {
  flex-shrink: 0; padding: 8px 14px; font-size: 11.5px; line-height: 1.45;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.s-remote-banner.info     { background: rgba(187,134,252,0.12); color: #d3b6ff; }
.s-remote-banner.warn     { background: rgba(255,183,77,0.14);  color: #ffcb70; }
.s-remote-banner.critical { background: rgba(207,102,121,0.16); color: #ff9aab; }

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

/* ── 상하 분할 섹션 (공지 / 처리 기록 — 각 영역 독립 스크롤) ── */
.s-section { display: flex; flex-direction: column; min-height: 0; }
.s-notice-section { flex: 0 1 auto; max-height: 42%; border-bottom: 1px solid rgba(255,255,255,0.08); }
.s-hist-section   { flex: 1 1 auto; }
.s-section-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 9px 12px 6px; flex-shrink: 0;
  font-size: 11px; font-weight: 700; letter-spacing: 0.3px;
  color: rgba(255,255,255,0.5);
}
.s-section-badge {
  font-size: 10px; font-weight: 700; color: #fff;
  background: #CF6679; border-radius: 99px; padding: 1px 8px;
}
.s-section-btn {
  font-size: 10px; color: rgba(255,255,255,0.4);
  background: none; border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px; padding: 3px 9px; cursor: pointer;
}
.s-section-btn:hover { color: rgba(255,255,255,0.7); border-color: rgba(255,255,255,0.2); }
.s-section-body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 2px 10px 10px; display: flex; flex-direction: column; gap: 7px;
}

/* ── 공지 카드 (목록형, 클릭 시 본문 펼침) ── */
.notice-card {
  border-radius: 8px; padding: 9px 11px; flex-shrink: 0;
  border: 1px solid; background: rgba(255,255,255,0.04);
}
.notice-card.info     { border-color: rgba(187,134,252,0.55); background: rgba(187,134,252,0.10); }
.notice-card.warn     { border-color: rgba(255,183,77,0.6);   background: rgba(255,183,77,0.12); }
.notice-card.critical { border-color: rgba(207,102,121,0.7);  background: rgba(207,102,121,0.15); }
.notice-card.read     { background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.12); }
.notice-card.read .notice-badge { opacity: 0.65; }
.notice-card.read .notice-title { color: rgba(255,255,255,0.55); }
.notice-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 4px; }
.notice-badge {
  font-size: 10px; font-weight: 700; letter-spacing: 0.3px;
  padding: 1px 7px; border-radius: 99px;
}
.notice-card.info     .notice-badge { background: rgba(187,134,252,0.25); color: #d3b6ff; }
.notice-card.warn     .notice-badge { background: rgba(255,183,77,0.25);  color: #ffcb70; }
.notice-card.critical .notice-badge { background: rgba(207,102,121,0.3);  color: #ff9aab; }
.notice-date { font-size: 10px; color: rgba(255,255,255,0.45); flex-shrink: 0; }
.notice-title {
  font-size: 12.5px; font-weight: 700; color: rgba(255,255,255,0.92);
  line-height: 1.4; cursor: pointer;
}
.notice-title::after { content: ' ⌄'; color: rgba(255,255,255,0.35); font-weight: 400; }
.notice-card.expanded .notice-title::after { content: ' ⌃'; }
.notice-body {
  font-size: 11.5px; color: rgba(255,255,255,0.82); line-height: 1.55;
  white-space: pre-wrap; margin-top: 7px;
  padding-top: 7px; border-top: 1px solid rgba(255,255,255,0.1);
}
.notice-empty { font-size: 12px; color: rgba(255,255,255,0.4); text-align: center; padding: 14px 10px; }

.log-card {
  border-radius: 7px; padding: 8px 10px;
  border-left: 3px solid; flex-shrink: 0;
}
.log-card.info    { background: rgba(255,255,255,0.03); border-color: #BB86FC; }
.log-card.success { background: rgba(255,255,255,0.03); border-color: #03DAC6; }
.log-card.error   { background: rgba(255,255,255,0.03); border-color: #CF6679; }
.log-card.stopped { background: rgba(255,255,255,0.03); border-color: #9E9E9E; }
.log-card.upsell  { background: rgba(3,218,198,0.07);   border-color: #03DAC6; }

.log-top  { display: flex; justify-content: space-between; margin-bottom: 3px; }
.log-type { font-size: 9px; font-weight: 700; letter-spacing: 0.5px; }
.log-time { font-size: 10px; color: rgba(255,255,255,0.5); }
.log-msg  { font-size: 11px; color: rgba(255,255,255,0.7); line-height: 1.5; }
.log-cta  { margin-top: 6px; font-size: 11px; color: #03DAC6; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.log-dismiss {
  font-size: 9px; color: rgba(255,255,255,0.3);
  cursor: pointer; background: none; border: none; padding: 0;
}
.log-dismiss:hover { color: rgba(255,255,255,0.6); }

/* ── 처리 이력 카드 ── */
.hist-title {
  font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.88);
  margin: 5px 0; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; /* 기본 2줄까지 표시 후 말줄임 */
}
.hist-title.clamped { cursor: pointer; }
.hist-title.clamped::after {
  content: ' ⌄'; color: rgba(255,255,255,0.35); font-weight: 400;
}
.hist-title.expanded {
  -webkit-line-clamp: unset; overflow: visible;
}
.hist-title.expanded::after { content: ' ⌃'; }
.hist-meta { font-size: 10px; color: rgba(255,255,255,0.55); margin-bottom: 5px; line-height: 1.4; }
.hist-langs { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 5px; }
.hist-lang { font-size: 10px; padding: 1px 7px; border-radius: 99px; }
.hist-lang.ok   { background: rgba(3,218,198,0.15); color: #03DAC6; }
.hist-lang.fail { background: rgba(207,102,121,0.2); color: #ff8a9b; }
.hist-lang.more { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.55); }
.hist-credit { font-size: 11px; color: rgba(255,255,255,0.6); }

/* 처리 이력 접기/펼치기 (기본 접힘, 헤더 클릭 시 펼침) */
.hist-head { cursor: pointer; }
.hist-title-row { display: flex; align-items: flex-start; gap: 5px; }
.hist-caret { font-size: 9px; color: rgba(255,255,255,0.4); margin-top: 7px; flex-shrink: 0; }
.hist-title-row .hist-title { margin: 5px 0; flex: 1; min-width: 0; }
.log-card.collapsed .hist-title { -webkit-line-clamp: 1; }        /* 접힘: 제목 1줄 */
.log-card:not(.collapsed) .hist-title { -webkit-line-clamp: unset; overflow: visible; }
.log-card.collapsed .hist-body { display: none; }
.hist-body { margin-top: 3px; }

.hist-empty {
  font-size: 12px; color: rgba(255,255,255,0.4);
  text-align: center; padding: 20px 10px;
}

.credit-feature-row { display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; }
.credit-feature-icon { font-size: 11px; flex-shrink: 0; margin-top: 1px; }
.credit-feature-text { font-size: 11px; color: rgba(255,255,255,0.65); line-height: 1.4; }
.credit-feature-text strong { color: #03DAC6; }

/* ── 푸터 ── */
.s-footer {
  padding: 8px 14px;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex; flex-direction: column; align-items: center; gap: 8px; flex-shrink: 0;
}
.s-disclaimer {
  font-size: 10px; line-height: 1.45; text-align: center;
  color: rgba(255,255,255,0.4);
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
let creditAuthNeeded = false; // 미로그인 상태(비대화형 조회 실패) — 모드 스트립에 "로그인 필요" 표시
let serviceDisabled = false;  // 원격 스위치: 번역 전체 중단
let paymentDisabled = false;  // 원격 스위치: 결제/충전 중단
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
  restoreRunningState(); // 이미 진행 중인 번역이 있으면 진행 UI 복원 ("이미 진행 중" 데드엔드 방지)
  loadRemoteConfig(); // 원격 스위치/배너 적용
  loadHistory(); // 저장된 처리 이력 복원 (최대 100건)
  loadNotices(); // 공지 영역에 공지 목록 표시 (클릭 시 본문 펼침)

  // 충전 탭에서 돌아왔을 때 잔액 자동 갱신
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      // 익스텐션 리로드로 컨텍스트가 무효화된 경우 (chrome.runtime.id 소멸) 조용히 무시
      if (!chrome.runtime?.id) return;
      if (document.visibilityState === 'visible' && !isRunning) { loadCreditBalance(); loadRemoteConfig(); }
    });

    // 설정(언어·번역 대상 등) 변경을 실시간 반영 — 옵션 페이지에서 저장 시 즉시 갱신.
    // 진행 중 번역은 시작 시점에 SW로 settings를 이미 넘겼으므로 영향 없음(다음 시작부터 적용).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings?.newValue) {
        settings = { ...settings, ...changes.settings.newValue };
      }
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
        <span class="s-title">${t('sidebarTitle')}</span>
      </div>
      <button class="s-close" id="btn-close">&times;</button>
    </div>

    <div class="s-mode-strip" id="mode-strip">
      <div class="strip-left">
        <div class="strip-dot"></div>
        <span class="strip-label" id="strip-label"></span>
        <span class="strip-value" id="strip-value"></span>
      </div>
      <button class="strip-btn" id="btn-topup" style="display:none">${t('sbTopup')}</button>
    </div>

    <div class="s-remote-banner" id="remote-banner" style="display:none"></div>

    <div class="s-control">
      <button class="btn-start" id="btn-translate">${t('sbStart')}</button>
      <button class="btn-start" id="btn-login" style="display:none">${t('sbLogin')}</button>
    </div>

    <div class="s-progress" id="progress-section" style="display:none">
      <div class="s-progress-info">
        <span class="s-progress-label">
          <span class="spinner" id="progress-spinner" style="display:none"></span>
          <span id="progress-label">${t('sidebarProgressLabel')}</span>
        </span>
        <span id="progress-pct">0%</span>
      </div>
      <div class="s-bar-bg"><div class="s-bar-fill" id="progress-bar" style="width:0%"></div></div>
    </div>

    <div class="s-chips" id="chips-section" style="display:none"></div>

    <div class="s-section s-notice-section" id="notice-section" style="display:none">
      <div class="s-section-head">
        <span>${t('sbNotice')}</span>
        <span class="s-section-badge" id="notice-unread" style="display:none"></span>
      </div>
      <div class="s-section-body" id="notice-feed"></div>
    </div>

    <div class="s-section s-hist-section">
      <div class="s-section-head">
        <span>${t('sbHistory')}</span>
        <button class="s-section-btn" id="btn-clear-hist" style="display:none">${t('sbClear')}</button>
      </div>
      <div class="s-section-body" id="log-feed"></div>
    </div>

    <div class="s-footer">
      <div class="s-disclaimer">${t('sbDisclaimer')}</div>
      <button class="btn-settings" id="btn-settings">${t('sbSettings')}</button>
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

// 확장 컨텍스트가 살아있을 때만 SW로 전송. 리로드 후 새로고침 안 한 탭에서
// sendMessage가 "Extension context invalidated"를 uncaught로 던지는 것을 방지.
function sendToSW(msg) {
  if (!chrome.runtime?.id) {
    addLog('error', 'ERROR', '확장이 업데이트되었습니다. 페이지를 새로고침(F5) 후 다시 시도해 주세요.');
    return;
  }
  try { chrome.runtime.sendMessage(msg); } catch { /* 컨텍스트 무효 — 무시 */ }
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindSidebarEvents(sidebar) {
  sidebar.querySelector('#btn-close').addEventListener('click', collapse);

  sidebar.querySelector('#btn-translate').addEventListener('click', (e) => {
    if (isRunning) {
      // 중지 즉시 피드백 — 현재 배치가 끝날 때까지 걸릴 수 있으므로 버튼을 잠그고 안내
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = t('sbStopping');
      const label = shadow.getElementById('progress-label');
      if (label) label.textContent = '현재 작업을 마무리한 뒤 중지됩니다...';
      chrome.runtime.sendMessage({ type: MSG.STOP_TRANSLATION }, () => {
        // 컨텍스트 무효(확장 리로드 등)로 전송 실패 시 버튼이 '중지 중...'에 고착되지 않도록 원복
        if (chrome.runtime.lastError) {
          btn.disabled = false;
          btn.className = 'btn-stop';
          btn.innerHTML = t('sbStop');
          addLog('error', 'ERROR', '확장이 업데이트된 것 같습니다. 페이지를 새로고침 후 다시 시도해 주세요.');
        }
      });
    } else {
      startTranslation();
    }
  });

  sidebar.querySelector('#btn-topup').addEventListener('click', () => {
    sendToSW({ type: 'OPEN_TAB', url: PAYMENT_URL });
  });

  // 명시적 로그인 — 대화형 조회로 Google 로그인창을 띄우고, 성공하면 잔액·버튼 상태 갱신
  sidebar.querySelector('#btn-login').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '로그인 중...';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'GET_CREDITS', interactive: true });
    } catch (err) {
      res = { error: err?.message || 'error' };
    }
    btn.disabled = false;
    btn.innerHTML = orig;
    if (res && !res.error && res.balance != null) {
      creditAuthNeeded = false;
      creditBalance = res.balance;
      updateModeStrip(); // 로그인 버튼 숨김 → '번역 시작' 노출
    } else {
      addLog('error', 'ERROR', '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });

  sidebar.querySelector('#btn-settings').addEventListener('click', () => {
    sendToSW({ type: 'OPEN_OPTIONS' });
  });

  sidebar.querySelector('#btn-clear-hist').addEventListener('click', () => {
    if (confirm('처리 기록을 모두 지울까요? (되돌릴 수 없습니다)')) clearHistory();
  });

  sidebar.querySelector('#btn-cip-close').addEventListener('click', () => {
    shadow.getElementById('credit-info-panel').style.display = 'none';
  });

  sidebar.querySelector('#btn-cip-topup').addEventListener('click', () => {
    sendToSW({ type: 'OPEN_TAB', url: PAYMENT_URL });
  });
}

// ── 원격 설정(kill-switch/배너) 적용 ──────────────────────────────────────────
async function loadRemoteConfig() {
  let cfg = {};
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    cfg = res?.config || {};
  } catch { /* 실패 시 기본(전부 켜짐)으로 간주 */ }

  serviceDisabled = cfg['translate.enabled'] === false;
  paymentDisabled = cfg['payment.enabled'] === false;

  // 배너: 서비스 중단이 우선, 없으면 원격 배너 메시지
  const bannerEl = shadow.getElementById('remote-banner');
  if (bannerEl) {
    let msg = '', level = 'info';
    if (serviceDisabled) { msg = '⚙️ 번역 기능이 일시 점검 중입니다.'; level = 'warn'; }
    else if (cfg.banner && cfg.banner.message) { msg = String(cfg.banner.message); level = cfg.banner.level || 'info'; }
    if (msg) {
      bannerEl.className = `s-remote-banner ${level}`;
      bannerEl.textContent = msg;
      bannerEl.style.display = '';
    } else {
      bannerEl.style.display = 'none';
    }
  }

  updateModeStrip(); // 시작/충전 버튼 상태 반영
}

// ── 모드 스트립 업데이트 ──────────────────────────────────────────────────────
function updateModeStrip() {
  const strip    = shadow.getElementById('mode-strip');
  const label    = shadow.getElementById('strip-label');
  const value    = shadow.getElementById('strip-value');
  const btnTopup = shadow.getElementById('btn-topup');
  const btnTrans = shadow.getElementById('btn-translate');
  const btnLogin = shadow.getElementById('btn-login');

  const balance = creditBalance ?? 0;
  const isLow = balance < 500; // 긴 영상 1언어(약 500 크레딧)도 애매한 수준이면 충전 유도

  // 미로그인: '번역 시작' 대신 명시적 '로그인' 버튼을 노출 (설정 화면과 동일한 흐름)
  if (creditAuthNeeded && creditBalance == null) {
    strip.className = 's-mode-strip credits';
    label.textContent = t('sbLoginNeeded');
    value.textContent = t('sbLoginFirst');
    btnTopup.style.display = 'none';
    btnTrans.style.display = 'none';
    btnLogin.style.display = 'block';
    return;
  }

  strip.className = `s-mode-strip credits${isLow ? ' low' : ''}`;
  label.textContent = isLow ? t('sbLowCredit') : t('sbCredit');
  value.textContent = creditBalance != null ? formatCredits(balance) : t('sbLoading');
  btnLogin.style.display = 'none';
  btnTrans.style.display = 'block';
  btnTopup.style.display = paymentDisabled ? 'none' : 'block';
  // 원격 스위치로 서비스 중단 시에만 잠금. 평소엔 잠그지 않음
  // (저장된 번역 재업로드는 크레딧 없이 가능하고, 실제 부족 여부는 시작 시 SW가 판단)
  btnTrans.disabled = serviceDisabled;
}

// ── 크레딧 잔액 조회 ──────────────────────────────────────────────────────────
async function loadCreditBalance() {
  let res;
  try {
    // 비대화형 조회 — 로그인 안 된 사용자에게 무단 OAuth 팝업을 띄우지 않음
    res = await chrome.runtime.sendMessage({ type: 'GET_CREDITS', interactive: false });
  } catch (err) {
    // 컨텍스트 무효화(익스텐션 리로드)는 조용히 무시 — 페이지 새로고침 시 정상화
    if (err?.message?.includes('context invalidated')) return;
    res = { error: err.message };
  }
  if (res?.error) {
    // 미로그인은 정상 상태로 취급(로그 스팸·원문 코드 노출 방지) — 스트립에 "로그인 필요"만 표시
    if (res.error.includes('NOT_SIGNED_IN')) {
      creditAuthNeeded = true;
    } else {
      console.error('[YTAT] 크레딧 조회 실패:', res.error);
      addLog('error', 'ERROR', '크레딧 잔액을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  } else {
    creditAuthNeeded = false;
  }
  creditBalance = res?.balance ?? null;
  updateModeStrip();
}

// ── 공지 (사이드바 상단 영역에 목록 표시, 클릭 시 본문 펼침 / 지난 공지 아카이브는 설정) ──
const NOTICE_META = {
  info:     { cls: 'info',     label: t('sbNoticeInfo') },
  warn:     { cls: 'warn',     label: t('sbNoticeWarn') },
  critical: { cls: 'critical', label: t('sbNoticeCrit') },
};
let readIdsSet = null;                    // 읽음 ID 메모리 캐시 (쓰기 경합 방지 — 항상 전체 셋 기록)
const noticeBodyCache = new Map();        // 공지 본문 캐시 (재펼침 시 재조회 방지)

async function loadNotices() {
  const section = shadow.getElementById('notice-section');
  const feed = shadow.getElementById('notice-feed');
  if (!feed) return;
  try {
    const { readNoticeIds = [] } = await chrome.storage.local.get('readNoticeIds');
    readIdsSet = new Set(readNoticeIds.map(String));
    // 콘텐츠 스크립트는 교차출처 fetch가 CORS로 막히므로 SW를 경유해 조회
    const res = await chrome.runtime.sendMessage({ type: 'GET_NOTICES' });
    const notices = res?.notices || [];
    if (!notices.length) { if (section) section.style.display = 'none'; return; }
    if (section) section.style.display = '';
    feed.innerHTML = '';
    notices.forEach(n => feed.appendChild(buildNoticeCard(n, readIdsSet.has(String(n.id)))));
    recountUnread();
  } catch { /* 네트워크 오류는 조용히 무시 */ }
}

function buildNoticeCard(notice, isRead) {
  const meta = NOTICE_META[notice.type] || NOTICE_META.info;
  const date = String(notice.created_at || '').slice(0, 10);
  const card = document.createElement('div');
  card.className = `notice-card ${meta.cls}` + (isRead ? ' read' : '');
  card.innerHTML = `
    <div class="notice-top">
      <span class="notice-badge">${meta.label}</span>
      <span class="notice-date">${date}</span>
    </div>
    <div class="notice-title">${escapeHtml(notice.title)}</div>
  `;
  card.querySelector('.notice-title').addEventListener('click', () => toggleNotice(notice, card));
  return card;
}

// 제목 클릭 → 본문 펼침/접힘 + (최초 펼침 시) 읽음 처리
async function toggleNotice(notice, card) {
  const existing = card.querySelector('.notice-body');
  if (existing) { existing.remove(); card.classList.remove('expanded'); return; }

  card.classList.add('expanded');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'notice-body';
  card.appendChild(bodyEl);

  if (noticeBodyCache.has(notice.id)) {
    bodyEl.textContent = noticeBodyCache.get(notice.id);
  } else {
    bodyEl.textContent = '불러오는 중…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_NOTICE_DETAIL', id: notice.id });
      if (!res?.notice) throw new Error();
      const body = res.notice.body || '';
      noticeBodyCache.set(notice.id, body);
      bodyEl.textContent = body;
    } catch {
      bodyEl.textContent = '내용을 불러오지 못했습니다.';
    }
  }
  if (!card.classList.contains('read')) {
    card.classList.add('read');
    await markNoticeRead(notice.id);
    recountUnread();
  }
}

// 미읽음 배지 갱신 (읽음 처리되지 않은 카드 수 기준)
function recountUnread() {
  const feed = shadow.getElementById('notice-feed');
  const badge = shadow.getElementById('notice-unread');
  if (!feed || !badge) return;
  const n = feed.querySelectorAll('.notice-card:not(.read)').length;
  if (n > 0) { badge.textContent = `미읽음 ${n}`; badge.style.display = ''; }
  else badge.style.display = 'none';
}

async function markNoticeRead(id) {
  if (!readIdsSet) readIdsSet = new Set();
  if (readIdsSet.has(String(id))) return;
  readIdsSet.add(String(id)); // 메모리 셋 공유 → 빠른 연속 펼침에도 쓰기 유실 없음
  await chrome.storage.local.set({ readNoticeIds: [...readIdsSet] });
}

// ── 번역 시작 ─────────────────────────────────────────────────────────────────
function startTranslation() {
  chrome.runtime.sendMessage({ type: MSG.START_TRANSLATION, settings }, (res) => {
    // SW가 거부(이미 진행 중 / 탭 없음)하면 사용자에게 안내
    if (chrome.runtime.lastError) return; // 컨텍스트 무효화 등은 조용히 무시
    if (res?.error) addLog('error', 'ERROR', `⚠️ ${res.error}`);
  });
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

// ── 처리 이력 (구조화, 최대 100건은 SW에서 관리, 사용자가 지우기 전까지 유지) ──

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 원화 크레딧 표기 (정수, 천단위 콤마)
function formatCredits(n) {
  return `${Math.round(n || 0).toLocaleString()} ${t('creditsUnit')}`;
}

// 서비스워커가 기록에 넣은 한국어 값(고정 집합)을 UI 언어로 매핑 — 기록 카드용
const HC_REASON_KEY = {
  '크레딧 부족': 'failCredit', 'YouTube 일일 사용량 한도 소진': 'failQuota',
  '이미 등록된 자막 있음': 'failDup', '로그인 만료': 'failAuth', '채널 권한 오류': 'failPerm',
  '영상을 찾을 수 없음': 'failNotFound', '네트워크 오류': 'failNetwork', '일시적 오류': 'failTemp',
};
const HC_TTYPE_KEY = { '자막': 'metaSub', '제목': 'metaTitleWord', '설명': 'metaDescWord' };
function hcReason(s) { return HC_REASON_KEY[s] ? t(HC_REASON_KEY[s]) : s; }
function hcTType(s)  { return HC_TTYPE_KEY[s]  ? t(HC_TTYPE_KEY[s])  : s; }
function hcFailName(s) { return s === '제목/설명' ? `${t('metaTitleWord')}/${t('metaDescWord')}` : s; }

// (이력 저장은 서비스워커가 담당 — 탭이 닫혀도 유지되도록. 사이드바는 로드/표시만.)

// 지우기 버튼(섹션 헤더) 표시 토글
function setClearBtnVisible(show) {
  const btn = shadow.getElementById('btn-clear-hist');
  if (btn) btn.style.display = show ? '' : 'none';
}

async function clearHistory() {
  try {
    await chrome.storage.local.remove('ytatHistory');
    const feed = shadow.getElementById('log-feed');
    if (feed) {
      feed.innerHTML = '';
      showEmptyHistory();
    }
    setClearBtnVisible(false);
  } catch {}
}

// 처리 기록이 없을 때 안내 문구 (버튼·카드가 모두 없을 때만)
function showEmptyHistory() {
  const feed = shadow.getElementById('log-feed');
  if (!feed || shadow.getElementById('hist-empty')) return;
  const el = document.createElement('div');
  el.className = 'hist-empty';
  el.id = 'hist-empty';
  el.textContent = t('sbHistEmpty');
  feed.appendChild(el);
}

function removeEmptyHistory() {
  shadow.getElementById('hist-empty')?.remove();
}

// 이력 레코드 → 카드 DOM
function buildHistoryCard(rec) {
  const card = document.createElement('div');
  const isErr = !!rec.errorText;
  const type = isErr ? 'error'
    : rec.stopped ? 'stopped'
    : rec.allSkipped ? 'info'
    : (rec.failCount > 0 ? 'error' : 'success');
  card.className = `log-card ${type}`;

  const time = new Date(rec.ts).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const headLabel = isErr ? t('hcFail')
    : rec.stopped ? t('hcStopped')
    : rec.allSkipped ? t('hcSkipped')
    : (rec.failCount > 0 || rec.metaError) ? t('hcPartial')
    : t('hcDone');
  const headColor = isErr ? '#CF6679'
    : rec.stopped ? '#9E9E9E'
    : (rec.failCount > 0 || rec.metaError) ? '#CF6679'
    : rec.allSkipped ? '#BB86FC'
    : '#03DAC6';

  const items = rec.items || [];
  const skipped = rec.skippedLangs || [];
  const lines = [];

  if (isErr) {
    lines.push(`<div class="hist-meta" style="color:#ff8a9b">${escapeHtml(rec.errorText)}</div>`);
  } else if (rec.allSkipped) {
    lines.push(`<div class="hist-meta">${t('hcAllSkipped')}</div>`);
  } else if (rec.subResult || rec.targetTypes) {
    // ── 새 구조화 포맷 (번역 대상 / 언어 / 결과 / 실패 대상 / 실패 사유) ──
    const r = rec.subResult;
    if (rec.targetTypes?.length)
      lines.push(`<div class="hist-meta">${t('hcTargets')} · ${escapeHtml(rec.targetTypes.map(hcTType).join(' · '))}</div>`);
    if (rec.langNames?.length)
      lines.push(`<div class="hist-meta">${t('hcLangs')} · ${escapeHtml(rec.langNames.join(', '))}</div>`);
    if (r) {
      const parts = [`${t('hcOk')} ${r.ok}`];
      if (r.skip) parts.push(`${t('hcSkip')} ${r.skip}`);
      if (r.fail) parts.push(`${t('hcFailN')} ${r.fail}`);
      lines.push(`<div class="hist-meta">${t('hcResult')} · ${parts.join(' · ')} / ${t('hcSelected')} ${r.selected}</div>`);
    }
    if (rec.metaTitle || rec.metaDesc) {
      const tt = [rec.metaTitle && t('metaTitleWord'), rec.metaDesc && t('metaDescWord')].filter(Boolean).join('·');
      lines.push(`<div class="hist-meta">🌐 ${tt} ${t('hcMetaRegistered')}</div>`);
    }
    if (rec.failNames?.length)
      lines.push(`<div class="hist-meta" style="color:#ff8a9b">${t('hcFailTarget')} · ${escapeHtml(rec.failNames.map(hcFailName).join(', '))}</div>`);
    if (rec.failReasons?.length)
      lines.push(`<div class="hist-meta" style="color:#ff8a9b">${t('hcFailReason')} · ${escapeHtml(rec.failReasons.map(hcReason).join(', '))}</div>`);
    if (!lines.length)
      lines.push(`<div class="hist-meta">${t('hcNothing')}</div>`);
  } else {
    // 자막 번역 결과
    if (items.length) {
      const okN   = items.filter(i => i.ok).length;
      const failN = items.length - okN;
      const summary = failN > 0
        ? `📝 자막 ${items.length}개 언어 · ${okN} 성공 / ${failN} 실패`
        : `📝 자막 ${items.length}개 언어 번역`;
      // 실패 언어는 항상 개별 칩으로, 성공 언어는 9개 이상이면 요약 칩으로 접음
      const okItems = items.filter(i => i.ok);
      const okChips = okItems.length > 8
        ? `<span class="hist-lang more">✓ ${okItems.length}개 언어 성공</span>`
        : okItems.map(i => `<span class="hist-lang ok">${escapeHtml(i.name)}</span>`).join('');
      const failChips = items.filter(i => !i.ok)
        .map(i => `<span class="hist-lang fail">${escapeHtml(i.name)}</span>`).join('');
      const chips = okChips + failChips;
      lines.push(`<div class="hist-meta">${summary}</div><div class="hist-langs">${chips}</div>`);
    }
    // 이미 등록되어 건너뛴 자막 언어
    if (skipped.length) {
      lines.push(`<div class="hist-meta" style="color:rgba(255,255,255,0.4)">↩️ 이미 번역된 ${skipped.length}개 언어는 건너뜀</div>`);
    }
    // 제목/설명 번역
    if (rec.metaTitle || rec.metaDesc) {
      const t = [rec.metaTitle && '제목', rec.metaDesc && '설명'].filter(Boolean).join('·');
      lines.push(`<div class="hist-meta">🌐 ${t} 다국어 번역 등록</div>`);
    }
    // 제목/설명 번역 실패(크레딧 부족 등) — "완료"로 삼키지 않고 사유 표시
    if (rec.metaError) {
      lines.push(`<div class="hist-meta" style="color:#ff8a9b">⚠️ ${escapeHtml(rec.metaError)}</div>`);
    }
    // 아무것도 안 한 경우 방어
    if (!lines.length) {
      lines.push('<div class="hist-meta">처리할 새 항목이 없었습니다.</div>');
    }
  }

  const creditLine = (rec.creditsUsed != null)
    ? `<div class="hist-credit">💰 ${formatCredits(rec.creditsUsed)} ${t('hcCharged')}${rec.creditsRemaining != null ? ` · ${t('hcRemaining')} ${formatCredits(rec.creditsRemaining)}` : ''}</div>`
    : '';

  const fullTitle = rec.videoTitle || rec.videoId || '영상';
  card.classList.add('collapsed'); // 기본 접힘 — 헤더 클릭 시 상세 펼침
  card.innerHTML = `
    <div class="hist-head">
      <div class="log-top">
        <span class="log-type" style="color:${headColor}">${headLabel}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="hist-title-row">
        <span class="hist-caret">▸</span>
        <span class="hist-title" title="${escapeHtml(fullTitle)}">📹 ${escapeHtml(fullTitle)}</span>
      </div>
    </div>
    <div class="hist-body">
      ${lines.join('')}
      ${creditLine}
    </div>
  `;

  // 헤더 클릭 → 상세 접기/펼치기
  const head  = card.querySelector('.hist-head');
  const caret = card.querySelector('.hist-caret');
  head.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    caret.textContent = collapsed ? '▸' : '▾';
  });

  return card;
}

async function loadHistory() {
  try {
    const r = await chrome.storage.local.get('ytatHistory');
    const list = r.ytatHistory || [];
    const feed = shadow.getElementById('log-feed');
    if (!feed) return;
    if (!list.length) { showEmptyHistory(); setClearBtnVisible(false); return; } // 기록 없으면 안내만
    setClearBtnVisible(true);
    // 최신순 (저장이 이미 prepend라 그대로)
    list.forEach(rec => feed.appendChild(buildHistoryCard(rec)));
  } catch {}
}

// 진행 중 생성된 휘발성 로그 카드 제거
function clearTransientLogs() {
  const feed = shadow.getElementById('log-feed');
  if (!feed) return;
  feed.querySelectorAll('.log-transient').forEach(el => el.remove());
  // 남은 카드가 없으면(이력도 없음) 빈 안내 복원 — addLog가 지운 안내를 되돌림
  if (!feed.querySelector('.log-card')) showEmptyHistory();
}

// 새 이력 카드를 피드 최상단에 추가
function prependHistory(rec) {
  const feed = shadow.getElementById('log-feed');
  if (!feed) return;
  removeEmptyHistory();
  setClearBtnVisible(true);
  feed.insertBefore(buildHistoryCard(rec), feed.firstChild);
}

// ── 실시간 진행 로그 카드 (휘발성 — 완료 시 구조화 이력으로 별도 저장됨) ──────
function addLog(type, label, msg, labelColor) {
  const feed = shadow.getElementById('log-feed');
  removeEmptyHistory();
  const card = document.createElement('div');
  card.className = `log-card ${type} log-transient`;

  const color = labelColor || (type === 'success' ? '#03DAC6' : type === 'error' ? '#CF6679' : '#BB86FC');
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  card.innerHTML = `
    <div class="log-top">
      <span class="log-type" style="color:${color}">${escapeHtml(label)}</span>
      <span class="log-time">${time}</span>
    </div>
    <div class="log-msg">${escapeHtml(msg)}</div>
  `;

  feed.insertBefore(card, feed.firstChild);
}

// ── SW 메시지 수신 ────────────────────────────────────────────────────────────
let currentMsgHandler = null;   // 재마운트 시 리스너 중복 등록 방지
let lastProgressLog   = '';     // 동일 진행 메시지 중복 로그 방지

// 마운트 시 SW에 진행 상태를 물어 이미 번역 중이면 UI 복원 (새 탭/새로고침 후 진행률·중지 노출)
async function restoreRunningState() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
    if (status?.isRunning) {
      setRunning(true, status.targetLangs || []);
      const p = status.progress || {};
      if (p.total > 0) updateProgress((p.current / p.total) * 100, p.current, p.total);
    }
  } catch { /* SW 미기동/컨텍스트 무효 — 무시 */ }
}

function setupMessageListener() {
  if (currentMsgHandler) chrome.runtime.onMessage.removeListener(currentMsgHandler);

  currentMsgHandler = (msg) => {
    if (!msg?.type) return;

    switch (msg.type) {
      case MSG.TRANSLATION_PROGRESS: {
        if (!isRunning) setRunning(true, msg.targetLangs || []);
        // 첫 진행 메시지에 targetLangs가 없어 칩이 비어있던 경우, 이후 도착 시 채움
        else if (msg.targetLangs?.length && Object.keys(langChipState).length === 0) {
          langChipState = {};
          msg.targetLangs.forEach(code => { langChipState[code] = 'pending'; });
          buildChipLabels(msg.targetLangs);
          renderChips();
        }
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
        clearTransientLogs(); // 실시간 진행 로그 제거 → 이력 카드로 대체

        // 이력 저장은 SW가 담당(탭 닫혀도 유지). 여기선 화면 표시만.
        if (msg.record) prependHistory(msg.record);
        loadCreditBalance();
        break;
      }

      case MSG.TRANSLATION_ERROR: {
        const errText = msg.error || msg.message || '번역 중 오류가 발생했습니다.';

        // 개별 언어 실패(perLang): 작업은 계속 진행 중 — 종료/이력저장 하지 않고 진행 로그만
        if (msg.perLang) {
          addLog('error', 'ERROR', `❌ ${errText}`);
          break;
        }

        // 작업 전체 실패: 종료 + 이력 카드 표시(저장은 SW)
        setRunning(false);
        clearTransientLogs();
        if (msg.record) prependHistory(msg.record);
        if (errText.includes('크레딧')) {
          updateModeStrip();
        }
        break;
      }
    }
  };
  chrome.runtime.onMessage.addListener(currentMsgHandler);
}
