/**
 * WipeX Content Script — v1.3.0
 * Filter-aware tweet deletion engine + full-scroll backup
 * Features: session cool-down, pause-on-scroll, adaptive throttle
 */

let wipeRunning      = false;
let backupRunning    = false;
let currentMode      = 'safe';
let deletedCount     = 0;
let filters          = {};
let userScrolling    = false;   // set true when user scrolls; cleared after 3 s
let scrollTimer      = null;
let throttleMultiplier = 1;     // increased when rate-limit signals detected
let rateLimitHits    = 0;

const SELECTORS = {
  tweetMenuBtn:     'button[data-testid="caret"]',
  confirmDeleteBtn: 'button[data-testid="confirmationSheetConfirm"]',
};

console.log('WipeX Content Script Loaded.');

// ── Message routing ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {

    case 'START_SCRAPING':
      if (wipeRunning) return;
      wipeRunning        = true;
      currentMode        = request.mode || 'safe';
      filters            = request.filters || {};
      deletedCount       = 0;
      throttleMultiplier = 1;
      rateLimitHits      = 0;
      // Set up pause-on-scroll watcher if enabled
      if (filters.pauseOnScroll !== false) {
        window.addEventListener('scroll', onUserScroll, { passive: true });
      }
      console.log(`WipeX: Started | mode=${currentMode} | filters=`, filters);
      ensureOnProfilePage().then(() => startWipeLoop());
      break;

    case 'STOP_SCRAPING':
      wipeRunning  = false;
      backupRunning = false;
      window.removeEventListener('scroll', onUserScroll);
      console.log('WipeX: Stopped.');
      break;

    case 'COLLECT_TWEETS':
      collectTweetsWithScroll(request.includeMedia, request.onlyText);
      break;
  }
});

// ── Navigate to own profile before wiping ─────────────────────────────────
async function ensureOnProfilePage() {
  const url = window.location.href;
  // Already on a profile or profile sub-page — OK
  if (/x\.com\/[^/]+\/(with_replies|media)?$/i.test(url)) return;
  if (/twitter\.com\/[^/]+\/(with_replies|media)?$/i.test(url)) return;

  // Try to find the "Profile" nav link in the sidebar
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    profileLink.click();
    await sleep(2000);
    return;
  }

  // Fallback: navigate via username from the profile icon aria-label or href
  const navItems = Array.from(document.querySelectorAll('nav a[href^="/"]'));
  const myProfileLink = navItems.find(a => {
    const h = a.getAttribute('href') || '';
    return h.split('/').length === 2 && h !== '/home' && h !== '/explore' && h !== '/notifications' && h !== '/messages';
  });
  if (myProfileLink) {
    myProfileLink.click();
    await sleep(2000);
  }
}

// ── Main wipe loop ──────────────────────────────────────────────────────────
async function startWipeLoop() {
  const cooldown = (filters.cooldown && filters.cooldown > 0) ? filters.cooldown : 0;

  while (wipeRunning) {
    try {
      // ── Pause-on-scroll: wait until user stops scrolling ─────────────
      if (filters.pauseOnScroll !== false && userScrolling) {
        console.log('WipeX: User scrolling — paused.');
        await sleep(500);
        continue;
      }

      // ── Session cool-down: stop after N tweets ────────────────────────
      if (cooldown > 0 && deletedCount > 0 && deletedCount % cooldown === 0) {
        const pauseMs = 5 * 60 * 1000; // 5-minute break
        console.log(`WipeX: Cool-down reached (${cooldown} tweets). Pausing ${pauseMs / 1000}s.`);
        chrome.runtime.sendMessage({ action: 'REPORT_PROGRESS', success: false });
        await sleep(pauseMs);
        if (!wipeRunning) break;
      }

      // ── Recover from X's "Something went wrong" error state ──────────
      const recovered = await recoverFromErrorState();
      if (recovered) {
        console.log('WipeX: Recovered from error state, continuing...');
        await sleep(1500);
        continue;
      }

      const result = await findAndDeleteNextTweet();

      if (result === 'deleted') {
        deletedCount++;
        // Adaptive throttle: decay multiplier slowly on success
        if (throttleMultiplier > 1) throttleMultiplier = Math.max(1, throttleMultiplier * 0.9);
        chrome.runtime.sendMessage({ action: 'REPORT_PROGRESS', success: true });
      } else if (result === 'skip') {
        chrome.runtime.sendMessage({ action: 'REPORT_PROGRESS', success: false });
      } else {
        // 'none' — no more tweets on screen, scroll down
        window.scrollBy(0, 1500);
        await sleep(2500);
        continue;
      }

      // Adaptive delay + human mimicry every 50 tweets
      const delay = getAdaptiveDelay(currentMode, deletedCount) * throttleMultiplier;
      console.log(`WipeX: Deleted=${deletedCount} | throttle=${throttleMultiplier.toFixed(2)}x | next in ${Math.round(delay)}ms`);
      await sleep(delay);

    } catch (err) {
      console.error('WipeX error:', err);
      chrome.runtime.sendMessage({ action: 'REPORT_PROGRESS', success: false });
      // Bump throttle multiplier on unexpected errors (possible rate limit)
      if (filters.adaptiveThrottle !== false) {
        rateLimitHits++;
        throttleMultiplier = Math.min(5, 1 + rateLimitHits * 0.5);
        console.log(`WipeX: Rate-limit detected. Multiplier now ${throttleMultiplier.toFixed(1)}x`);
      }
      await sleep(3000 * throttleMultiplier);
    }
  }

  // Cleanup scroll listener when loop ends
  window.removeEventListener('scroll', onUserScroll);
}

