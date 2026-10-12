// Background service worker: context menu "Ask Dagowan" -> stash selection,
// open the side panel widget (popup fallback on browsers without sidePanel).
// Popup auto-sends the stashed text over the voice-bridge WS, same as the panel.
const hasSidePanel = Boolean(
  typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior
);

if (hasSidePanel) {
  chrome.runtime.onInstalled.addListener(() => {
    // Toolbar icon click opens the side panel instead of the popup
    // (Chrome 114+; older builds keep the popup fallback).
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ask-dagowan",
    title: "Ask Dagowan about selection",
    contexts: ["selection"]
  });
});

async function openWidget() {
  if (hasSidePanel) {
    try {
      await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      return;
    } catch (_) {
      // Fall through to the popup fallback below.
    }
  }
  try {
    await chrome.action.openPopup();
  } catch (_) {
    // openPopup needs user gesture on some Chrome versions; stash survives
    // until the user opens the side panel / popup manually.
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "ask-dagowan") return;
  const text = (info.selectionText || "").trim().slice(0, 2000);
  if (!text) return;
  await chrome.storage.local.set({ pendingPrompt: text });
  await openWidget();
});
