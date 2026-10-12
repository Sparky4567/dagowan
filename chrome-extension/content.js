// Content script: helper for pages. Currently only used to expose the
// current selection to the panel/popup on demand (they use chrome.scripting
// when activeTab is available, this is a fallback no-op listener).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "DAGOWAN_GET_SELECTION") {
    sendResponse({ selection: String(window.getSelection ? window.getSelection().toString() : "") });
    return true;
  }
  return false;
});
