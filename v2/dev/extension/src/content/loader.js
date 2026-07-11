/**
 * Content Script Loader — v2
 * MV3 content scripts cannot be ES modules directly.
 * Dynamically imports sidebar.js on YouTube Studio video edit pages.
 */
(async () => {
  // 특정 영상의 모든 편집 메뉴에서 동작 (세부정보/분석/편집기/댓글/언어/소유권/클립 등)
  // 공통 경로: /video/{영상ID}/...
  function isVideoEditPage() {
    return /\/video\/[^/]+\//.test(location.pathname);
  }

  async function tryMount() {
    if (!isVideoEditPage()) return;
    if (document.getElementById('ytat-sidebar-root')) return;

    try {
      const src = chrome.runtime.getURL('src/content/sidebar.js');
      const { mount } = await import(src);
      await mount();
    } catch (e) {
      console.error('[YTAT] sidebar mount failed:', e);
    }
  }

  // 초기 마운트
  await tryMount();

  // SPA 네비게이션 감지 (YouTube Studio는 React SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      tryMount();
    }
  }).observe(document, { subtree: true, childList: true });
})();
