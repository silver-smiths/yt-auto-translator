/**
 * Popup — 런처 전용
 * 번역 제어는 사이드바에서 담당. 팝업은 Studio 이동 + 설정 열기만 함.
 */
import { installGlobalErrorHandler } from '../lib/logger.js';

installGlobalErrorHandler('popup');

const btnOpenStudio = document.getElementById('btnOpenStudio');
const btnSettings   = document.getElementById('btnSettings');
const tabStatusDot  = document.getElementById('tabStatusDot');
const tabStatusText = document.getElementById('tabStatusText');

// 현재 활성 탭이 YouTube Studio인지 확인
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return setStatus('unknown');

    if (tab.url.includes('studio.youtube.com')) {
      setStatus('studio');
    } else if (tab.url.includes('youtube.com')) {
      setStatus('youtube');
    } else {
      setStatus('other');
    }
  } catch {
    setStatus('unknown');
  }
}

function setStatus(state) {
  const map = {
    studio:  { dot: 'dot-active',  text: 'YouTube Studio 열려 있음 — 사이드바를 사용하세요' },
    youtube: { dot: 'dot-warn',    text: 'YouTube Studio가 아닙니다 (일반 YouTube)' },
    other:   { dot: 'dot-idle',    text: 'YouTube Studio 탭이 없습니다' },
    unknown: { dot: 'dot-idle',    text: '탭 상태를 확인할 수 없습니다' },
  };
  const s = map[state] || map.unknown;
  tabStatusDot.className  = 'tab-status-dot ' + s.dot;
  tabStatusText.textContent = s.text;
}

// YouTube Studio 열기 (이미 열려 있으면 해당 탭으로 포커스)
async function openStudio() {
  const tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://studio.youtube.com' });
  }
  window.close();
}

btnOpenStudio.addEventListener('click', openStudio);
btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

// 초기화
checkCurrentTab();
