/**
 * Options Page Controller — Gemini API Key 전용
 */
import { TARGET_LANGUAGES, GEMINI_CONFIG } from '../lib/constants.js';
import { loadSettings, saveSettings } from '../lib/storage.js';
import { installGlobalErrorHandler, getLogs, clearLogs } from '../lib/logger.js';

installGlobalErrorHandler('options');

// =============================================
// i18n
// =============================================
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.innerHTML = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.placeholder = msg;
  });
}

// =============================================
// DOM 요소
// =============================================
const apiKeyInput      = document.getElementById('apiKey');
const btnToggleKey     = document.getElementById('btnToggleKey');
const guideCard        = document.getElementById('guideCard');
const guideToggle      = document.getElementById('guideToggle');
const keyStatus        = document.getElementById('keyStatus');
const keyStatusText    = document.getElementById('keyStatusText');
const modelSelect      = document.getElementById('modelSelect');
const sourceLangSelect = document.getElementById('sourceLang');
const langGrid         = document.getElementById('langGrid');
const btnSelectAll     = document.getElementById('btnSelectAll');
const btnDeselectAll   = document.getElementById('btnDeselectAll');
const tierFree         = document.getElementById('tierFree');
const tierPaid         = document.getElementById('tierPaid');
const freeTierNotice   = document.getElementById('freeTierNotice');
const paidTierNotice   = document.getElementById('paidTierNotice');
const paidSpeedSection = document.getElementById('paidSpeedSection');
const paidSpeedSelect  = document.getElementById('paidSpeed');
const delayMinInput    = document.getElementById('delayMin');
const delayMaxInput    = document.getElementById('delayMax');
const btnSave          = document.getElementById('btnSave');
const saveStatus       = document.getElementById('saveStatus');
const logPreview       = document.getElementById('logPreview');
const btnCopyLogs      = document.getElementById('btnCopyLogs');
const btnClearLogs     = document.getElementById('btnClearLogs');

// =============================================
// API Key 상태 UI 업데이트
// =============================================
function updateKeyStatus(key) {
  const trimmed = (key || '').trim();

  if (!trimmed) {
    // 키 없음: 가이드 표시
    keyStatus.className = 'key-status empty';
    keyStatusText.textContent = '키가 입력되지 않았습니다. 위 가이드를 따라 무료로 발급해 주세요.';
    guideCard.classList.remove('hidden');
    guideToggle.style.display = 'none';
  } else {
    // 정상 키
    keyStatus.className = 'key-status ok';
    keyStatusText.textContent = `API 키가 설정되어 있습니다. (${trimmed.slice(0, 8)}••••••)`;
    guideCard.classList.add('hidden');
    guideToggle.style.display = 'inline-block';
  }
}

// 입력 시 실시간 상태 업데이트
apiKeyInput.addEventListener('input', () => updateKeyStatus(apiKeyInput.value));

// 가이드 토글 버튼
guideToggle.addEventListener('click', () => {
  guideCard.classList.toggle('hidden');
  guideToggle.textContent = guideCard.classList.contains('hidden')
    ? '📖 API 키 발급 방법 다시 보기'
    : '🔼 가이드 접기';
});

// =============================================
// API Key 표시/숨기기
// =============================================
btnToggleKey.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// =============================================
// 모델 옵션 빌드
// =============================================
function buildModelOptions(selectedModel) {
  modelSelect.innerHTML = '';
  const validIds = new Set();
  GEMINI_CONFIG.models.forEach(model => {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name;
    modelSelect.appendChild(opt);
    validIds.add(model.id);
  });
  // 저장된 모델이 목록에 없으면(deprecated·미출시) 기본 모델로 자동 복구
  const target = selectedModel && validIds.has(selectedModel)
    ? selectedModel
    : GEMINI_CONFIG.defaultModel;
  modelSelect.value = target;
}

// =============================================
// 소스 언어 셀렉트 빌드
// =============================================
function buildSourceLangSelect(selected) {
  sourceLangSelect.innerHTML = '';

  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = chrome.i18n.getMessage('optionsSourceLangAuto') || 'Auto (영상 기본 언어 자동 감지)';
  sourceLangSelect.appendChild(autoOpt);

  TARGET_LANGUAGES.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = `${lang.name} (${lang.nativeName})`;
    sourceLangSelect.appendChild(opt);
  });

  sourceLangSelect.value = selected || 'auto';
}

