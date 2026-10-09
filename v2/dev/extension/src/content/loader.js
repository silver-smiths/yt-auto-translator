/**
 * Content Script Loader — v2
 * MV3 content scripts cannot be ES modules directly.
 * Dynamically imports sidebar.js on YouTube Studio video edit pages.
 */
(async () => {
  // 전역 에러 리포트 (content 컨텍스트) — 단, 우리 확장 파일에서 난 에러만.
  // (content script는 페이지와 window를 공유하므로, 필터 없이는 studio.youtube.com 자체 에러까지 잡혀 도배됨)
  let reportErr = () => {};
  try {
    const logger = await import(chrome.runtime.getURL('src/lib/logger.js'));
    reportErr = (e, ctx) => logger.reportError(e, ctx);
    const EXT_BASE = chrome.runtime.getURL(''); // chrome-extension://<id>/
    self.addEventListener('error', e => {
      if (e.filename && e.filename.startsWith(EXT_BASE)) {
        reportErr(e.error || new Error(e.message), { source: 'content', action: 'global_error' });
      }
    });
    self.addEventListener('unhandledrejection', e => {
      if (String(e.reason?.stack || '').includes(EXT_BASE)) {
        reportErr(e.reason || new Error('Unhandled rejection'), { source: 'content', action: 'unhandled_rejection' });
      }
    });
  } catch { /* 로거 로드 실패는 무시 (본 기능 보호) */ }

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
      reportErr(e, { source: 'content', action: 'sidebar_mount' });
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
