let currentDomain = '';
let db = {};
let settings = { formatOnPaste: true, formatOnBlur: true, syntaxHL: true };

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try { currentDomain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  db = await browser.storage.local.get(null);
  const s = db['settings'];
  if (s) Object.assign(settings, s);
  setupTabs();
  setupEditor();
  setupSettings();
  renderPresets();
  renderSites();
})();

function save(updates) {
  Object.assign(db, updates);
  return browser.storage.local.set(updates);
}
function allPresets() {
  return Object.entries(db).filter(([k]) => k.startsWith('preset:')).map(([, v]) => v);
}
function siteData(domain) {
  return db[`site:${domain}`] || { enabled: false, activePresets: [] };
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function normDom(d) { return (d || '').replace(/^www\./, ''); }

function buildDomainCSS(domain) {
  const site = siteData(domain);
  const parts = [];
  if (site.enabled) {
    (site.activePresets || []).forEach(id => {
      const css = (db[`preset:${id}`] || {}).css;
      if (css) parts.push(css);
    });
  }
  const draft = db[`draft:${domain}`];
  if (draft && draft.trim()) parts.push(draft);
  return parts.join('\n');
}

async function injectToTab(css) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css });
  } catch {
    await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css }).catch(() => {});
  }
}

// ── Tabs ─────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-pane`).classList.add('active');
    });
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="settings"]').classList.add('active');
    document.getElementById('settings-pane').classList.add('active');
  });
}

// ── CSS Syntax Highlighter ────────────────────────────────
function highlightCSS(code) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Tokenize properly handling strings, comments, parens
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    // Comment
    if (code[i] === '/' && code[i+1] === '*') {
      const end = code.indexOf('*/', i+2);
      const s = end < 0 ? code.slice(i) : code.slice(i, end+2);
      tokens.push({ type: 'comment', val: s });
      i += s.length; continue;
    }
    // String
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      let j = i+1;
      while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
      tokens.push({ type: 'string', val: code.slice(i, j+1) });
      i = j+1; continue;
    }
    // Single chars
    if ('{}:;'.includes(code[i])) { tokens.push({ type: code[i], val: code[i] }); i++; continue; }
    // Collect until special
    let j = i;
    while (j < code.length && !'{};:/"\''.includes(code[j])) {
      if (code[j] === '/' && code[j+1] === '*') break;
      j++;
    }
    if (j > i) { tokens.push({ type: 'text', val: code.slice(i, j) }); i = j; continue; }
    tokens.push({ type: 'text', val: code[i] }); i++;
  }

  let out = '';
  let depth = 0;
  let inVal = false;

  function hlText(t) {
    if (!t) return '';
    // @rule
    if (t.match(/^\s*@[\w-]+/)) return t.replace(/(@[\w-]+)/, `<span class="hl-at">$1</span>`);
    if (depth === 0) return `<span class="hl-sel">${esc(t)}</span>`;
    // inside block
    const propMatch = t.match(/^(\s*)([\w-]+)(\s*)$/);
    if (propMatch && !inVal) return `${esc(propMatch[1])}<span class="hl-prop">${esc(propMatch[2])}</span>${esc(propMatch[3])}`;
    // value — colorize numbers and !important
    return esc(t)
      .replace(/\b(\d*\.?\d+)(px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in)?\b/g,
        (m, n, u) => n ? `<span class="hl-num">${n}</span>${u ? `<span class="hl-punc">${u}</span>` : ''}` : m)
      .replace(/!important/g, `<span class="hl-imp">!important</span>`);
  }

  for (const tok of tokens) {
    if (tok.type === 'comment') { out += `<span class="hl-com">${esc(tok.val)}</span>`; continue; }
    if (tok.type === 'string') { out += `<span class="hl-str">${esc(tok.val)}</span>`; continue; }
    if (tok.type === '{') { out += `<span class="hl-punc">${esc(tok.val)}</span>`; depth++; inVal = false; continue; }
    if (tok.type === '}') { depth = Math.max(0, depth-1); out += `<span class="hl-punc">${esc(tok.val)}</span>`; inVal = false; continue; }
    if (tok.type === ':') { out += `<span class="hl-punc">:</span>`; inVal = true; continue; }
    if (tok.type === ';') { out += `<span class="hl-punc">;</span>`; inVal = false; continue; }
    out += hlText(tok.val);
  }
  return out;
}

