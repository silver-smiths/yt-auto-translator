/**
 * Content Script — YouTube Auto-Translator Sidebar (Primary UI)
 *
 * 사이드바가 모든 제어를 담당합니다:
 *  - 번역 시작 / 중지
 *  - 진행률 + 언어 칩
 *  - 로그 히스토리
 *  - 설정 페이지 열기
 */

// ── 메시지 타입 (lib/constants.js와 동기화) ──
const MSG = {
  START_TRANSLATION:    'START_TRANSLATION',
  STOP_TRANSLATION:     'STOP_TRANSLATION',
  TRANSLATION_PROGRESS: 'TRANSLATION_PROGRESS',
  TRANSLATION_COMPLETE: 'TRANSLATION_COMPLETE',
  TRANSLATION_ERROR:    'TRANSLATION_ERROR',
  GET_STATUS:           'GET_STATUS'
};

// ── 언어 코드 → 표시 이름 (간소화 맵) ──
const LANG_NAMES = {
  en: 'English', 'zh-CN': '中文(简体)', hi: 'हिन्दी', es: 'Español',
  fr: 'Français', ar: 'العربية', pt: 'Português', bn: 'বাংলা',
  ru: 'Русский', ur: 'اردو', id: 'Indonesia', de: 'Deutsch',
  ja: '日本語', pcm: 'Naijá', arz: 'مصرى', mr: 'मराठी',
  vi: 'Tiếng Việt', te: 'తెలుగు', tr: 'Türkçe', pa: 'پنجابی',
  sw: 'Kiswahili', tl: 'Tagalog', ta: 'தமிழ்', yue: '粵語',
  wuu: '吴语', ko: '한국어'
};

// ── Extension 컨텍스트 유효성 확인 ──
// 익스텐션이 재로드되면 chrome.runtime.id가 undefined가 되거나 접근 시 예외 발생
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ── 에러 리포트 헬퍼 ──
function reportError(error, source = 'content-script') {
  if (!isContextValid()) return; // 컨텍스트 무효화 시 조용히 무시
  chrome.runtime.sendMessage({
    type: 'LOG_ERROR',
    error: error?.message || String(error),
    context: { source, url: window.location.href }
  }).catch(e => console.warn('[YT-Translator] sendMessage 실패:', e?.message));
}

function installGlobalErrorHandler(source = 'unknown') {
  window.addEventListener('error', e => {
    if (!isContextValid()) return;
    reportError(e.error || new Error(e.message), `${source}:global`);
  });
  window.addEventListener('unhandledrejection', e => {
    if (!isContextValid()) return;
    reportError(e.reason || new Error('Unhandled rejection'), `${source}:promise`);
  });
}
installGlobalErrorHandler('content-script');

// ────────────────────────────────────────────
// SidebarManager
// ────────────────────────────────────────────
class SidebarManager {
  constructor() {
    this.isOpen      = false;
    this.isRunning   = false;
    this.host        = null;
    this.shadow      = null;
    this.container   = null;
    this.contentArea = null;
    this.progressArea = null;
    this.chipArea    = null;
    this.btnStart    = null;
    this.btnStop     = null;
    this.langStatuses = {};

    this.init();
    this.startObserver();
  }

  // ── 초기화 ──────────────────────────────────
  init() {
    const existingHost = document.getElementById('yt-translator-sidebar-host');
    if (existingHost) {
      const shadow = existingHost.shadowRoot;
      // 구버전 DOM (버튼 없음)이 남아 있으면 제거 후 재생성
      if (shadow && shadow.querySelector('.btn-start')) {
        this.host        = existingHost;
        this.shadow      = shadow;
        this.container   = shadow.querySelector('.sidebar-container');
        this.contentArea = shadow.querySelector('.sidebar-content');
        this.progressArea = shadow.querySelector('.sidebar-progress-container');
        this.chipArea    = shadow.querySelector('.sidebar-chip-area');
        this.btnStart    = shadow.querySelector('.btn-start');
        this.btnStop     = shadow.querySelector('.btn-stop');
        return;
      }
      // 구버전 잔류 DOM → 제거하고 새로 생성
      existingHost.remove();
    }

    this.host = document.createElement('div');
    this.host.id = 'yt-translator-sidebar-host';
    document.body.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = chrome.runtime.getURL('src/styles/content.css');
    this.shadow.appendChild(link);

    this.renderBase();
    this.loadHistory();
    this.updateTheme();
    this.observeTheme();
    this.syncRunningState();
  }