// ── Core deletion function ─────────────────────────────────────────────────
async function findAndDeleteNextTweet() {
  const menuButtons = Array.from(document.querySelectorAll(SELECTORS.tweetMenuBtn));
  if (!menuButtons.length) return 'none';

  console.log(`WipeX: ${menuButtons.length} tweet(s) visible.`);
  const targetBtn = menuButtons[0];
  const article   = targetBtn.closest('article');

  // ── Filter checks ─────────────────────────────────────────────────
  if (article && !passesTweetFilters(article)) {
    console.log('WipeX: Tweet filtered out. Skipping.');
    targetBtn.closest('article')?.setAttribute('data-wipex-skip', '1');
    targetBtn.style.display = 'none';
    return 'skip';
  }

  // Step 1 — Open tweet menu
  targetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300);
  targetBtn.click();
  await sleep(randomInt(500, 1000));

  // Step 2 — Find Delete option
  const deleteOption = Array.from(document.querySelectorAll('span'))
    .find(el => el.textContent.trim() === 'Delete');

  if (!deleteOption) {
    // No "Delete" option → not our tweet or RT
    document.body.click();
    targetBtn.style.display = 'none';
    return 'skip';
  }

  // Step 3 — Click Delete
  const clickableParent = deleteOption.closest('[role="menuitem"]');
  (clickableParent || deleteOption).click();
  await sleep(randomInt(500, 1200));

  // Step 4 — Confirm
  const confirmBtn = document.querySelector(SELECTORS.confirmDeleteBtn);
  if (confirmBtn) {
    confirmBtn.click();
    // Wait for X to remove the article naturally — do NOT force article.remove()
    await waitForRemoval(article, 4000);
    return 'deleted';
  } else {
    document.body.click();
    targetBtn.style.display = 'none';
    return 'skip';
  }
}

// ── Wait for X to remove article from DOM ──────────────────────────────────
async function waitForRemoval(article, timeout = 4000) {
  if (!article) return;
  const start = Date.now();
  while (document.body.contains(article)) {
    if (Date.now() - start > timeout) {
      article.style.display = 'none';
      break;
    }
    await sleep(200);
  }
}

// ── Detect & recover from X's "Something went wrong" state ─────────────────
async function recoverFromErrorState() {
  const hasError = Array.from(document.querySelectorAll('span, div'))
    .some(el => el.childElementCount === 0 &&
      el.textContent.trim() === 'Something went wrong. Try reloading.');

  if (!hasError) return false;

  console.log('WipeX: Detected error state. Clicking Retry...');
  const retryBtn = Array.from(document.querySelectorAll('button, span'))
    .find(el => el.textContent.trim() === 'Retry' || el.textContent.trim() === 'Try again');
  if (retryBtn) {
    retryBtn.click();
    await sleep(2500);
  } else {
    window.scrollTo(0, 0);
    await sleep(2000);
    window.scrollBy(0, 100);
    await sleep(1000);
  }
  return true;
}

