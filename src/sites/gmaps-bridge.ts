// Runs in ISOLATED world — bridges chrome.storage to MAIN world via DOM
chrome.storage.sync.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) {
    document.documentElement.dataset.tsGeminiKey = geminiApiKey;
  }
});
