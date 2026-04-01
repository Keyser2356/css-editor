// MV3 content script — works in both Chrome and Firefox
// Uses browser.* API (Firefox MV3 supports chrome namespace)

if (!window.__cssEditorInit) {
  window.__cssEditorInit = true;

  const STYLE_ID = 'css-editor-injected';
  const TW_ID = 'css-editor-tailwind-runtime';
  const TW_CFG_ID = 'css-editor-tailwind-config';

  function normalizeDomain(h) {
    return h.replace(/^www\./, '');
  }

  function addImportant(css) {
    return css.replace(
      /([^{}:\/\*]+):([^;{}]+)(;)/g,
      (match, prop, val, semi) => {
        if (val.trim().endsWith('!important')) return match;
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
    const parent = document.head || document.documentElement;
    parent.appendChild(el);
  }

  function applyTailwind(enabled) {
    const existing = document.getElementById(TW_ID);
    const existingCfg = document.getElementById(TW_CFG_ID);
    if (!enabled) {
      if (existing) existing.remove();
      if (existingCfg) existingCfg.remove();
      return;
    }
    if (existing) return;
    if (!existingCfg) {
      // Disable Tailwind preflight reset to avoid changing site fonts/base styles.
      const cfg = document.createElement('script');
      cfg.id = TW_CFG_ID;
      cfg.textContent = 'window.tailwind = window.tailwind || {}; window.tailwind.config = Object.assign({}, window.tailwind.config || {}, { corePlugins: Object.assign({}, (window.tailwind && window.tailwind.config && window.tailwind.config.corePlugins) || {}, { preflight: false }) });';
      (document.head || document.documentElement).appendChild(cfg);
    }
    const s = document.createElement('script');
    s.id = TW_ID;
    s.src = 'https://cdn.tailwindcss.com';
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  }

  function condMatches(preset, url) {
    const c = (preset && preset.conditions) || {};
    if (!c.urlContains) return true;
    return (url || '').includes(String(c.urlContains));
  }

  function uniqueSelector(el) {
    if (!el || !el.tagName) return '';
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) sel += '.' + [...node.classList].slice(0, 2).join('.');
      const parent = node.parentElement;
      if (parent) {
        const idx = [...parent.children].indexOf(node) + 1;
        sel += `:nth-child(${idx})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function cssColorToHex(color) {
    // Supports rgb(a) and #RRGGBB / #RGB
    if (!color) return '#000000';
    const c = String(color).trim().toLowerCase();
    if (c.startsWith('#')) {
      if (c.length === 4) {
        const r = c[1], g = c[2], b = c[3];
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
      }
      if (c.length === 7) return c.toUpperCase();
    }
    const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/i);
    if (!m) return '#000000';
    const r = Math.max(0, Math.min(255, parseInt(m[1], 10)));
    const g = Math.max(0, Math.min(255, parseInt(m[2], 10)));
    const b = Math.max(0, Math.min(255, parseInt(m[3], 10)));
    const toHex = (n) => n.toString(16).padStart(2, '0');
    return ('#' + toHex(r) + toHex(g) + toHex(b)).toUpperCase();
  }

  function parsePxValue(v) {
    // Accepts '16px' -> { num: 16, unit: 'px' } and '16' -> { num: 16, unit: '' }
    const s = String(v || '').trim();
    const m = s.match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
    if (!m) return { num: '', unit: '' };
    return { num: m[1], unit: m[2] || '' };
  }

  function buildPageCSSFromStorage(storage) {
    const domain = normalizeDomain(location.hostname);
    const site = storage[`site:${domain}`] || {};

    const parts = [];
    const globalDraft = storage['draft:global'];
    if (globalDraft && globalDraft.trim()) parts.push(globalDraft);

    const gset = Array.isArray(storage['global:activePresets']) ? storage['global:activePresets'] : [];
    for (const id of gset) {
      const preset = storage[`preset:${id}`];
      if (preset && preset.css && condMatches(preset, location.href)) parts.push(preset.css);
    }

    if (site.enabled) {
      for (const id of (site.activePresets || [])) {
        const preset = storage[`preset:${id}`];
        if (preset && preset.css && condMatches(preset, location.href)) parts.push(preset.css);
      }
    }

    const draft = storage[`draft:${domain}`];
    if (draft && draft.trim()) parts.push(draft);

    const visualCss = storage['visual:lastCss'];
    if (visualCss && visualCss.trim()) parts.push(visualCss);
    return parts.join('\n');
  }

  async function applySavedPageCSS() {
    const storage = await browser.storage.local.get(null);
    if (storage['global:disabled']) {
      applyCSS('');
      return;
    }
    const css = buildPageCSSFromStorage(storage);
    applyCSS(css);
    // Keep page styles intact; tailwind runtime is disabled by default.
    applyTailwind(false);
  }

  function startVisualMode() {
    let overlay = document.getElementById('css-editor-visual-hover');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'css-editor-visual-hover';
      overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #6a5cff;background:rgba(106,92,255,.14);z-index:2147483647;border-radius:4px;';
      document.documentElement.appendChild(overlay);
    }
    const onMove = (e) => {
      const target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      if (!target || typeof target.getBoundingClientRect !== 'function') return;
      const r = target.getBoundingClientRect();
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
    };
    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      overlay.remove();

      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      const sel = uniqueSelector(el);
      if (!sel) return;

      let panel = document.getElementById('css-editor-visual-panel');
      if (panel) panel.remove();
      panel = document.createElement('div');
      panel.id = 'css-editor-visual-panel';
      panel.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'width: 220px',
        'padding:10px',
        'border-radius:12px',
        'background: rgba(15,15,20,.92)',
        'border: 1px solid rgba(106,92,255,.45)',
        'box-shadow: 0 16px 40px rgba(0,0,0,.35)',
        'color: #eee',
        'font-family: "Fira Code", monospace',
        'pointer-events:auto',
        'backdrop-filter: blur(10px)'
      ].join(';');

      const rect = el.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 228));
      const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 340));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;

      const computed = getComputedStyle(el);
      const fontFamily = computed.fontFamily || '';
      const fontSizeParsed = parsePxValue(computed.fontSize);
      const fontSizeNum = fontSizeParsed.num !== '' ? String(fontSizeParsed.num) : '';
      const fontSizeUnit = fontSizeParsed.unit || 'px';
      const colorHex = cssColorToHex(computed.color);
      const bgHex = cssColorToHex(computed.backgroundColor);
      const fontWeight = computed.fontWeight || '';
      const lineHeightParsed = parsePxValue(computed.lineHeight);
      const lineHeightNum = lineHeightParsed.num !== '' ? String(lineHeightParsed.num) : '';
      const italic = computed.fontStyle === 'italic';

      panel.innerHTML = `
        <div id="css-editor-visual-drag" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;cursor:move;user-select:none;">
          <div style="font-size:11px;color:rgba(162,157,227,.95);font-weight:700;letter-spacing:.2px;">visual</div>
          <button id="css-editor-visual-close" style="width:26px;height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#eee;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;flex-direction:column;gap:3px;">
            <div style="font-size:9px;color:rgba(231,231,238,.55);">font</div>
            <input id="css-editor-visual-font-family" type="text" value="${(fontFamily || '').replace(/"/g, '&quot;')}" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);color:#eee;padding:0 8px;font-size:10px;outline:none;" />
          </label>

          <div style="display:flex;gap:8px;">
            <label style="flex:1;display:flex;flex-direction:column;gap:3px;">
              <div style="font-size:9px;color:rgba(231,231,238,.55);">size</div>
              <input id="css-editor-visual-font-size" inputmode="decimal" type="number" value="${fontSizeNum}" step="0.5" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);color:#eee;padding:0 8px;font-size:10px;outline:none;" />
            </label>
            <div style="align-self:flex-end;padding:0 2px 6px;font-size:9px;color:rgba(231,231,238,.55);">${fontSizeUnit || 'px'}</div>
          </div>

          <div style="display:flex;gap:8px;">
            <label style="flex:1;display:flex;flex-direction:column;gap:3px;">
              <div style="font-size:9px;color:rgba(231,231,238,.55);">color</div>
              <input id="css-editor-visual-color" type="color" value="${colorHex}" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);padding:0;outline:none;cursor:pointer;" />
            </label>
            <label style="flex:1;display:flex;flex-direction:column;gap:3px;">
              <div style="font-size:9px;color:rgba(231,231,238,.55);">bg</div>
              <input id="css-editor-visual-bg" type="color" value="${bgHex}" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);padding:0;outline:none;cursor:pointer;" />
            </label>
          </div>

          <label style="display:flex;flex-direction:column;gap:3px;">
            <div style="font-size:9px;color:rgba(231,231,238,.55);">weight</div>
            <select id="css-editor-visual-font-weight" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);color:#eee;padding:0 8px;font-size:10px;outline:none;">
              <option value="100">100</option>
              <option value="300">300</option>
              <option value="400" selected>400</option>
              <option value="500">500</option>
              <option value="600">600</option>
              <option value="700">700</option>
              <option value="800">800</option>
              <option value="900">900</option>
            </select>
          </label>

          <label style="display:flex;flex-direction:column;gap:3px;">
            <div style="font-size:9px;color:rgba(231,231,238,.55);">line-height</div>
            <input id="css-editor-visual-line-height" inputmode="decimal" type="number" value="${lineHeightNum}" step="0.1" style="height:26px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18);color:#eee;padding:0 8px;font-size:10px;outline:none;" />
          </label>

          <label style="display:flex;align-items:center;gap:8px;font-size:10px;color:#ddd;">
            <input id="css-editor-visual-italic" type="checkbox" ${italic ? 'checked' : ''} />
            italic
          </label>

          <div style="display:flex;gap:8px;margin-top:2px;">
            <button id="css-editor-visual-reset" style="flex:1;height:30px;border-radius:10px;border:1px solid rgba(255,92,122,.35);background:rgba(255,92,122,.08);color:#ff9db5;cursor:pointer;font-size:10px;font-family:inherit;">reset</button>
            <button id="css-editor-visual-close-2" style="flex:1;height:30px;border-radius:10px;border:1px solid rgba(106,92,255,.35);background:rgba(106,92,255,.12);color:#a29de3;cursor:pointer;font-size:10px;font-family:inherit;">close</button>
          </div>
        </div>
      `;

      document.documentElement.appendChild(panel);
      const dragHandle = panel.querySelector('#css-editor-visual-drag');

      const fontFamilyInput = panel.querySelector('#css-editor-visual-font-family');
      const fontSizeInput = panel.querySelector('#css-editor-visual-font-size');
      const colorInput = panel.querySelector('#css-editor-visual-color');
      const bgInput = panel.querySelector('#css-editor-visual-bg');
      const weightSelect = panel.querySelector('#css-editor-visual-font-weight');
      const lineHeightInput = panel.querySelector('#css-editor-visual-line-height');
      const italicInput = panel.querySelector('#css-editor-visual-italic');

      if (fontWeight) {
        // Normalize computed fontWeight like "bold" or "700"
        const w = String(fontWeight).toLowerCase();
        const mapped = w === 'bold' ? '700' : w === 'normal' ? '400' : (parseInt(fontWeight, 10) ? String(parseInt(fontWeight, 10)) : '');
        if (mapped && Array.from(weightSelect.options).some(o => o.value === mapped)) weightSelect.value = mapped;
      }

      let updateTimer = null;
      const scheduleUpdate = () => {
        clearTimeout(updateTimer);
        updateTimer = setTimeout(async () => {
          const nextFont = fontFamilyInput.value.trim();
          const nextSizeNum = fontSizeInput.value;
          const nextColor = colorInput.value;
          const nextBg = bgInput.value;
          const nextWeight = weightSelect.value;
          const nextLineHeight = lineHeightInput.value;
          const nextItalic = italicInput.checked;

          // Apply inline for instant feedback.
          if (nextFont) el.style.fontFamily = nextFont;
          if (nextSizeNum !== '') el.style.fontSize = `${nextSizeNum}${fontSizeUnit}`;
          if (nextColor) el.style.color = nextColor;
          if (nextBg) el.style.backgroundColor = nextBg;
          if (nextWeight) el.style.fontWeight = nextWeight;
          if (nextLineHeight !== '') el.style.lineHeight = String(nextLineHeight);
          el.style.fontStyle = nextItalic ? 'italic' : '';

          const decls = [];
          if (nextFont) decls.push(`font-family: ${nextFont}`);
          if (nextSizeNum !== '') decls.push(`font-size: ${nextSizeNum}${fontSizeUnit}`);
          if (nextColor) decls.push(`color: ${nextColor}`);
          if (nextBg) decls.push(`background-color: ${nextBg}`);
          if (nextWeight) decls.push(`font-weight: ${nextWeight}`);
          if (nextLineHeight !== '') decls.push(`line-height: ${nextLineHeight}`);
          if (nextItalic) decls.push(`font-style: italic`);

          const cssBlock = `${sel} {\n${decls.map(d => `  ${d};`).join('\n')}\n}`;

          try {
            await browser.storage.local.set({ 'visual:lastSelector': sel, 'visual:lastCss': cssBlock });
          } catch {}

          // Update injected CSS immediately, even if popup is closed.
          try { await applySavedPageCSS(); } catch {}

          // Also try syncing to popup editor.
          try { browser.runtime.sendMessage({ type: 'VISUAL_SELECTOR_CSS', selector: sel, css: cssBlock }); } catch {}
        }, 220);
      };

      const onAnyInput = () => scheduleUpdate();
      [fontFamilyInput, fontSizeInput, colorInput, bgInput, weightSelect, lineHeightInput, italicInput].forEach(inp => {
        if (!inp) return;
        inp.addEventListener('input', onAnyInput);
        inp.addEventListener('change', onAnyInput);
      });

      const cleanup = () => {
        if (panel && panel.parentElement) panel.parentElement.removeChild(panel);
        panel = null;
      };

      // Dragging the mini panel across the viewport
      let dragState = null;
      let dragMoved = false;
      const onDragMove = (ev) => {
        if (!panel || !dragState) return;
        dragMoved = true;
        const nextLeft = ev.clientX - dragState.offsetX;
        const nextTop = ev.clientY - dragState.offsetY;
        const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
        panel.style.left = `${Math.max(8, Math.min(nextLeft, maxLeft))}px`;
        panel.style.top = `${Math.max(8, Math.min(nextTop, maxTop))}px`;
      };
      const onDragEnd = () => {
        dragState = null;
        setTimeout(() => { dragMoved = false; }, 0);
        document.removeEventListener('mousemove', onDragMove, true);
        document.removeEventListener('mouseup', onDragEnd, true);
      };
      if (dragHandle) {
        dragHandle.addEventListener('mousedown', (ev) => {
          if (ev.target && ev.target.closest('button')) return;
          const leftNow = parseFloat(panel.style.left || '0');
          const topNow = parseFloat(panel.style.top || '0');
          dragState = { offsetX: ev.clientX - leftNow, offsetY: ev.clientY - topNow };
          document.addEventListener('mousemove', onDragMove, true);
          document.addEventListener('mouseup', onDragEnd, true);
        });
      }

      const closeBtn = panel.querySelector('#css-editor-visual-close');
      const closeBtn2 = panel.querySelector('#css-editor-visual-close-2');
      if (closeBtn) closeBtn.addEventListener('click', cleanup);
      if (closeBtn2) closeBtn2.addEventListener('click', cleanup);

      const resetBtn = panel.querySelector('#css-editor-visual-reset');
      if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
          try {
            await browser.storage.local.set({ 'visual:lastSelector': '', 'visual:lastCss': '' });
            await applySavedPageCSS();
          } catch {}
          cleanup();
        });
      }

      const outsideClick = (ev) => {
        if (!panel) return;
        if (dragMoved) return;
        if (panel.contains(ev.target)) return;
        // Close when user clicks elsewhere.
        document.removeEventListener('click', outsideClick, true);
        cleanup();
      };
      document.addEventListener('click', outsideClick, true);

      // Apply initial schedule once so the panel reflects current styles.
      scheduleUpdate();
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  }

  // Listen for messages from popup / background
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'APPLY_CSS') applyCSS(msg.css);
    if (msg.type === 'APPLY_TAILWIND') applyTailwind(!!msg.enabled);
    if (msg.type === 'START_VISUAL_MODE') startVisualMode();
    if (msg.type === 'REMOVE_CSS') {
      const el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    }
  });

  // Apply saved CSS on page load
  (async () => {
    try { await applySavedPageCSS(); } catch {}
  })();
}
