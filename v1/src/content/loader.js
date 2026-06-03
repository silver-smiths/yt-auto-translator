/**
 * Content Script Loader
 * MV3 content scripts cannot be modules directly. 
 * This loader uses dynamic import() to load the actual logic as an ES module.
 */
(async () => {
  console.log('[YT-Translator] Loader started');
  try {
    const src = chrome.runtime.getURL('src/content/content-script.js');
    console.log('[YT-Translator] Importing module:', src);
    await import(src);
    console.log('[YT-Translator] Module imported successfully');
  } catch (e) {
    console.error('[YT-Translator] Module loading failed:', e);
    // 폴백: import()가 실패할 경우 (MV3 이슈 등) 
    // 하지만 SyntaxError가 발생하면 이미 파싱 단계에서 실패한 것임
  }
})();
