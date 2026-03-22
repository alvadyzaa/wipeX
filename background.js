/**
 * WipeX Background Service Worker — v1.1.0
 * Manages state, coordinates popup ↔ content script messaging,
 * and passes wipeFilters config to content.js on start.
 */

let wipeState = {
  isRunning: false,
  deleted: 0,
  errors: 0,
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── Start Wipe ──────────────────────────────────────────────────────
  if (request.action === 'START_WIPE') {
    wipeState = { isRunning: true, deleted: 0, errors: 0 };
    saveState();

    // Load filters from storage, then pass to content script
    chrome.storage.local.get(['wipeFilters'], (res) => {
      const filters = res.wipeFilters || {};
      chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'START_SCRAPING',
            mode: request.mode || 'safe',
            filters,
          }).catch(() => {});
        });
      });
    });

    sendResponse({ status: 'started' });
  }

  // ── Stop Wipe ───────────────────────────────────────────────────────
  else if (request.action === 'STOP_WIPE') {
    wipeState.isRunning = false;
    saveState();

    chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: 'STOP_SCRAPING' }).catch(() => {});
      });
    });

    sendResponse({ status: 'stopped' });
  }

  // ── Progress from content script ────────────────────────────────────
  else if (request.action === 'REPORT_PROGRESS') {
    if (request.success) {
      wipeState.deleted++;
    } else {
      wipeState.errors++;
    }
    saveState();

    // Push to popup (if open)
    chrome.runtime.sendMessage({ action: 'UPDATE_STATS', state: wipeState }).catch(() => {});
  }

  // ── Backup progress relay from content → popup ──────────────────────
  else if (request.action === 'BACKUP_PROGRESS') {
    chrome.runtime.sendMessage({ action: 'BACKUP_PROGRESS', count: request.count }).catch(() => {});
  }

  // ── Backup result relay from content → popup ────────────────────────
  else if (request.action === 'BACKUP_RESULT') {
    chrome.runtime.sendMessage({ action: 'BACKUP_RESULT', tweets: request.tweets }).catch(() => {});
  }

  return true; // keep message channel open for async sendResponse
});

function saveState() {
  chrome.storage.local.set({ wipeState });
}

// ── Initial install setup ───────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    wipeState:   { isRunning: false, deleted: 0, errors: 0 },
    wipeConfig:  { mode: 'safe' },
    wipeFilters: {
      dateFrom: '', dateTo: '',
      keywordsInclude: '', keywordsExclude: '',
      typeOriginal: true, typeRetweet: true, typeReply: true, typeQuote: true,
      cooldown: 100,
      pauseOnScroll: true,
      adaptiveThrottle: true,
    },
  });
  console.log('WipeX installed. Defaults applied.');
});
