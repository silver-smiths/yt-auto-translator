/**
 * Content Script Loader — v2
 * MV3 content scripts cannot be ES modules directly.
 * Dynamically imports sidebar.js on YouTube Studio video edit pages.
 */
(async () => {
  function isVideoEditPage() {
    return /\/video\/[^/]+\/edit/.test(location.pathname);
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