// ── Formatter (fixed — handles : inside parens/strings) ──
function formatCSS(css) {
  let out = '', indent = 0;
  const IND = '  ';
  // Tokenize like above but for formatting
  let i = 0, depth2 = 0, parenD = 0;
  const push = s => { out += s; };

  while (i < css.length) {
    // comment
    if (css[i] === '/' && css[i+1] === '*') {
      const end = css.indexOf('*/', i+2);
      const s = end < 0 ? css.slice(i) : css.slice(i, end+2);
      push(IND.repeat(indent) + s.trim() + '\n');
      i += s.length; continue;
    }
    // string
    if (css[i] === '"' || css[i] === "'") {
      const q = css[i]; let j = i+1;
      while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; }
      push(css.slice(i, j+1)); i = j+1; continue;
    }
    // paren tracking (don't split on : or ; inside parens)
    if (css[i] === '(') { parenD++; push('('); i++; continue; }
    if (css[i] === ')') { parenD = Math.max(0, parenD-1); push(')'); i++; continue; }

    if (parenD > 0) { push(css[i]); i++; continue; }

    if (css[i] === '{') {
      const trimmed = out.trimEnd();
      out = trimmed + ' {\n'; indent++; i++; continue;
    }
    if (css[i] === '}') {
      indent = Math.max(0, indent-1);
      out = out.trimEnd() + '\n' + IND.repeat(indent) + '}\n\n'; i++; continue;
    }
    if (css[i] === ';') {
      out = out.trimEnd() + ';\n'; i++; continue;
    }
    if (css[i] === ':' && depth2 === 0 && indent > 0) {
      // property colon — check it's actually a prop:val separator
      const before = out.trimEnd();
      const lastNL = before.lastIndexOf('\n');
      const lastLine = before.slice(lastNL+1);
      if (lastLine.trim() && !lastLine.includes(':')) {
        out = before + ': '; i++; continue;
      }
    }
    if (css[i] === '\n' || css[i] === '\r') { i++; continue; }
    if (css[i] === ' ' || css[i] === '\t') {
      // collapse whitespace
      if (out.length && !out.endsWith(' ') && !out.endsWith('\n')) push(' ');
      i++; continue;
    }
    // normal char — add indent if at start of line
    if (out.endsWith('\n') || out === '') {
      push(IND.repeat(indent));
    }
    push(css[i]); i++;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ── History ───────────────────────────────────────────────
function getHistory() { return db[`history:${currentDomain}`] || { stack: [], pos: -1 }; }
function pushHistory(css) {
  const h = getHistory();
  h.stack = h.stack.slice(0, h.pos+1);
  h.stack.push(css);
  if (h.stack.length > 80) h.stack.shift();
  h.pos = h.stack.length-1;
  save({ [`history:${currentDomain}`]: h });
}
function undo() { const h = getHistory(); if (h.pos <= 0) return null; h.pos--; save({[`history:${currentDomain}`]: h}); return h.stack[h.pos]; }
function redo() { const h = getHistory(); if (h.pos >= h.stack.length-1) return null; h.pos++; save({[`history:${currentDomain}`]: h}); return h.stack[h.pos]; }

// ── Line numbers ──────────────────────────────────────────
function updateLines(ta) {
  const n = (ta.value.match(/\n/g) || []).length + 1;
  const gutter = document.getElementById('line-numbers');
  if (!gutter) return;
  while (gutter.children.length < n) {
    const d = document.createElement('div');
    d.textContent = gutter.children.length + 1;
    gutter.appendChild(d);
  }
  while (gutter.children.length > n) gutter.lastChild.remove();
  gutter.scrollTop = ta.scrollTop;
}

// ── Syntax highlight sync ─────────────────────────────────
function syncHL(ta) {
  const hl = document.getElementById('css-highlight');
  if (!hl) return;
  if (!settings.syntaxHL) { hl.innerHTML = ''; return; }
  hl.innerHTML = highlightCSS(ta.value + '\n');
  hl.scrollTop  = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

// ── Share (encode CSS in URL) ─────────────────────────────
function makeShareURL(css, domain) {
  const data = JSON.stringify({ css, domain, v: 1 });
  const b64 = btoa(unescape(encodeURIComponent(data)));
  // In a real extension this would be a real URL
  return `https://css.workshop/p/share#${b64}`;
}

// ── Editor ───────────────────────────────────────────────
function setupEditor() {
  const ta = document.getElementById('css-input');
  const shareResult = document.getElementById('share-result');

  ta.value = db[`draft:${currentDomain}`] || '';
  ta.scrollTop = db[`scroll:${currentDomain}`] || 0;
  updateLines(ta);
  syncHL(ta);
  if (!getHistory().stack.length && ta.value) pushHistory(ta.value);

  let scrollD;
  ta.addEventListener('scroll', () => {
    clearTimeout(scrollD);
    scrollD = setTimeout(() => save({ [`scroll:${currentDomain}`]: ta.scrollTop }), 300);
    const hl = document.getElementById('css-highlight');
    if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
    updateLines(ta);
  });

  let inpD, histD;
  ta.addEventListener('input', () => {
    updateLines(ta);
    syncHL(ta);
    clearTimeout(inpD);
    inpD = setTimeout(async () => {
      await save({ [`draft:${currentDomain}`]: ta.value });
      injectToTab(buildDomainCSS(currentDomain));
    }, 150);
    clearTimeout(histD);
    histD = setTimeout(() => pushHistory(ta.value), 800);
  });

  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      ta.value = v.slice(0,s) + '  ' + v.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s+2;
      updateLines(ta); syncHL(ta);
    }
    if ((e.ctrlKey||e.metaKey) && e.key==='z' && !e.shiftKey) {
      e.preventDefault();
      const v = undo();
      if (v !== null) { ta.value = v; updateLines(ta); syncHL(ta); injectToTab(buildDomainCSS(currentDomain)); save({[`draft:${currentDomain}`]: v}); }
    }
    if ((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.shiftKey&&e.key==='z'))) {
      e.preventDefault();
      const v = redo();
      if (v !== null) { ta.value = v; updateLines(ta); syncHL(ta); injectToTab(buildDomainCSS(currentDomain)); save({[`draft:${currentDomain}`]: v}); }
    }
  });

  ta.addEventListener('paste', () => setTimeout(() => {
    if (settings.formatOnPaste) ta.value = formatCSS(ta.value);
    updateLines(ta); syncHL(ta);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
    pushHistory(ta.value);
  }, 0));

  ta.addEventListener('blur', () => {
    if (settings.formatOnBlur && ta.value.trim()) {
      ta.value = formatCSS(ta.value);
      updateLines(ta); syncHL(ta);
      save({ [`draft:${currentDomain}`]: ta.value });
    }
  });

  document.getElementById('btn-format').addEventListener('click', () => {
    ta.value = formatCSS(ta.value);
    updateLines(ta); syncHL(ta);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
    pushHistory(ta.value);
  });

  // Import CSS file
  document.getElementById('btn-import-file').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    // Ask which domain to bind to
    const domain = prompt(`Bind "${file.name}" to site:`, currentDomain);
    if (domain === null) return;
    const norm = normDom(domain) || currentDomain;
    const id = genId();
    const name = file.name.replace('.css','');
    await save({ [`preset:${id}`]: { id, name, css: text, type: 'site', domain: norm } });
    const site = siteData(norm);
    site.activePresets = [...new Set([...(site.activePresets||[]), id])];
    site.enabled = true;
    await save({ [`site:${norm}`]: site });
    db = await browser.storage.local.get(null);
    renderPresets(); renderSites();
    e.target.value = '';
    notify(`"${name}" imported for ${norm}`);
  });

  // Share
  document.getElementById('btn-share').addEventListener('click', () => {
    const css = ta.value.trim();
    if (!css) return;
    const url = makeShareURL(css, currentDomain);
    navigator.clipboard.writeText(url).catch(() => {});
    shareResult.textContent = '✓ link copied: ' + url;
    shareResult.classList.add('show');
    setTimeout(() => shareResult.classList.remove('show'), 4000);
  });

  // Save preset
  const saveBtn = document.getElementById('btn-save-preset');
  saveBtn.addEventListener('click', async () => {
    const css = ta.value.trim();
    if (!css) return;
    const domain = normDom(currentDomain);

    if (saveBtn.dataset.mode === 'edit') {
      const id = ta.dataset.editingId;
      const preset = db[`preset:${id}`];
      if (!preset) return;
      await save({ [`preset:${id}`]: { ...preset, css } });
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(domain));
      saveBtn.textContent = 'save ↗';
      saveBtn.dataset.mode = '';
      ta.dataset.editingId = '';
    } else {
      const name = prompt('Preset name:');
      if (!name) return;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type: 'site', domain } });
      const site = siteData(domain);
      site.activePresets = [...new Set([...(site.activePresets||[]), id])];
      site.enabled = true;
      await save({ [`site:${domain}`]: site, [`draft:${domain}`]: '' });
      ta.value = '';
      updateLines(ta); syncHL(ta);
      db = await browser.storage.local.get(null);
    }

    renderPresets(); renderSites();
    const title = document.querySelector('.titlebar-title');
    title.classList.remove('title-saved'); void title.offsetWidth; title.classList.add('title-saved');
  });
}

