// UI 다국어 헬퍼 — chrome.i18n 래퍼.
// 브라우저 UI 언어에 맞는 _locales/<lang>/messages.json이 자동 선택되고,
// 없으면 manifest.default_locale(=en)로 폴백된다.

// 문자열 조회. subs는 placeholder($1,$2..) 치환값. 누락 키는 fallback(또는 키)을 반환.
export function t(key, subs, fallback) {
  const m = chrome.i18n.getMessage(key, subs);
  return m || fallback || key;
}

// 정적 HTML 치환:
//  data-i18n        → textContent
//  data-i18n-html   → innerHTML (locale 문자열은 우리 소유·신뢰)
//  data-i18n-ph     → placeholder
//  data-i18n-title  → title
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    const m = chrome.i18n.getMessage(el.dataset.i18nHtml);
    if (m) el.innerHTML = m;
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const m = chrome.i18n.getMessage(el.dataset.i18nPh);
    if (m) el.setAttribute('placeholder', m);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const m = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (m) el.setAttribute('title', m);
  });
}
