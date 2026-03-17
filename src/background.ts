// Combined background service worker

// Booking.com: notify content script on tab update
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { message: 'TabUpdated' }).catch(() => {});
  }
});

// Decathlon: re-inject content script on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/decathlon-pdp.js'],
    });
  },
  { url: [
    { hostContains: 'decathlon.de', pathContains: '/p/' },
    { hostContains: 'decathlon.co.uk', pathContains: '/p/' },
  ]}
);

// Uniqlo: re-inject on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/uniqlo-pdp.js'],
    });
  },
  { url: [{ hostContains: 'uniqlo.com', pathContains: '/products/' }] }
);

// IKEA: re-inject on SPA navigation
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['dist/sites/ikea-pdp.js', 'dist/sites/ikea-plp.js'],
    });
  },
  { url: [{ hostContains: 'ikea.com', pathContains: '/p/' }] }
);
