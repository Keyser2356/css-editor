if (!window.__cssEditorInit) {
  window.__cssEditorInit = true;

  const STYLE_ID = 'css-editor-injected';

  function normalizeDomain(h) {
    return h.replace(/^www\./, '');
  }

  function addImportant(css) {
    // Add !important to every property value, skip comments and @rules lines
    return css.replace(
      /([^{}:\/\*]+):([^;{}]+)(;)/g,
      (match, prop, val, semi) => {
        const trimVal = val.trim();
        if (trimVal.endsWith('!important')) return match;
        return `${prop}:${val} !important${semi}`;
      }
    );
  }

  function applyCSS(css) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
    }
    el.textContent = css ? addImportant(css) : '';
    // Always move to end of head — last stylesheet wins on equal specificity
    const parent = document.head || document.documentElement;
    parent.appendChild(el);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'APPLY_CSS') applyCSS(msg.css);
    if (msg.type === 'REMOVE_CSS') {
      const el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    }
  });

  (async () => {
    const domain = normalizeDomain(location.hostname);
    const storage = await browser.storage.local.get(null);
    const site = storage[`site:${domain}`] || {};
    const parts = [];

    if (site.enabled) {
      for (const id of (site.activePresets || [])) {
        const preset = storage[`preset:${id}`];
        if (preset && preset.css) parts.push(preset.css);
      }
    }

    const draft = storage[`draft:${domain}`];
    if (draft && draft.trim()) parts.push(draft);

    if (parts.length) applyCSS(parts.join('\n'));
  })();
}
