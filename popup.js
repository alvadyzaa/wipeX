document.addEventListener('DOMContentLoaded', () => {
  // ── Element refs ──────────────────────────────────────────────────
  const btnStart    = document.getElementById('btnStart');
  const btnStop     = document.getElementById('btnStop');
  const btnOptions  = document.getElementById('btnOptions');
  const btnCollect  = document.getElementById('btnCollect');
  const btnExport   = document.getElementById('btnExport');

  const statusBadge = document.getElementById('statusBadge');
  const statusText  = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const backupBar   = document.getElementById('backupBar');
  const backupCount = document.getElementById('backupCount');

  const countDeleted = document.getElementById('countDeleted');
  const countErrors  = document.getElementById('countErrors');
  const countETA     = document.getElementById('countETA');

  const includeMedia = document.getElementById('includeMedia');
  const onlyText     = document.getElementById('onlyText');

  const tabBtns     = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const modeRadios  = document.querySelectorAll('input[name="mode"]');

  // In-memory backup store
  let collectedTweets = [];

  // ── Tab Switching ──────────────────────────────────────────────────
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${target}`).classList.remove('hidden');
    });
  });

  // ── Load Saved State ───────────────────────────────────────────────
  chrome.storage.local.get(['wipeState', 'wipeConfig'], (res) => {
    if (res.wipeConfig?.mode) {
      const radio = document.querySelector(`input[name="mode"][value="${res.wipeConfig.mode}"]`);
      if (radio) radio.checked = true;
    }
    updateDeleteUI(res.wipeState);
  });

  // ── Mode Persistence ───────────────────────────────────────────────
  modeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ wipeConfig: { mode: radio.value } });
    });
  });

  // ── Mutual exclusion for backup toggles ────────────────────────────
  includeMedia.addEventListener('change', () => {
    if (includeMedia.checked) onlyText.checked = false;
  });
  onlyText.addEventListener('change', () => {
    if (onlyText.checked) includeMedia.checked = false;
  });

  // ── Start Wipe ─────────────────────────────────────────────────────
  btnStart.addEventListener('click', () => {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'safe';
    chrome.runtime.sendMessage({ action: 'START_WIPE', mode });
    setRunningState(true);
  });

  // ── Stop Wipe ──────────────────────────────────────────────────────
  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_WIPE' });
    setRunningState(false);
  });

  // ── Options Page ───────────────────────────────────────────────────
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Collect Tweets for Backup (full scroll) ────────────────────────
  btnCollect.addEventListener('click', () => {
    collectedTweets = [];
    backupCount.textContent = '0';
    backupBar.style.width = '0%';
    btnCollect.textContent = '⏳ Collecting...';
    btnCollect.disabled = true;
    if (btnExport) btnExport.classList.add('hidden');

    chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }, (tabs) => {
      if (!tabs.length) {
        btnCollect.textContent = 'Open x.com first';
        btnCollect.disabled = false;
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'COLLECT_TWEETS',
        includeMedia: includeMedia.checked,
        onlyText: onlyText.checked,
      });
    });
  });

  // ── Export Backup as ZIP ───────────────────────────────────────────
  btnExport.addEventListener('click', async () => {
    if (!collectedTweets.length) return;
    btnExport.textContent = '⏳ Packing ZIP...';
    btnExport.disabled = true;

    try {
      const zip = await buildBackupZip(collectedTweets, includeMedia.checked);
      const url = URL.createObjectURL(zip);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wipex-backup-${new Date().toISOString().slice(0,10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('WipeX Export error:', e);
    }

    btnExport.textContent = '⬇ Download ZIP';
    btnExport.disabled = false;
  });

  // ── Message Listener (from background / content) ───────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'UPDATE_STATS') {
      updateDeleteUI(msg.state);
    }

    // Live progress during backup scroll
    if (msg.action === 'BACKUP_PROGRESS') {
      const count = msg.count || 0;
      backupCount.textContent = count;
      // Animate bar indefinitely (can't know total)
      const pct = Math.min((count % 100) + 5, 95);
      backupBar.style.width = pct + '%';
    }

    if (msg.action === 'BACKUP_RESULT') {
      collectedTweets = (msg.tweets || []).filter(t => t.text);
      backupCount.textContent = collectedTweets.length;
      backupBar.style.width = '100%';
      if (btnExport) btnExport.classList.remove('hidden');
      btnCollect.textContent = 'Collect Tweets First';
      btnCollect.disabled = false;
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────
  function setRunningState(running) {
    if (running) {
      btnStart.classList.add('hidden');
      btnStop.classList.remove('hidden');
      statusBadge.className = 'status-badge running';
      statusText.textContent = 'Running...';
    } else {
      btnStop.classList.add('hidden');
      btnStart.classList.remove('hidden');
      statusBadge.className = 'status-badge idle';
      statusText.textContent = 'Idle';
    }
  }

  let startTime = null;

  function updateDeleteUI(state) {
    if (!state) return;

    const deleted = state.deleted || 0;
    const errors  = state.errors  || 0;

    countDeleted.textContent = deleted;
    countErrors.textContent  = errors;

    const pct = Math.min((deleted % 200) / 2, 100);
    progressBar.style.width = pct + '%';

    if (state.isRunning) {
      if (!startTime) startTime = Date.now();
      const elapsed = (Date.now() - startTime) / 1000;
      if (deleted > 0) {
        const rate = deleted / elapsed;
        countETA.textContent = `${rate.toFixed(1)}/s`;
      }
      setRunningState(true);
    } else {
      startTime = null;
      countETA.textContent = 'Infinity/s';
      setRunningState(false);
      if (deleted > 0) {
        statusBadge.className = 'status-badge done';
        statusText.textContent = 'Done ✓';
      }
    }
  }

  // ── Build ZIP using JSZip (loaded in popup.html) ───────────────────
  async function buildBackupZip(tweets, withMedia) {
    // JSZip must be included as a script in popup.html
    const zip = new JSZip(); // eslint-disable-line no-undef

    // tweets.json
    const payload = {
      exportedAt: new Date().toISOString(),
      count: tweets.length,
      tweets: tweets.map(t => ({ text: t.text, datetime: t.datetime, url: t.url })),
    };
    zip.file('tweets.json', JSON.stringify(payload, null, 2));

    // If media URLs included, fetch and add to zip/media/
    if (withMedia) {
      const mediaFolder = zip.folder('media');
      let mIdx = 0;
      for (const tweet of tweets) {
        if (!tweet.mediaUrls || !tweet.mediaUrls.length) continue;
        for (const mUrl of tweet.mediaUrls) {
          try {
            const resp = await fetch(mUrl);
            if (!resp.ok) continue;
            const blob = await resp.blob();
            const ext  = mUrl.split('.').pop().split('?')[0] || 'jpg';
            mediaFolder.file(`media_${++mIdx}.${ext}`, blob);
          } catch (_) { /* skip failed */ }
        }
      }
    }

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }
});