// ── Settings ─────────────────────────────────────────────
function setupSettings() {
  // Init toggles
  document.querySelectorAll('[data-setting]').forEach(btn => {
    const key = btn.dataset.setting;
    btn.classList.toggle('on', !!settings[key]);
    btn.addEventListener('click', async () => {
      settings[key] = !settings[key];
      btn.classList.toggle('on', settings[key]);
      await save({ settings });
    });
  });

  // Export JSON
  document.getElementById('btn-export-json').addEventListener('click', () => {
    const presets = allPresets();
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'css-editor-presets.json'; a.click();
    URL.revokeObjectURL(url);
  });

  // Import JSON
  document.getElementById('btn-import-json').addEventListener('click', () => {
    document.getElementById('json-input').click();
  });
  document.getElementById('json-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const presets = JSON.parse(text);
      if (!Array.isArray(presets)) throw new Error('invalid');
      const updates = {};
      presets.forEach(p => { if (p.id && p.name && p.css) updates[`preset:${p.id}`] = p; });
      await save(updates);
      db = await browser.storage.local.get(null);
      renderPresets(); renderSites();
      notify(`Imported ${presets.length} presets`);
    } catch { notify('Import failed — invalid file'); }
    e.target.value = '';
  });

  // Clear all
  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Delete all presets, drafts and site data?')) return;
    const keys = Object.keys(db).filter(k =>
      k.startsWith('preset:') || k.startsWith('site:') ||
      k.startsWith('draft:') || k.startsWith('history:') || k.startsWith('scroll:'));
    await browser.storage.local.remove(keys);
    keys.forEach(k => delete db[k]);
    const ta = document.getElementById('css-input');
    ta.value = ''; updateLines(ta); syncHL(ta);
    injectToTab('');
    renderPresets(); renderSites();
    notify('All data cleared');
  });

  // Open workshop
  document.getElementById('btn-open-workshop').addEventListener('click', () => {
    browser.tabs.create({ url: 'https://css.workshop' });
  });
}