  // ── DOM 구조 생성 ────────────────────────────
  renderBase() {
    // 토글 탭 버튼 (화면 오른쪽 고정)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.innerHTML = '🌐';
    toggleBtn.title = 'YouTube Auto-Translator';
    toggleBtn.onclick = () => this.toggle();
    this.shadow.appendChild(toggleBtn);

    // 사이드바 컨테이너
    this.container = document.createElement('div');
    this.container.className = 'sidebar-container';

    // ── 헤더 ──
    const header = document.createElement('div');
    header.className = 'sidebar-header';
    header.innerHTML = `
      <div class="header-main">
        <span class="logo">🌐</span>
        <h2>YouTube 번역 AI</h2>
      </div>
      <button class="close-btn" title="닫기">&times;</button>
    `;
    header.querySelector('.close-btn').onclick = () => this.toggle(false);

    // ── 컨트롤 영역 ──
    const controlArea = document.createElement('div');
    controlArea.className = 'sidebar-control-area';

    this.btnStart = document.createElement('button');
    this.btnStart.className = 'btn-sidebar btn-start';
    this.btnStart.textContent = '▶  번역 시작';
    // inline 기본 스타일 — CSS 로드 전에도 버튼이 보이도록
    Object.assign(this.btnStart.style, {
      flex: '1', padding: '10px 14px', border: 'none', borderRadius: '8px',
      fontSize: '13px', fontWeight: '600', cursor: 'pointer',
      background: '#BB86FC', color: '#000'
    });
    this.btnStart.onclick = () => this.startTranslation();

    this.btnStop = document.createElement('button');
    this.btnStop.className = 'btn-sidebar btn-stop';
    this.btnStop.textContent = '■  번역 중지';
    Object.assign(this.btnStop.style, {
      flex: '1', padding: '10px 14px', border: 'none', borderRadius: '8px',
      fontSize: '13px', fontWeight: '600', cursor: 'pointer',
      background: '#CF6679', color: '#fff', display: 'none'
    });
    this.btnStop.onclick = () => this.stopTranslation();

    controlArea.appendChild(this.btnStart);
    controlArea.appendChild(this.btnStop);

    // ── 진행바 영역 ──
    this.progressArea = document.createElement('div');
    this.progressArea.className = 'sidebar-progress-container';
    this.progressArea.style.display = 'none';
    this.progressArea.innerHTML = `
      <div class="progress-info">
        <span class="progress-label">번역 진행률</span>
        <span class="progress-percent">0%</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill"></div>
      </div>
    `;

    // ── 언어 칩 영역 ──
    this.chipArea = document.createElement('div');
    this.chipArea.className = 'sidebar-chip-area';
    this.chipArea.style.display = 'none';

    // ── 로그 영역 ──
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'sidebar-content';
    this.contentArea.innerHTML = `
      <div class="empty-guide">유튜브 스튜디오의 영상 수정 페이지에서<br>위 버튼으로 번역을 시작하세요.</div>
    `;

    // ── 푸터 ──
    const footer = document.createElement('div');
    footer.className = 'sidebar-footer';
    footer.innerHTML = `<button class="btn-settings">⚙️ 설정</button>`;
    footer.querySelector('.btn-settings').onclick = () => {
      if (isContextValid()) chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      else this.addLog('⚠️ 익스텐션이 재로드되었습니다. 페이지를 새로고침 후 다시 시도해 주세요.', 'error');
    };

    this.container.appendChild(header);
    this.container.appendChild(controlArea);
    this.container.appendChild(this.progressArea);
    this.container.appendChild(this.chipArea);
    this.container.appendChild(this.contentArea);
    this.container.appendChild(footer);
    this.shadow.appendChild(this.container);
  }

