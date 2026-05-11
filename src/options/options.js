import {
  TARGET_LANGUAGES,
  GEMINI_CONFIG,
  TRANSLATION_MODES,
  API_BASE,
  PAYMENT_URL,
} from '../lib/constants.js';
import { loadSettings, saveSettings } from '../lib/storage.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const welcomeCard      = document.getElementById('welcomeCard');
const welcomeStep1     = document.getElementById('welcomeStep1');
const welcomeStep2     = document.getElementById('welcomeStep2');
const welcomeStep3     = document.getElementById('welcomeStep3');
const modeApiKey       = document.getElementById('modeApiKey');
const modeCredits      = document.getElementById('modeCredits');
const apiKeyPanel      = document.getElementById('apiKeyPanel');
const creditPanel      = document.getElementById('creditPanel');
const apiKeyInput      = document.getElementById('apiKey');
const btnToggleKey     = document.getElementById('btnToggleKey');
const creditBalance    = document.getElementById('creditBalance');
const btnTopup         = document.getElementById('btnTopup');
const modelSelectWrap  = document.getElementById('modelSelectWrap');
const modelSelect      = document.getElementById('modelSelect');
const modelFixed       = document.getElementById('modelFixed');
const sourceLang       = document.getElementById('sourceLang');
const langGrid         = document.getElementById('langGrid');
const langNotice       = document.getElementById('langNotice');
const btnSelectAll     = document.getElementById('btnSelectAll');
const btnDeselectAll   = document.getElementById('btnDeselectAll');
const speedSection     = document.getElementById('speedSection');
const btnSave          = document.getElementById('btnSave');
const saveStatus       = document.getElementById('saveStatus');

let currentMode = TRANSLATION_MODES.API_KEY;
let selectedLangs = new Set();

// ── 웰컴 카드 ─────────────────────────────────────────────────────────────────
function showWelcomeStep(step) {
  welcomeStep1.style.display = step === 1 ? '' : 'none';
  welcomeStep2.style.display = step === 2 ? '' : 'none';
  welcomeStep3.style.display = step === 3 ? '' : 'none';
}

document.getElementById('btnDismissWelcome').addEventListener('click', async () => {
  welcomeCard.style.display = 'none';
  const settings = await loadSettings();
  await saveSettings({ ...settings, welcomeDismissed: true });
});

document.getElementById('welcomeCtaCredits').addEventListener('click', () => {
  modeCredits.checked = true;
  applyMode(TRANSLATION_MODES.CREDITS);
  showWelcomeStep(2);
});

document.getElementById('welcomeLinkApiKey').addEventListener('click', () => {
  modeApiKey.checked = true;
  applyMode(TRANSLATION_MODES.API_KEY);
  showWelcomeStep(3);
});

document.getElementById('welcomeCtaTopup').addEventListener('click', () => {
  chrome.tabs.create({ url: PAYMENT_URL });
});

document.getElementById('welcomeCtaApiKey').addEventListener('click', () => {
  apiKeyInput.focus();
});

document.getElementById('welcomeBack2').addEventListener('click', () => {
  modeApiKey.checked = true;
  applyMode(TRANSLATION_MODES.API_KEY);
  showWelcomeStep(1);
});

document.getElementById('welcomeBack3').addEventListener('click', () => {
  modeCredits.checked = true;
  applyMode(TRANSLATION_MODES.CREDITS);
  showWelcomeStep(1);
});

// ── 모드 전환 ─────────────────────────────────────────────────────────────────
function applyMode(mode) {
  currentMode = mode;
  const isCredits = mode === TRANSLATION_MODES.CREDITS;

  apiKeyPanel.className = 'mode-panel ' + (isCredits ? 'hidden' : 'visible');
  creditPanel.className = 'mode-panel ' + (isCredits ? 'visible' : 'hidden');

  modelSelectWrap.style.display = isCredits ? 'none'  : 'block';
  modelFixed.style.display      = isCredits ? 'block' : 'none';

  if (isCredits) {
    speedSection.style.display = 'none';

    langNotice.className = 'notice notice-success';
    langNotice.innerHTML = '✅ 최대 <strong>26개 언어</strong>를 동시에 번역합니다.';
    btnSelectAll.disabled = false;

    fetchCreditBalance();
  } else {
    speedSection.style.display = '';

    langNotice.className = 'notice notice-warn';
    langNotice.innerHTML = '⚠️ 내 API 키 모드에서는 한 번에 <strong>1개 언어</strong>만 번역할 수 있습니다.';
    btnSelectAll.disabled = true;

    // 여러 개 선택 → 첫 번째 1개만 유지
    if (selectedLangs.size > 1) {
      const first = Array.from(selectedLangs)[0];
      selectedLangs.clear();
      selectedLangs.add(first);
    }
  }

  buildLangGrid();
}

modeApiKey.addEventListener('change', () => applyMode(TRANSLATION_MODES.API_KEY));
modeCredits.addEventListener('change', () => applyMode(TRANSLATION_MODES.CREDITS));

// ── API 키 토글 ───────────────────────────────────────────────────────────────
btnToggleKey.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
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
    creditBalance.textContent = `$${balance.toFixed(2)}`;
  } catch {
    creditBalance.textContent = '조회 실패 (로그인 필요)';
  }
}

btnTopup.addEventListener('click', () => {
  chrome.tabs.create({ url: PAYMENT_URL });
});

// ── 모델 옵션 빌드 ────────────────────────────────────────────────────────────
function buildModelOptions(selected) {
  modelSelect.innerHTML = '';
  const validIds = new Set();
  GEMINI_CONFIG.models.forEach(({ id, name }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    modelSelect.appendChild(opt);
    validIds.add(id);
  });
  modelSelect.value = (selected && validIds.has(selected))
    ? selected
    : GEMINI_CONFIG.defaultModel;
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

function toggleLang(code) {
  if (currentMode === TRANSLATION_MODES.API_KEY) {
    if (selectedLangs.has(code)) return;
    selectedLangs.clear();
    selectedLangs.add(code);
  } else {
    if (selectedLangs.has(code)) {
      if (selectedLangs.size === 1) return;
      selectedLangs.delete(code);
    } else {
      selectedLangs.add(code);
    }
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

  // 모드
  const mode = settings.translationMode || TRANSLATION_MODES.API_KEY;
  if (mode === TRANSLATION_MODES.CREDITS) {
    modeCredits.checked = true;
  } else {
    modeApiKey.checked = true;
  }

  // 언어
  selectedLangs = new Set(settings.targetLangs || []);

  // 나머지 필드
  apiKeyInput.value = settings.geminiApiKey || '';
  buildModelOptions(settings.selectedModel);
  buildSourceLang(settings.sourceLang);

  // 모드 UI 적용 (buildLangGrid 포함)
  applyMode(mode);
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
    translationMode: currentMode,
    geminiApiKey:    apiKeyInput.value.trim(),
    selectedModel:   modelSelect.value,
    sourceLang:      sourceLang.value,
    targetLangs:     Array.from(selectedLangs),
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