// ── Filter Engine ───────────────────────────────────────────────────────────
function passesTweetFilters(article) {
  const f = filters;

  // ── Tweet Type ──────────────────────────────────────────────────────
  const isRetweet = !!article.querySelector('[data-testid="socialContext"]') ||
                    article.textContent.includes('Retweeted');
  const isReply   = article.dataset.testid === 'reply' ||
                    !!article.querySelector('[data-testid="reply"]') ||
                    !!article.querySelector('a[href*="/replyingTo"]');
  const isQuote   = !!article.querySelector('[data-testid="quoteTweet"]');
  const isOriginal = !isRetweet && !isReply && !isQuote;

  if (isRetweet  && f.typeRetweet  === false) return false;
  if (isReply    && f.typeReply    === false) return false;
  if (isQuote    && f.typeQuote    === false) return false;
  if (isOriginal && f.typeOriginal === false) return false;

  // ── Date Range ──────────────────────────────────────────────────────
  const timeEl = article.querySelector('time');
  if (timeEl) {
    const tweetDate = new Date(timeEl.getAttribute('datetime'));
    if (f.dateFrom) {
      const from = new Date(f.dateFrom);
      if (tweetDate < from) return false;
    }
    if (f.dateTo) {
      const to = new Date(f.dateTo);
      to.setHours(23, 59, 59, 999);
      if (tweetDate > to) return false;
    }
  }

  // ── Keyword Whitelist (keep these tweets) ───────────────────────────
  const text = article.textContent || '';
  if (f.keywordsExclude) {
    const excludeList = f.keywordsExclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (excludeList.some(kw => text.toLowerCase().includes(kw))) return false;
  }

  // ── Keyword Blacklist (only delete matching) ────────────────────────
  if (f.keywordsInclude) {
    const includeList = f.keywordsInclude.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (includeList.length > 0 && !includeList.some(kw => text.toLowerCase().includes(kw))) return false;
  }

  return true;
}

// ── Backup: scroll-all and collect every tweet ──────────────────────────────
// Strategy:
//   1. Scroll to top of the profile page
//   2. Keep scrolling down, collecting articles each pass
//   3. Stop when two consecutive scrolls yield no new tweets (end of timeline)
//   4. Send everything at once to background → popup
async function collectTweetsWithScroll(includeMedia, onlyText) {
  backupRunning = true;
  const seen = new Set(); // track tweet URLs to avoid duplicates
  const allTweets = [];

  // Always start from top
  window.scrollTo(0, 0);
  await sleep(1500);

  let noNewRounds = 0;

  while (backupRunning) {
    const articles = Array.from(document.querySelectorAll('article'));
    let newThisRound = 0;

    for (const article of articles) {
      const linkEl    = article.querySelector('a[href*="/status/"]');
      const tweetUrl  = linkEl ? linkEl.href : null;
      const key       = tweetUrl || article.innerText.slice(0, 80);

      if (seen.has(key)) continue;
      seen.add(key);
      newThisRound++;

      const timeEl   = article.querySelector('time');
      const textEl   = article.querySelector('[data-testid="tweetText"]');
      const text     = textEl ? textEl.textContent : '';
      const datetime = timeEl ? timeEl.getAttribute('datetime') : null;

      if (onlyText) {
        allTweets.push({ text, datetime, url: tweetUrl });
        continue;
      }

      const mediaUrls = [];
      if (includeMedia) {
        article.querySelectorAll('img[src*="pbs.twimg.com"]').forEach(img => {
          if (!img.src.includes('/profile_images/')) mediaUrls.push(img.src);
        });
        article.querySelectorAll('video source').forEach(v => mediaUrls.push(v.src));
      }

      allTweets.push({ text, datetime, url: tweetUrl, mediaUrls });
    }

    // Report progress so popup progress bar updates live
    chrome.runtime.sendMessage({ action: 'BACKUP_PROGRESS', count: allTweets.length });

    if (newThisRound === 0) {
      noNewRounds++;
      if (noNewRounds >= 3) {
        console.log('WipeX Backup: Reached end of timeline.');
        break;
      }
    } else {
      noNewRounds = 0;
    }

    // Scroll down
    window.scrollBy(0, 2000);
    await sleep(1800);
  }

  backupRunning = false;
  chrome.runtime.sendMessage({ action: 'BACKUP_RESULT', tweets: allTweets.filter(t => t.text) });
}

// ── Scroll detection for pause-on-scroll ────────────────────────────────────
function onUserScroll() {
  userScrolling = true;
  clearTimeout(scrollTimer);
  // Consider user inactive after 3 seconds of no scroll
  scrollTimer = setTimeout(() => { userScrolling = false; }, 3000);
}

// ── Delay Helpers ───────────────────────────────────────────────────────────
function getAdaptiveDelay(mode, count) {
  let base = 0;
  switch (mode) {
    case 'fast':   base = randomInt(500,  1500); break;
    case 'normal': base = randomInt(1500, 3000); break;
    case 'safe':
    default:       base = randomInt(3500, 7500); break;
  }
  // Human mimicry: extra rest every 50 deletions
  if (count > 0 && count % 50 === 0) {
    base += randomInt(10000, 20000);
    console.log('WipeX: Human-mimicry cooldown active.');
  }
  return base;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