  // ── 번역 시작 ────────────────────────────────
  async startTranslation() {
    if (!isContextValid()) {
      this.addLog('⚠️ 익스텐션이 재로드되었습니다. 페이지를 새로고침 후 다시 시도해 주세요.', 'error');
      return;
    }
    // 설정 로드
    const result  = await chrome.storage.local.get('settings');
    const settings = result.settings || {};

    if (!settings.geminiApiKey) {
      this.addLog('⚠️ Gemini API 키가 없습니다. 설정에서 먼저 API 키를 입력해 주세요.', 'error');
      this.toggle(true);
      return;
    }

    // 현재 URL이 YouTube Studio 영상 수정 페이지인지 확인
    if (!location.href.includes('studio.youtube.com')) {
      this.addLog('⚠️ YouTube Studio 영상 수정 페이지에서만 사용 가능합니다.', 'error');
      return;
    }

    // 언어 칩 초기화
    const targetLangs = settings.targetLangs || [];
    this.initChips(targetLangs);
    this.setRunning(true);

    // 무료 티어 + 다국어 시 예상 시간 안내
    if (settings.geminiTier !== 'paid' && targetLangs.length >= 3) {
      const minEst = Math.ceil((targetLangs.length * 3 * 5) / 60); // 언어 × 청크 × 5초 간격
      this.addLog(
        `⏱ 무료 티어: ${targetLangs.length}개 언어 번역 예상 소요 약 ${minEst}분 이상 (영상 길이에 따라 달라짐)`,
        'info'
      );
    }

    // AI 면책 고지
    this.addLog('🤖 AI 번역이므로 오역이 있을 수 있습니다. 업로드 후 반드시 검토해 주세요.', 'info');

    this.addLog('🚀 번역을 시작합니다...', 'info');

    // tabId 없이 전송 — service worker가 sender.tab.id로 자동 감지
    chrome.runtime.sendMessage(
      { type: MSG.START_TRANSLATION, settings },
      (res) => {
        if (chrome.runtime.lastError || res?.error) {
          this.setRunning(false);
          this.addLog(`❌ 시작 실패: ${res?.error || chrome.runtime.lastError?.message}`, 'error');
        }
      }
    );
  }

  // ── 번역 중지 ────────────────────────────────
  stopTranslation() {
    if (isContextValid()) chrome.runtime.sendMessage({ type: MSG.STOP_TRANSLATION });
    this.setRunning(false);
    this.addLog('⏹ 번역이 중지되었습니다.', 'info');
  }

