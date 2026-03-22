const DEFAULTS = {
  dateFrom: '',
  dateTo: '',
  keywordsInclude: '',
  keywordsExclude: '',
  typeOriginal: true,
  typeRetweet: true,
  typeReply: true,
  typeQuote: true,
  cooldown: 100,
  pauseOnScroll: true,
  adaptiveThrottle: true,
};

const fields = [
  'dateFrom', 'dateTo',
  'keywordsInclude', 'keywordsExclude',
  'typeOriginal', 'typeRetweet', 'typeReply', 'typeQuote',
  'cooldown', 'pauseOnScroll', 'adaptiveThrottle',
];

document.addEventListener('DOMContentLoaded', () => {
  const btnSave  = document.getElementById('btnSave');
  const btnReset = document.getElementById('btnReset');
  const toast    = document.getElementById('toast');

  // ── Load saved config ───────────────────────────────────────────────
  chrome.storage.local.get(['wipeFilters'], (res) => {
    const saved = res.wipeFilters || {};
    applyConfig({ ...DEFAULTS, ...saved });
  });

  // ── Save ────────────────────────────────────────────────────────────
  btnSave.addEventListener('click', () => {
    const config = readConfig();
    chrome.storage.local.set({ wipeFilters: config }, () => {
      showToast();
    });
  });

  // ── Reset ───────────────────────────────────────────────────────────
  btnReset.addEventListener('click', () => {
    applyConfig(DEFAULTS);
    chrome.storage.local.set({ wipeFilters: DEFAULTS });
    showToast('Reset to defaults');
  });

  // ── Read current form values ────────────────────────────────────────
  function readConfig() {
    return {
      dateFrom:          document.getElementById('dateFrom').value,
      dateTo:            document.getElementById('dateTo').value,
      keywordsInclude:   document.getElementById('keywordsInclude').value,
      keywordsExclude:   document.getElementById('keywordsExclude').value,
      typeOriginal:      document.getElementById('typeOriginal').checked,
      typeRetweet:       document.getElementById('typeRetweet').checked,
      typeReply:         document.getElementById('typeReply').checked,
      typeQuote:         document.getElementById('typeQuote').checked,
      cooldown:          parseInt(document.getElementById('cooldown').value, 10) || 100,
      pauseOnScroll:     document.getElementById('pauseOnScroll').checked,
      adaptiveThrottle:  document.getElementById('adaptiveThrottle').checked,
    };
  }

  // ── Apply config to form ────────────────────────────────────────────
  function applyConfig(cfg) {
    document.getElementById('dateFrom').value           = cfg.dateFrom || '';
    document.getElementById('dateTo').value             = cfg.dateTo   || '';
    document.getElementById('keywordsInclude').value    = cfg.keywordsInclude || '';
    document.getElementById('keywordsExclude').value    = cfg.keywordsExclude || '';
    document.getElementById('typeOriginal').checked     = cfg.typeOriginal  ?? true;
    document.getElementById('typeRetweet').checked      = cfg.typeRetweet   ?? true;
    document.getElementById('typeReply').checked        = cfg.typeReply     ?? true;
    document.getElementById('typeQuote').checked        = cfg.typeQuote     ?? true;
    document.getElementById('cooldown').value           = cfg.cooldown      ?? 100;
    document.getElementById('pauseOnScroll').checked    = cfg.pauseOnScroll ?? true;
    document.getElementById('adaptiveThrottle').checked = cfg.adaptiveThrottle ?? true;
  }

  // ── Toast ───────────────────────────────────────────────────────────
  function showToast(msg) {
    if (msg) {
      toast.childNodes[toast.childNodes.length - 1].textContent = ' ' + msg;
    } else {
      toast.childNodes[toast.childNodes.length - 1].textContent = ' Settings saved successfully';
    }
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
});
