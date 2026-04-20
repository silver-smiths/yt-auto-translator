/**
 * Chrome Storage 유틸리티 — Gemini 전용
 */
import { DEFAULT_SETTINGS } from './constants.js';

/**
 * 설정 전체 로드 (DEFAULT_SETTINGS로 폴백)
 */
export async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      const saved = result.settings || {};
      // DEFAULT_SETTINGS를 베이스로 저장된 값을 덮어쓰기
      const settings = { ...DEFAULT_SETTINGS, ...saved };
      resolve(settings);
    });
  });
}

/**
 * 설정 저장
 */
export async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}