  // ── 실행 상태 동기화 (백그라운드 상태 → UI 반영) ──
  syncRunningState() {
    if (!isContextValid()) return;
    chrome.runtime.sendMessage({ type: MSG.GET_STATUS }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.state === 'working') {
        this.setRunning(true);
      } else if (res?.state === 'idle' && this.isRunning) {
        // TRANSLATION_COMPLETE 메시지가 유실된 경우 조용히 UI 상태만 복구.
        // 성공/실패 여부를 알 수 없으므로 로그 메시지는 추가하지 않는다.
        // (이전에 있던 "상태 동기화" SUCCESS 카드는 오류 직후에도 찍혀
        //  사용자에게 잘못된 정보를 줬기 때문에 제거)
        this.setRunning(false);
        Object.entries(this.langStatuses).forEach(([code, st]) => {
          if (st === 'pending' || st === 'translating') this.updateChip(code, 'done');
        });
      }
    });
  }

  // ── 실행 중 폴링 (TRANSLATION_COMPLETE 메시지 유실 대비) ──
  startStatePoller() {
    if (this._pollerTimer) return; // 이미 실행 중이면 중복 등록 방지
    this._pollerTimer = setInterval(() => {
      // 익스텐션이 재로드되어 컨텍스트가 무효화된 경우 폴링 중단
      if (!isContextValid()) { this.stopStatePoller(); return; }
      if (!this.isRunning) { this.stopStatePoller(); return; }
      this.syncRunningState();
    }, 3000);
  }

  stopStatePoller() {
    if (this._pollerTimer) {
      clearInterval(this._pollerTimer);
      this._pollerTimer = null;
    }
  }

  // ── 버튼 상태 전환 ───────────────────────────
  setRunning(running) {
    this.isRunning = running;
    if (running) {
      this.startStatePoller();
    } else {
      this.stopStatePoller();
    }
    if (this.btnStart) this.btnStart.style.display = running ? 'none' : '';
    if (this.btnStop)  this.btnStop.style.display  = running ? '' : 'none';
  }

  // ── 언어 칩 초기화 ───────────────────────────
  initChips(targetLangs) {
    if (!targetLangs.length) return;
    this.chipArea.innerHTML = '';
    this.langStatuses = {};

    targetLangs.forEach(code => {
      const chip = document.createElement('span');
      chip.className = 'lang-chip pending';
      chip.id        = `yt-chip-${code}`;
      chip.textContent = LANG_NAMES[code] || code;
      this.chipArea.appendChild(chip);
      this.langStatuses[code] = 'pending';
    });

    this.chipArea.style.display = 'flex';
    this.progressArea.style.display = 'block';
  }

  // ── 언어 칩 상태 변경 ───────────────────────
  updateChip(code, status) {
    const chip = this.shadow.getElementById(`yt-chip-${code}`);
    if (chip) {
      chip.className = `lang-chip ${status}`;
      this.langStatuses[code] = status;
    }
  }

  // ── 진행률 업데이트 ──────────────────────────
  updateProgress(current, total) {
    this.progressArea.style.display = 'block';
    const pct   = total > 0 ? Math.round((current / total) * 100) : 0;
    const fill  = this.progressArea.querySelector('.progress-bar-fill');
    const label = this.progressArea.querySelector('.progress-percent');
    fill.style.width   = `${pct}%`;
    label.textContent  = `${pct}% (${current}/${total})`;
  }

  // ── 로그 카드 추가 ────────────────────────────
  addLog(message, type = 'info', timestamp = new Date(), silent = false) {
    const card = document.createElement('div');
    card.className = `status-card ${type}`;
    const time = (timestamp || new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const header = document.createElement('div');
    header.className = 'status-header';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'status-type-label';
    typeLabel.textContent = type.toUpperCase();
    const timeLabel = document.createElement('span');
    timeLabel.className = 'status-time';
    timeLabel.textContent = time;
    header.appendChild(typeLabel);
    header.appendChild(timeLabel);
    const body = document.createElement('div');
    body.className = 'status-text';
    body.textContent = message;
    card.appendChild(header);
    card.appendChild(body);

    const guide = this.contentArea.querySelector('.empty-guide');
    if (guide) guide.remove();

    this.contentArea.insertBefore(card, this.contentArea.firstChild);

    // 에러/성공/시작 시 사이드바 자동 열기
    if (!silent && (type === 'success' || type === 'error' ||
        (type === 'info' && /시작|인증|감지|완료/.test(message)))) {
      this.toggle(true);
    }
  }

  // ── 히스토리 로드 ────────────────────────────
  async loadHistory() {
    if (!isContextValid()) return;
    try {
      const result = await chrome.storage.local.get('appLogs');
      const logs   = (result.appLogs || []).slice(0, 15).reverse();
      if (!logs.length) return;

      this.addLog('── 최근 처리 내역 ──', 'info', null, true);
      logs.forEach(entry => {
        const typeMap = { ERROR: 'error', WARN: 'warning', INFO: 'info', DEBUG: 'info' };
        this.addLog(entry.message, typeMap[entry.level] || 'info', new Date(entry.timestamp), true);
      });
    } catch (e) {
      console.error('[YT-Translator] 히스토리 로드 실패:', e);
    }
  }

  // ── 사이드바 토글 ────────────────────────────
  toggle(force) {
    this.isOpen = typeof force === 'boolean' ? force : !this.isOpen;
    this.container.classList.toggle('open', this.isOpen);
    // 번역 진행 중에는 폴러가 상태를 감시하므로 추가 동기화 불필요.
    // idle 상태(또는 재로드 후 사이드바를 열 때)에만 동기화해서
    // TRANSLATION_ERROR → toggle → GET_STATUS 레이스 컨디션을 방지한다.
    if (this.isOpen && !this.isRunning) this.syncRunningState();
  }

  // ── 테마 ─────────────────────────────────────
  updateTheme() {
    const isDark = document.documentElement.hasAttribute('dark') ||
                   document.body.classList.contains('dark') ||
                   window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.host[isDark ? 'setAttribute' : 'removeAttribute']('dark', '');
  }

  observeTheme() {
    if (this._themeObserver) this._themeObserver.disconnect();
    this._themeObserver = new MutationObserver(() => this.updateTheme());
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'class'] });
  }

  // ── DOM 재삽입 감시 (SPA 대응) ───────────────
  startObserver() {
    if (this._domObserver) this._domObserver.disconnect();
    this._domObserver = new MutationObserver(() => {
      if (!document.getElementById('yt-translator-sidebar-host')) {
        this.init();
      }
    });
    this._domObserver.observe(document.body, { childList: true });
  }
}

