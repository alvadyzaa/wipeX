(function() {
    const STORAGE_KEY_COUNT = 'aff_search_count';
    const STORAGE_KEY_TRIGGERED = 'aff_triggered';
    const STORAGE_KEY_OPENING = 'aff_opening';
    const STORAGE_KEY_VISIT_DAY_PREFIX = 'aff_visit_day';
    const CONFIG_BUILD_VERSION = '20260325-visit-tracking-1';
    const STORAGE_KEY_CONFIG_CACHE = `aff_config_cache_${CONFIG_BUILD_VERSION}`;
    const JAKARTA_TIME_ZONE = 'Asia/Jakarta';
    const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
    const CONFIG_FETCH_TIMEOUT_MS = 5000;
    const STATS_FETCH_TIMEOUT_MS = 1500;

    const scriptTag = document.currentScript || (function() {
        const scripts = document.getElementsByTagName('script');
        return scripts[scripts.length - 1];
    })();
    const SITE_ID = scriptTag ? (scriptTag.getAttribute('data-site') || '').trim() : '';
    const TRACK_MODE = scriptTag ? (scriptTag.getAttribute('data-track-mode') || 'auto').trim().toLowerCase() : 'auto';
    const CONFIG_URL = scriptTag ? (scriptTag.getAttribute('data-config-url') || '').trim() : '';
    const STATS_URL = scriptTag ? (scriptTag.getAttribute('data-stats-url') || 'https://ads-stats-worker.derazelmiku.workers.dev').trim() : 'https://ads-stats-worker.derazelmiku.workers.dev';

    let cachedConfig = null;
    let cachedConfigFetchedAt = 0;
    let configPromise = null;
    let lastInteractionAt = 0;
    const INTERACTION_DEDUPE_MS = 750;
    const SEARCH_FIELD_TOKEN_RE = /\b(search|cari|query|keyword|find|lookup|username|user\s*name|handle|account|profil(?:e)?|profile)\b/i;
    const SEARCH_ACTION_TOKEN_RE = /\b(search|cari|query|keyword|find|lookup|check|cek|submit|go)\b/i;
    const SECONDARY_ACTION_TOKEN_RE = /\b(deep\s*scan|scan\s*deep|full\s*scan|advanced\s*scan|rescan|retry|refresh|share|copy|download|details?|detail|show\s*more|load\s*more|back|next|prev|close|dismiss)\b/i;

    function getJakartaDateParts(date) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: JAKARTA_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(date || new Date());

        return parts.reduce((acc, part) => {
            if (part.type !== 'literal') acc[part.type] = part.value;
            return acc;
        }, {});
    }

    function getJakartaDayKey(date) {
        const { year, month, day } = getJakartaDateParts(date);
        return `${year}${month}${day}`;
    }

    function getCurrentHost() {
        return (window.location.hostname || SITE_ID || 'localhost').trim();
    }

    function getVisitStorageKey() {
        return `${STORAGE_KEY_VISIT_DAY_PREFIX}_${getCurrentHost().toLowerCase()}`;
    }

    function hasTrackedVisitToday(dayKey) {
        const storageKey = getVisitStorageKey();

        try {
            if (sessionStorage.getItem(storageKey) === dayKey) return true;
        } catch (e) {}

        try {
            return localStorage.getItem(storageKey) === dayKey;
        } catch (e) {
            return false;
        }
    }

    function markVisitTracked(dayKey) {
        const storageKey = getVisitStorageKey();

        try {
            localStorage.setItem(storageKey, dayKey);
        } catch (e) {}

        try {
            sessionStorage.setItem(storageKey, dayKey);
        } catch (e) {}
    }

    function getSiteKeys() {
        const keys = [getCurrentHost()];
        if (SITE_ID) keys.push(SITE_ID);
        return Array.from(new Set(keys.filter(Boolean)));
    }

    function isConfigFresh() {
        return !!cachedConfig && (Date.now() - cachedConfigFetchedAt) < CONFIG_CACHE_TTL_MS;
    }

    function getCachedConfig() {
        return isConfigFresh() ? cachedConfig : null;
    }

    function getLocalConfigUrl() {
        return new URL('ads-config.json', getLoaderBaseUrl()).toString();
    }

    function getRemoteConfigUrl() {
        return buildStatsUrl('/config');
    }

    function getPrimaryConfigUrl() {
        return CONFIG_URL || getRemoteConfigUrl() || getLocalConfigUrl();
    }

    function buildStatsUrl(path) {
        const base = String(STATS_URL || '').trim().replace(/\/+$/, '');
        return base ? base + path : '';
    }

    function fetchWithTimeout(url, options, timeoutMs) {
        const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CONFIG_FETCH_TIMEOUT_MS;
        if (typeof AbortController !== 'function') {
            return Promise.race([
                fetch(url, options),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), timeout))
            ]);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const requestOptions = Object.assign({}, options, { signal: controller.signal });

        return fetch(url, requestOptions).finally(() => {
            clearTimeout(timer);
        });
    }

    function appendCacheBuster(url, version) {
        const separator = url.indexOf('?') >= 0 ? '&' : '?';
        return `${url}${separator}v=${encodeURIComponent(version || CONFIG_BUILD_VERSION)}-${Date.now()}`;
    }

    function persistConfig(data) {
        try {
            localStorage.setItem(STORAGE_KEY_CONFIG_CACHE, JSON.stringify({
                fetchedAt: Date.now(),
                data: data
            }));
        } catch (e) {}
    }

    function readPersistedConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_CONFIG_CACHE);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            return parsed && parsed.data ? parsed.data : null;
        } catch (e) {
            return null;
        }
    }

    async function fetchConfigFromSources() {
        const remoteUrl = appendCacheBuster(getPrimaryConfigUrl());
        const localUrl = appendCacheBuster(getLocalConfigUrl());

        try {
            const res = await fetchWithTimeout(remoteUrl, { cache: 'no-store' }, CONFIG_FETCH_TIMEOUT_MS);
            if (!res.ok) throw new Error('Config fetch failed');

            const data = await res.json();
            if (data && typeof data === 'object') {
                persistConfig(data);
                return data;
            }
        } catch (e) {}

        const persisted = readPersistedConfig();
        if (persisted) return persisted;

        if (remoteUrl === localUrl) {
            throw new Error('All config sources failed');
        }

        try {
            const res = await fetchWithTimeout(localUrl, { cache: 'no-store' }, CONFIG_FETCH_TIMEOUT_MS);
            if (!res.ok) throw new Error('Config fetch failed');

            const data = await res.json();
            if (data && typeof data === 'object') {
                return data;
            }
        } catch (e) {}

        throw new Error('All config sources failed');
    }

    function applyLoadedConfig(data) {
        cachedConfig = data;
        cachedConfigFetchedAt = Date.now();
        return data;
    }

    function fetchConfig(forceRefresh) {
        if (!forceRefresh && isConfigFresh()) {
            return Promise.resolve(cachedConfig);
        }

        if (configPromise) return configPromise;

        configPromise = fetchConfigFromSources()
            .then(applyLoadedConfig)
            .finally(() => {
                configPromise = null;
            });

        return configPromise;
    }

    function primeConfigCache() {
        fetchConfig(false).catch(() => {});
    }

    function getWeightedLink(links) {
        if (!links || links.length === 0) return null;
        if (links.length === 1) return links[0].url;

        const totalWeight = links.reduce((sum, link) => sum + (link.weight || 1), 0);
        let rand = Math.random() * totalWeight;

        for (const link of links) {
            const weight = link.weight || 1;
            if (rand < weight) return link.url;
            rand -= weight;
        }

        return links[0].url;
    }

    function readPositiveInt(value) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function getScriptTriggerOverride() {
        if (!scriptTag || !scriptTag.hasAttribute('data-trigger')) return null;
        return readPositiveInt(scriptTag.getAttribute('data-trigger'));
    }

    function isManualTrackingMode() {
        return TRACK_MODE === 'manual';
    }

    function getAdTriggerCount(ad) {
        const fromAttr = getScriptTriggerOverride();
        if (fromAttr) return fromAttr;

        const fromAd = readPositiveInt(ad && ad.trigger_count);
        return fromAd || 1;
    }

    function matchesTarget(currentKeys, target) {
        if (!target) return false;
        return currentKeys.some(key => key === target || key.endsWith('.' + target));
    }

    function passesFrequencyRules(ad) {
        const id = ad.id;
        const freq = ad.frequency || {};

        if (freq.hide_after_click !== false && localStorage.getItem('ad_' + id + '_clicked')) {
            return false;
        }

        if (freq.once_per_24h !== false) {
            const lastShown = localStorage.getItem('ad_' + id + '_last_shown');
            if (lastShown) {
                const hoursSince = (Date.now() - new Date(lastShown).getTime()) / 36e5;
                if (hoursSince < 24) return false;
            }
        }

        return true;
    }

    function passesSchedule(ad) {
        const sched = ad.schedule || {};
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (sched.start_date && today < new Date(sched.start_date)) return false;
        if (sched.end_date && today > new Date(sched.end_date)) return false;
        return true;
    }

    function getValidAds(data, interactionCount, respectFrequency) {
        const currentKeys = getSiteKeys();

        return (data && data.ads ? data.ads : []).filter(ad => {
            const status = ad.status || (ad.active ? 'active' : 'paused');
            if (status !== 'active') return false;

            const targets = ad.target_websites ||
                (ad.targets ? ad.targets.split(',').map(t => t.trim()) : []);
            if (targets.length && !targets.some(target => matchesTarget(currentKeys, target))) {
                return false;
            }

            if (!passesSchedule(ad)) return false;
            if (respectFrequency && !passesFrequencyRules(ad)) return false;
            if (Number.isFinite(interactionCount) && interactionCount < getAdTriggerCount(ad)) return false;

            return true;
        });
    }

    function selectAd(data, interactionCount, respectFrequency) {
        const validAds = getValidAds(data, interactionCount, respectFrequency);
        if (validAds.length === 0) return null;

        const pool = [];
        for (const ad of validAds) {
            const links = ad.links || (ad.link ? [{ url: ad.link, weight: 100 }] : []);
            for (const link of links) {
                if (link.url) {
                    pool.push({
                        adId: ad.id,
                        url: link.url,
                        weight: link.weight || 1
                    });
                }
            }
        }

        if (pool.length === 0) return null;

        const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
        let rand = Math.random() * totalWeight;
        let chosen = pool[0];

        for (const entry of pool) {
            if (rand < entry.weight) {
                chosen = entry;
                break;
            }
            rand -= entry.weight;
        }

        const ownerAd = validAds.find(ad => ad.id === chosen.adId) || validAds[0];
        return {
            ad: ownerAd,
            url: chosen.url
        };
    }

    function getMinimumMatchingTriggerCount(data) {
        const currentKeys = getSiteKeys();
        let min = null;

        for (const ad of (data && data.ads ? data.ads : [])) {
            const status = ad.status || (ad.active ? 'active' : 'paused');
            if (status !== 'active') continue;

            const targets = ad.target_websites ||
                (ad.targets ? ad.targets.split(',').map(t => t.trim()) : []);
            if (targets.length && !targets.some(target => matchesTarget(currentKeys, target))) {
                continue;
            }

            if (!passesSchedule(ad)) continue;

            const triggerCount = getAdTriggerCount(ad);
            min = min === null ? triggerCount : Math.min(min, triggerCount);
        }

        return min;
    }

    function resolveThreshold() {
        const override = getScriptTriggerOverride();
        if (override) return override;

        const cached = getCachedConfig() || readPersistedConfig();
        const minimum = getMinimumMatchingTriggerCount(cached);
        return minimum || 1;
    }

    function getLoaderBaseUrl() {
        try {
            const src = scriptTag && scriptTag.src ? scriptTag.src : window.location.href;
            return new URL('./', src).toString();
        } catch (e) {
            return window.location.origin + '/';
        }
    }

    function buildBridgeUrl(selection, interactionCount) {
        const bridgeUrl = new URL('redirect.html', getLoaderBaseUrl());
        bridgeUrl.searchParams.set('config', getPrimaryConfigUrl());
        bridgeUrl.searchParams.set('stats', STATS_URL);
        bridgeUrl.searchParams.set('host', getCurrentHost());
        bridgeUrl.searchParams.set('site', SITE_ID);
        bridgeUrl.searchParams.set('count', String(interactionCount || 0));

        if (selection && selection.ad && selection.ad.id) {
            bridgeUrl.searchParams.set('ad', selection.ad.id);
        }
        if (selection && selection.url) {
            bridgeUrl.searchParams.set('target', selection.url);
            bridgeUrl.searchParams.set('tracked', '1');
        }

        return bridgeUrl.toString();
    }

    function openDestination(url, useCurrentTab, preparedWindow) {
        if (useCurrentTab) {
            window.location.assign(url);
            return;
        }

        if (preparedWindow && !preparedWindow.closed) {
            try {
                preparedWindow.location.replace(url);
                return;
            } catch (e) {}
        }

        let opened = preparedWindow && !preparedWindow.closed ? preparedWindow : null;
        try {
            if (!opened) {
                opened = window.open(url, '_blank');
            }
        } catch (e) {}

        if (!opened) {
            window.location.assign(url);
        }
    }

    function markAdOpened(adId) {
        localStorage.setItem('ad_' + adId + '_last_shown', new Date().toISOString());

        const impressions = parseInt(localStorage.getItem('ad_' + adId + '_impressions') || '0', 10);
        localStorage.setItem('ad_' + adId + '_impressions', String(impressions + 1));

        localStorage.setItem('ad_' + adId + '_clicked', 'true');

        const clicks = parseInt(localStorage.getItem('ad_' + adId + '_clicks') || '0', 10);
        localStorage.setItem('ad_' + adId + '_clicks', String(clicks + 1));
    }

    function trackCentralClick(adId) {
        const trackUrl = buildStatsUrl('/track');
        if (!trackUrl || !adId) return Promise.resolve();

        try {
            const ua = navigator.userAgent || '';
            const device = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop';
            const region = (function() {
                try {
                    return Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/\//g, '_');
                } catch (e) {
                    return 'unknown';
                }
            })();
            const payload = {
                adId: adId,
                site: getCurrentHost(),
                device: device,
                region: region
            };

            return fetchWithTimeout(trackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,
                mode: 'cors'
            }, STATS_FETCH_TIMEOUT_MS)
                .catch(() => {});
        } catch (e) {
            return Promise.resolve();
        }
    }

    function trackCentralVisit() {
        const visitUrl = buildStatsUrl('/visits');
        const currentHost = getCurrentHost();
        if (!visitUrl || !currentHost) return Promise.resolve();

        const dayKey = getJakartaDayKey();
        if (hasTrackedVisitToday(dayKey)) return Promise.resolve();

        try {
            return fetchWithTimeout(visitUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ site: currentHost }),
                keepalive: true,
                mode: 'cors'
            }, STATS_FETCH_TIMEOUT_MS)
                .then(function(res) {
                    if (!res.ok) throw new Error('Visit track failed');
                    markVisitTracked(dayKey);
                })
                .catch(() => {});
        } catch (e) {
            return Promise.resolve();
        }
    }

    function isLikelyInAppBrowser() {
        const ua = navigator.userAgent || '';
        const isIOS = /iPhone|iPad|iPod/i.test(ua);
        const hasKnownToken = /Twitter|X-Lite|Instagram|FBAN|FBAV|FB_IAB|TikTok|Snapchat|Line|NAVER|MicroMessenger|LinkedInApp|Pinterest|wv/i.test(ua);

        if (isIOS) {
            return hasKnownToken || (!/Safari\//.test(ua) || !/Version\//.test(ua));
        }

        return hasKnownToken;
    }

    function getSelectorTokens(element) {
        if (!element) return '';

        const textContent = typeof element.textContent === 'string'
            ? element.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)
            : '';
        const values = [
            element.id,
            element.name,
            element.className,
            element.getAttribute && element.getAttribute('role'),
            element.getAttribute && element.getAttribute('aria-label'),
            element.getAttribute && element.getAttribute('placeholder'),
            element.getAttribute && element.getAttribute('title'),
            element.getAttribute && element.getAttribute('value'),
            element.getAttribute && element.getAttribute('action'),
            element.getAttribute && element.getAttribute('type'),
            element.tagName,
            textContent
        ];

        return values.filter(Boolean).join(' ').toLowerCase();
    }

    function controlLooksLikeSecondaryAction(control) {
        if (!control) return false;
        if (control.hasAttribute && control.hasAttribute('data-aff-search-ignore')) return true;
        return SECONDARY_ACTION_TOKEN_RE.test(getSelectorTokens(control));
    }

    function elementLooksLikeSearchField(field) {
        if (!field) return false;

        const type = (field.getAttribute('type') || '').toLowerCase();
        const tokens = getSelectorTokens(field);
        const exactName = (field.name || '').toLowerCase();

        if (type === 'search') return true;
        if (field.tagName === 'INPUT' && exactName === 'q') return true;
        if (field.tagName === 'INPUT' && /^(username|user|handle|account)$/.test(exactName)) return true;

        return SEARCH_FIELD_TOKEN_RE.test(tokens);
    }

    function getTextLikeFields(root) {
        if (!root) return [];

        return Array.from(root.querySelectorAll('input, textarea')).filter(field => {
            if (field.tagName === 'TEXTAREA') return true;
            const type = (field.getAttribute('type') || 'text').toLowerCase();
            return ['', 'text', 'search'].includes(type);
        });
    }

    function hasSensitiveFields(root) {
        if (!root) return false;

        const blockedInput = root.querySelector('input[type="password"], input[type="email"], input[type="tel"], input[type="file"]');
        return !!blockedInput;
    }

    function getSearchSubmitButtons(root) {
        if (!root) return [];

        return Array.from(root.querySelectorAll('button, input[type="submit"], button[type="submit"]')).filter(control => {
            if (control.disabled) return false;
            if (controlLooksLikeSecondaryAction(control)) return false;
            const tokens = getSelectorTokens(control);
            const type = (control.getAttribute && control.getAttribute('type') || '').toLowerCase();
            return type === 'submit' || SEARCH_ACTION_TOKEN_RE.test(tokens);
        });
    }

    function controlLooksIconOnly(control) {
        if (!control) return false;

        const text = (control.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 2) return false;
        if (control.querySelector('svg, img')) return true;
        return text.length === 0;
    }

    function findSearchContextForControl(control) {
        let node = control;
        for (let depth = 0; node && depth < 5; depth += 1) {
            if (node.matches && node.matches('[data-aff-search-form], form, section, article, main, div')) {
                const textFields = getTextLikeFields(node);
                if (textFields.length >= 1 && !hasSensitiveFields(node)) {
                    return node;
                }
            }
            node = node.parentElement;
        }
        return null;
    }

    function isLastActionButton(control, context) {
        if (!control || !context) return false;

        const buttons = Array.from(context.querySelectorAll('button, input[type="submit"], button[type="submit"]'))
            .filter(node => !node.disabled);

        return buttons.length > 0 && buttons[buttons.length - 1] === control;
    }

    function formLooksLikeSearch(form) {
        if (!form) return false;

        if (form.hasAttribute('data-aff-search-form')) return true;

        const explicitSelector = scriptTag ? scriptTag.getAttribute('data-search-form-selector') : '';
        if (explicitSelector) {
            try {
                if (form.matches(explicitSelector)) return true;
            } catch (e) {}
        }

        const tokens = getSelectorTokens(form);
        if (SEARCH_FIELD_TOKEN_RE.test(tokens)) return true;

        const fields = form.querySelectorAll('input, textarea');
        for (const field of fields) {
            if (elementLooksLikeSearchField(field)) return true;
        }

        const textFields = getTextLikeFields(form);
        const submitButtons = getSearchSubmitButtons(form);
        if (!hasSensitiveFields(form) && textFields.length >= 1 && submitButtons.length >= 1) {
            return true;
        }

        return false;
    }

    function isPrimarySearchControl(control, context) {
        if (!control || !context) return false;

        const buttons = getSearchSubmitButtons(context);
        if (buttons.length === 0) return false;
        if (buttons.length === 1) return buttons[0] === control;

        const searchNamedButtons = buttons.filter(node => SEARCH_ACTION_TOKEN_RE.test(getSelectorTokens(node)));
        if (searchNamedButtons.length === 0) return buttons[0] === control;
        if (searchNamedButtons.length === 1) return searchNamedButtons[0] === control;
        return searchNamedButtons[0] === control;
    }

    function submitControlLooksLikeSearch(control) {
        if (!control) return false;
        if (controlLooksLikeSecondaryAction(control)) return false;

        if (control.hasAttribute('data-aff-search-trigger')) return true;

        const explicitSelector = scriptTag ? scriptTag.getAttribute('data-search-submit-selector') : '';
        if (explicitSelector) {
            try {
                if (control.matches(explicitSelector)) return true;
            } catch (e) {}
        }

        const controlType = (control.getAttribute && control.getAttribute('type') || '').toLowerCase();
        if (formLooksLikeSearch(control.form)) {
            if (SEARCH_ACTION_TOKEN_RE.test(getSelectorTokens(control))) return true;
            if (controlType === 'submit') return isPrimarySearchControl(control, control.form);
        }

        const searchContext = findSearchContextForControl(control);
        if (searchContext && controlLooksIconOnly(control) && isLastActionButton(control, searchContext)) return true;
        if (searchContext && isPrimarySearchControl(control, searchContext)) return true;

        const tokens = getSelectorTokens(control);
        return SEARCH_ACTION_TOKEN_RE.test(tokens);
    }

    function clearOpeningFlag() {
        sessionStorage.removeItem(STORAGE_KEY_OPENING);
    }

    function closePreparedWindow(preparedWindow) {
        if (!preparedWindow || preparedWindow.closed) return;
        try {
            preparedWindow.close();
        } catch (e) {}
    }

    function triggerOpen(interactionCount) {
        if (sessionStorage.getItem(STORAGE_KEY_TRIGGERED)) return;
        if (sessionStorage.getItem(STORAGE_KEY_OPENING)) return;

        sessionStorage.setItem(STORAGE_KEY_OPENING, 'true');

        const useCurrentTab = isLikelyInAppBrowser();
        const preparedWindow = useCurrentTab ? null : (function() {
            try {
                return window.open('', '_blank');
            } catch (e) {
                return null;
            }
        })();
        const cached = getCachedConfig();

        function openSelection(selection) {
            if (!selection || !selection.url) {
                closePreparedWindow(preparedWindow);
                clearOpeningFlag();
                return;
            }

            sessionStorage.setItem(STORAGE_KEY_TRIGGERED, 'true');
            clearOpeningFlag();
            markAdOpened(selection.ad.id);
            trackCentralClick(selection.ad.id);
            openDestination(selection.url, useCurrentTab, preparedWindow);
        }

        if (cached) {
            const selection = selectAd(cached, interactionCount, true);
            openSelection(selection);
            return;
        }

        fetchConfig(false)
            .then(function(data) {
                const selection = selectAd(data, interactionCount, true);
                openSelection(selection);
            })
            .catch(function() {
                closePreparedWindow(preparedWindow);
                clearOpeningFlag();
            });
    }

    function trackInteraction() {
        if (sessionStorage.getItem(STORAGE_KEY_TRIGGERED)) return;

        const now = Date.now();
        if ((now - lastInteractionAt) < INTERACTION_DEDUPE_MS) return;
        lastInteractionAt = now;

        let count = parseInt(sessionStorage.getItem(STORAGE_KEY_COUNT) || '0', 10);
        count += 1;
        sessionStorage.setItem(STORAGE_KEY_COUNT, String(count));

        if (count >= resolveThreshold()) {
            triggerOpen(count);
        }
    }

    primeConfigCache();
    trackCentralVisit();

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible' && !isConfigFresh()) {
            primeConfigCache();
        }
    });

    window.onUserSearchPerformed = trackInteraction;

    if (!isManualTrackingMode()) {
        document.addEventListener('click', function(e) {
            const el = e.target.closest('input[type="submit"], button, [role="button"], a');
            if (el && submitControlLooksLikeSearch(el)) trackInteraction();
        }, true);

        document.addEventListener('submit', function(e) {
            if (!formLooksLikeSearch(e.target)) return;
            if (e.submitter && !submitControlLooksLikeSearch(e.submitter)) return;
            trackInteraction();
        }, true);
    }
})();