// ── Notification toast ────────────────────────────────────
let notifT;
function notify(msg) {
  let el = document.getElementById('notif-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notif-toast';
    el.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#0d0d0d;border:1px solid #1d9e75;border-radius:6px;padding:6px 10px;font-size:9px;color:#56bf86;z-index:999;transition:opacity .3s;';
    document.body.appendChild(el);
  }
  el.textContent = '✓ ' + msg;
  el.style.opacity = '1';
  clearTimeout(notifT);
  notifT = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ── Presets ───────────────────────────────────────────────
function renderPresets() {
  const container = document.getElementById('presets-content');
  const presets = allPresets();
  if (!presets.length) { container.innerHTML = '<div class="empty">no presets yet</div>'; return; }

  const globals = presets.filter(p => p.type === 'global');
  const byDomain = {};
  presets.filter(p => p.type === 'site').forEach(p => {
    const d = p.domain || 'other';
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(p);
  });

  const nd = normDom(currentDomain);
  const site = siteData(nd);
  const active = new Set(site.activePresets || []);

  const chip = (p, cls) =>
    `<div class="chip ${cls}" data-id="${p.id}">${p.name}<span class="chip-edit" data-edit="${p.id}">✎</span><span class="chip-x" data-del="${p.id}">×</span></div>`;

  let html = '';
  if (globals.length) {
    html += '<div class="group-label">global</div><div class="chips">';
    globals.forEach(p => { html += chip(p, active.has(p.id) ? 'on-global' : ''); });
    html += '<button class="chip-add" data-type-add="global">+</button></div>';
  } else {
    html += '<div class="group-label">global</div><div class="chips"><button class="chip-add" data-type-add="global">+</button></div>';
  }
  for (const [domain, dPs] of Object.entries(byDomain)) {
    html += `<div class="group-label">${domain}</div><div class="chips">`;
    dPs.forEach(p => { html += chip(p, active.has(p.id) ? 'on-site' : ''); });
    html += `<button class="chip-add" data-type-add="site" data-domain="${domain}">+</button></div>`;
  }
  if (!byDomain[nd]) {
    html += `<div class="group-label">${nd}</div><div class="chips"><button class="chip-add" data-type-add="site" data-domain="${nd}">+</button></div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.chip[data-id]').forEach(chip => {
    chip.addEventListener('click', async e => {
      if (e.target.classList.contains('chip-x') || e.target.classList.contains('chip-edit')) return;
      const id = chip.dataset.id;
      const site = siteData(nd);
      const set = new Set(site.activePresets || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      site.activePresets = [...set];
      if (!site.enabled && set.size > 0) site.enabled = true;
      await save({ [`site:${nd}`]: site });
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(nd));
      renderPresets(); renderSites();
    });
  });

  container.querySelectorAll('.chip-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.edit;
      const preset = db[`preset:${id}`];
      if (!preset) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="editor"]').classList.add('active');
      document.getElementById('editor-pane').classList.add('active');
      const ta = document.getElementById('css-input');
      ta.value = preset.css;
      ta.dataset.editingId = id;
      ta.focus();
      updateLines(ta); syncHL(ta);
      const sb = document.getElementById('btn-save-preset');
      sb.textContent = `update "${preset.name}" ↗`;
      sb.dataset.mode = 'edit';
    });
  });

  container.querySelectorAll('.chip-x').forEach(x => {
    x.addEventListener('click', async e => {
      e.stopPropagation();
      const id = x.dataset.del;
      if (!confirm('Delete preset?')) return;
      await browser.storage.local.remove(`preset:${id}`);
      delete db[`preset:${id}`];
      const updates = {};
      Object.keys(db).filter(k => k.startsWith('site:')).forEach(k => {
        const s = db[k];
        if (s.activePresets && s.activePresets.includes(id)) {
          s.activePresets = s.activePresets.filter(i => i !== id);
          updates[k] = s;
        }
      });
      if (Object.keys(updates).length) await save(updates);
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(nd));
      renderPresets(); renderSites();
    });
  });

  container.querySelectorAll('.chip-add').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = prompt('Preset name:');
      if (!name) return;
      const css = prompt('CSS:');
      if (!css) return;
      const type = btn.dataset.typeAdd;
      const domain = btn.dataset.domain || nd;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type, domain: type==='site' ? domain : undefined } });
      db = await browser.storage.local.get(null);
      renderPresets();
    });
  });
}

// ── Sites ─────────────────────────────────────────────────
function renderSites() {
  const container = document.getElementById('sites-content');
  const search = (document.getElementById('sites-search').value || '').toLowerCase();
  const domains = new Set();
  allPresets().filter(p => p.domain).forEach(p => domains.add(p.domain));
  Object.keys(db).filter(k => k.startsWith('site:')).forEach(k => domains.add(k.slice(5)));
  if (currentDomain) domains.add(currentDomain);
  const filtered = [...domains].filter(d => d.includes(search));

  if (!filtered.length) { container.innerHTML = '<div class="empty">no sites yet</div>'; return; }

  let html = '';
  filtered.forEach(domain => {
    const site = siteData(domain);
    const activeSet = new Set(site.activePresets || []);
    const domPs = allPresets().filter(p => p.domain === domain || p.type === 'global');
    const activePs = domPs.filter(p => activeSet.has(p.id));
    const rules = activePs.reduce((a, p) => a + (p.css||'').split('\n').filter(l => l.trim() && !l.trim().startsWith('/')).length, 0);
    const meta = `${activePs.length} preset${activePs.length!==1?'s':''} · ${rules} rules`;

    html += `<div class="site-card ${site.enabled?'on':''}" data-domain="${domain}">
      <div class="site-top">
        <div class="favicon"><img src="https://www.google.com/s2/favicons?domain=${domain}" onerror="this.style.display='none'"></div>
        <div class="site-info"><div class="site-domain">${domain}</div><div class="site-meta">${meta}</div></div>
        <button class="toggle ${site.enabled?'on':''}" data-domain="${domain}"></button>
        <button class="site-del" data-domain="${domain}">×</button>
      </div>`;
    if (domPs.length) {
      html += `<button class="expand-btn" data-domain="${domain}">${site._expanded?'▲ hide':'▼ presets'}</button>`;
      if (site._expanded) {
        html += '<div class="preset-rows">';
        domPs.forEach(p => {
          const on = activeSet.has(p.id);
          html += `<div class="preset-row">
            <div class="preset-dot ${on?'':'off'}"></div>
            <span class="preset-name">${p.name}</span>
            <span class="preset-rules">${(p.css||'').split('\n').filter(l=>l.trim()).length}r</span>
            <button class="preset-toggle-btn ${on?'on':''}" data-domain="${domain}" data-pid="${p.id}">${on?'on':'off'}</button>
          </div>`;
        });
        html += '</div>';
      }
    }
    html += '</div>';
  });

  container.innerHTML = html;

  container.querySelectorAll('.site-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const domain = btn.dataset.domain;
      if (!confirm(`Remove ${domain}?`)) return;
      await browser.storage.local.remove(`site:${domain}`);
      delete db[`site:${domain}`];
      if (domain === currentDomain) injectToTab('');
      renderSites();
    });
  });
  container.querySelectorAll('.toggle').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const domain = btn.dataset.domain;
      const site = siteData(domain);
      site.enabled = !site.enabled;
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      if (domain === currentDomain) injectToTab(buildDomainCSS(currentDomain));
      renderSites();
    });
  });
  container.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      const site = siteData(domain);
      site._expanded = !site._expanded;
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      renderSites();
    });
  });
  container.querySelectorAll('.preset-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain, pid = btn.dataset.pid;
      const site = siteData(domain);
      const set = new Set(site.activePresets || []);
      if (set.has(pid)) set.delete(pid); else set.add(pid);
      site.activePresets = [...set];
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      if (domain === currentDomain) injectToTab(buildDomainCSS(currentDomain));
      renderSites(); renderPresets();
    });
  });
  document.getElementById('sites-search').addEventListener('input', renderSites);
}