// ────────────────────────────────────────────
// 초기화 + 메시지 핸들러
// ────────────────────────────────────────────
try {
  const sidebar = new SidebarManager();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ pong: true });
      return;
    }

    if (message.type === MSG.TRANSLATION_PROGRESS) {
      const { lang, langName, current, total, done } = message;

      if (langName) {
        // 완료된 언어는 ✓ suffix 포함해서 들어옴
        const isDone = done || /완료/.test(langName);
        sidebar.addLog(`${isDone ? '✅' : '🔄'} ${langName}`, isDone ? 'success' : 'info');
        if (lang) sidebar.updateChip(lang, isDone ? 'done' : 'translating');
      }

      if (typeof current === 'number' && typeof total === 'number' && total > 0) {
        sidebar.updateProgress(current, total);
      }
    }

    else if (message.type === MSG.TRANSLATION_COMPLETE) {
      sidebar.setRunning(false);
      const errCount = message.errors?.length || 0;
      const total    = message.count + errCount;

      if (message.count === 0 && errCount > 0) {
        // 전부 실패 — success 카드 대신 error 카드
        sidebar.updateProgress(0, total);
        sidebar.addLog(
          `❌ 번역 실패: ${errCount}개 언어 모두 오류가 발생했습니다. 위 오류 메시지를 확인해 주세요.`,
          'error'
        );
      } else if (errCount > 0) {
        // 일부 성공, 일부 실패
        sidebar.updateProgress(message.count, total);
        sidebar.addLog(
          `⚠️ 번역 완료 (일부 실패): ${message.count}개 성공, ${errCount}개 실패`,
          'warning'
        );
      } else {
        // 전부 성공
        sidebar.updateProgress(message.count, message.count);
        sidebar.addLog(`✅ 번역 완료! 총 ${message.count}개 언어 업로드 성공`, 'success');
      }

      // 미완료 칩 일괄 done
      Object.entries(sidebar.langStatuses).forEach(([code, st]) => {
        if (st === 'pending' || st === 'translating') sidebar.updateChip(code, 'done');
      });
    }

    else if (message.type === MSG.TRANSLATION_ERROR) {
      if (message.lang) sidebar.updateChip(message.lang, 'error');
      // 전체 실패(lang 없음)이면 버튼도 복구
      if (!message.lang) sidebar.setRunning(false);
      sidebar.addLog(`❌ 오류: ${message.error}`, 'error');
    }
  });

  console.log('[YT-Auto-Translator] Sidebar UI loaded ✓');
} catch (e) {
  console.error('[YT-Auto-Translator] Sidebar init failed:', e);
  reportError(e, 'sidebar-init');
}