// =============================================
// 언어 그리드 빌드
// =============================================
function buildLangGrid(selectedLangs = []) {
  langGrid.innerHTML = '';
  TARGET_LANGUAGES.forEach(lang => {
    const item = document.createElement('label');
    item.className = 'lang-item' + (selectedLangs.includes(lang.code) ? ' selected' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = lang.code;
    checkbox.checked = selectedLangs.includes(lang.code);
    checkbox.addEventListener('change', () => {
      item.classList.toggle('selected', checkbox.checked);
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'lang-name';
    nameSpan.innerHTML = `${lang.name}<span class="lang-native">${lang.nativeName}</span>`;

    item.appendChild(checkbox);
    item.appendChild(nameSpan);
    langGrid.appendChild(item);
  });
}

// =============================================
// 요금제 토글 UI
// =============================================
function applyTierUI(tier) {
  const isPaid = tier === 'paid';
  freeTierNotice.style.display   = isPaid ? 'none' : 'block';
  paidTierNotice.style.display   = isPaid ? 'block' : 'none';
  paidSpeedSection.style.display = isPaid ? 'block' : 'none';
}

tierFree.addEventListener('change', () => applyTierUI('free'));
tierPaid.addEventListener('change', () => applyTierUI('paid'));

// =============================================
// 설정 로드
// =============================================
async function loadAndApply() {
  const settings = await loadSettings();
  apiKeyInput.value = settings.geminiApiKey || '';
  updateKeyStatus(settings.geminiApiKey);
  buildModelOptions(settings.selectedModel);
  buildSourceLangSelect(settings.sourceLang);
  buildLangGrid(settings.targetLangs);

  // 요금제 설정
  const tier = settings.geminiTier || 'free';
  (tier === 'paid' ? tierPaid : tierFree).checked = true;
  paidSpeedSelect.value = settings.paidSpeed || 'normal';
  applyTierUI(tier);

  delayMinInput.value = settings.delayMin ?? 0;
  delayMaxInput.value = settings.delayMax ?? 0;
}

// =============================================
// 전체 선택 / 해제
// =============================================
btnSelectAll.addEventListener('click', () => {
  langGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
    cb.closest('.lang-item').classList.add('selected');
  });
});
btnDeselectAll.addEventListener('click', () => {
  langGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
    cb.closest('.lang-item').classList.remove('selected');
  });
});

// =============================================
// 저장
// =============================================
btnSave.addEventListener('click', async () => {
  const geminiApiKey = apiKeyInput.value.trim();

  if (!geminiApiKey) {
    saveStatus.textContent = '⚠️ API 키가 없습니다. 위 가이드를 따라 먼저 발급해 주세요.';
    saveStatus.style.color = '#d32f2f';
    saveStatus.classList.add('visible');
    apiKeyInput.focus();
    setTimeout(() => saveStatus.classList.remove('visible'), 4000);
    return;
  }

  const selectedLangs = [];
  langGrid.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selectedLangs.push(cb.value);
  });

  const settings = {
    useGeminiOAuth: false,
    geminiApiKey,
    geminiTier: tierPaid.checked ? 'paid' : 'free',
    paidSpeed: paidSpeedSelect.value || 'normal',
    selectedModel: modelSelect.value,
    sourceLang: sourceLangSelect.value,
    targetLangs: selectedLangs,
    delayMin: parseInt(delayMinInput.value) || 0,
    delayMax: parseInt(delayMaxInput.value) || 0
  };

  await saveSettings(settings);

  saveStatus.textContent = chrome.i18n.getMessage('optionsSaved') || '저장되었습니다!';
  saveStatus.style.color = '';
  saveStatus.classList.add('visible');
  setTimeout(() => saveStatus.classList.remove('visible'), 2000);
});

// =============================================
// 로그
// =============================================
async function renderLogs() {
  const logs = await getLogs();
  if (logs.length === 0) {
    logPreview.textContent = '로그가 없습니다.';
    return;
  }
  logPreview.textContent = logs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const level = log.level.padEnd(5);
    return `[${time}] ${level} | ${log.message}`;
  }).join('\n');
}

btnCopyLogs.addEventListener('click', async () => {
  const logs = await getLogs();
  try {
    await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
    const orig = btnCopyLogs.textContent;
    btnCopyLogs.textContent = '복사됨!';
    setTimeout(() => btnCopyLogs.textContent = orig, 2000);
  } catch (err) {
    alert('로그 복사 실패: ' + err);
  }
});

btnClearLogs.addEventListener('click', async () => {
  if (!confirm('모든 로그를 삭제하시겠습니까?')) return;
  await clearLogs();
  await renderLogs();
});

// =============================================
// 초기화
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  loadAndApply();
  renderLogs();
});
