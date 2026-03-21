if (!window.__cssEditorInit) {
  window.__cssEditorInit = true;

  const STYLE_ID = 'css-editor-injected';

  function applyCSS(css) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css || '';
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'APPLY_CSS') applyCSS(msg.css);
    if (msg.type === 'REMOVE_CSS') {
      const el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    }
  });

  (async () => {
    const domain = location.hostname;
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
