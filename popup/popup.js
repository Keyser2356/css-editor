let currentDomain = '';
let db = {};

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try { currentDomain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  db = await browser.storage.local.get(null);
  setupTabs();
  setupEditor();
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
function buildDomainCSS(domain) {
  if (db['global:disabled']) return '';
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
}

// ── CSS Formatter ────────────────────────────────────────
function formatCSS(css) {
  let out = '', indent = 0;
  const IND = '  ';
  const tokens = css.match(/\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|[{}:;]|[^{}:;]+/g) || [];
  for (let tok of tokens) {
    tok = tok.trim();
    if (!tok) continue;
    if (tok === '{') { out = out.trimEnd() + ' {\n'; indent++; }
    else if (tok === '}') { indent = Math.max(0, indent - 1); out += IND.repeat(indent) + '}\n\n'; }
    else if (tok === ';') { out = out.trimEnd() + ';\n'; }
    else if (tok === ':') { out = out.trimEnd() + ': '; }
    else if (tok.startsWith('/*')) { out += IND.repeat(indent) + tok + '\n'; }
    else { const t = tok.replace(/\s+/g, ' ').trim(); if (t) out += IND.repeat(indent) + t; }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ── History (undo/redo) ──────────────────────────────────
const MAX_HISTORY = 100;

function getHistory() {
  return db[`history:${currentDomain}`] || { stack: [], pos: -1 };
}
function pushHistory(css) {
  const h = getHistory();
  // truncate redo branch
  h.stack = h.stack.slice(0, h.pos + 1);
  h.stack.push(css);
  if (h.stack.length > MAX_HISTORY) h.stack.shift();
  h.pos = h.stack.length - 1;
  save({ [`history:${currentDomain}`]: h });
}
function undoHistory() {
  const h = getHistory();
  if (h.pos <= 0) return null;
  h.pos--;
  save({ [`history:${currentDomain}`]: h });
  return h.stack[h.pos];
}
function redoHistory() {
  const h = getHistory();
  if (h.pos >= h.stack.length - 1) return null;
  h.pos++;
  save({ [`history:${currentDomain}`]: h });
  return h.stack[h.pos];
}

// ── Line numbers ─────────────────────────────────────────
function updateLineNumbers(ta) {
  const lines = ta.value.split('\n').length;
  const gutter = document.getElementById('line-numbers');
  if (!gutter) return;
  const current = gutter.children.length;
  if (current < lines) {
    for (let i = current + 1; i <= lines; i++) {
      const span = document.createElement('div');
      span.textContent = i;
      gutter.appendChild(span);
    }
  } else if (current > lines) {
    while (gutter.children.length > lines) gutter.lastChild.remove();
  }
  gutter.scrollTop = ta.scrollTop;
}

// ── Editor ───────────────────────────────────────────────
function setupEditor() {
  const ta = document.getElementById('css-input');

  ta.value = db[`draft:${currentDomain}`] || '';
  ta.scrollTop = db[`scroll:${currentDomain}`] || 0;
  updateLineNumbers(ta);

  // Push initial state to history if empty
  if (!getHistory().stack.length && ta.value) pushHistory(ta.value);

  let scrollDebounce;
  ta.addEventListener('scroll', () => {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      save({ [`scroll:${currentDomain}`]: ta.scrollTop });
    }, 300);
    updateLineNumbers(ta);
  });

  let debounce, histDebounce;
  ta.addEventListener('input', () => {
    updateLineNumbers(ta);
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const css = ta.value;
      await save({ [`draft:${currentDomain}`]: css });
      injectToTab(buildDomainCSS(currentDomain));
    }, 150);
    clearTimeout(histDebounce);
    histDebounce = setTimeout(() => pushHistory(ta.value), 800);
  });

  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      ta.value = v.slice(0, s) + '  ' + v.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
      updateLineNumbers(ta);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const val = undoHistory();
      if (val !== null) { ta.value = val; updateLineNumbers(ta); injectToTab(buildDomainCSS(currentDomain)); save({ [`draft:${currentDomain}`]: val }); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
      e.preventDefault();
      const val = redoHistory();
      if (val !== null) { ta.value = val; updateLineNumbers(ta); injectToTab(buildDomainCSS(currentDomain)); save({ [`draft:${currentDomain}`]: val }); }
    }
  });

  ta.addEventListener('paste', () => setTimeout(() => {
    ta.value = formatCSS(ta.value);
    updateLineNumbers(ta);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
    pushHistory(ta.value);
  }, 0));

  ta.addEventListener('blur', () => {
    if (!ta.value.trim()) return;
    ta.value = formatCSS(ta.value);
    updateLineNumbers(ta);
    save({ [`draft:${currentDomain}`]: ta.value });
  });

  document.getElementById('btn-format').addEventListener('click', () => {
    ta.value = formatCSS(ta.value);
    updateLineNumbers(ta);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
    pushHistory(ta.value);
  });

  const saveBtn = document.getElementById('btn-save-preset');
  saveBtn.addEventListener('click', async () => {
    const css = ta.value.trim();
    if (!css) return;
    const domain = currentDomain.replace(/^www\./, '');

    if (saveBtn.dataset.mode === 'edit') {
      const id = ta.dataset.editingPresetId;
      const preset = db[`preset:${id}`];
      if (!preset) return;
      await save({ [`preset:${id}`]: { ...preset, css } });
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(domain));
      saveBtn.textContent = 'save as preset ↗';
      saveBtn.dataset.mode = '';
      ta.dataset.editingPresetId = '';
    } else {
      const name = prompt('Preset name:');
      if (!name) return;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type: 'site', domain } });
      const site = siteData(domain);
      site.activePresets = [...new Set([...(site.activePresets || []), id])];
      site.enabled = true;
      // Clear draft — CSS is now in a preset, draft should be empty
      await save({ [`site:${domain}`]: site, [`draft:${domain}`]: '' });
      ta.value = '';
      updateLineNumbers(ta);
      db = await browser.storage.local.get(null);
    }

    renderPresets();
    renderSites();
    const title = document.querySelector('.titlebar-title');
    title.classList.remove('title-saved');
    void title.offsetWidth;
    title.classList.add('title-saved');
  });
}

// ── Presets ──────────────────────────────────────────────
function renderPresets() {
  const container = document.getElementById('presets-content');
  const presets = allPresets();

  if (!presets.length) {
    container.innerHTML = '<div class="empty">no presets yet</div>';
    return;
  }

  const globals = presets.filter(p => p.type === 'global');
  const byDomain = {};
  presets.filter(p => p.type === 'site').forEach(p => {
    const d = p.domain || 'other';
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(p);
  });

  const normDomain = currentDomain.replace(/^www\./, '');
  const site = siteData(normDomain);
  const active = new Set(site.activePresets || []);
  let html = '';

  const chipHtml = (p, cls) =>
    `<div class="chip ${cls}" data-id="${p.id}">${p.name}<span class="chip-edit" data-edit="${p.id}">✎</span><span class="chip-x" data-del="${p.id}">×</span></div>`;

  if (globals.length) {
    html += '<div class="group-label">global</div><div class="chips">';
    globals.forEach(p => { html += chipHtml(p, active.has(p.id) ? 'on-global' : ''); });
    html += '<button class="chip-add" data-type-add="global">+</button></div>';
  } else {
    html += '<div class="group-label">global</div><div class="chips"><button class="chip-add" data-type-add="global">+</button></div>';
  }

  for (const [domain, dPresets] of Object.entries(byDomain)) {
    html += `<div class="group-label">${domain}</div><div class="chips">`;
    dPresets.forEach(p => { html += chipHtml(p, active.has(p.id) ? 'on-site' : ''); });
    html += `<button class="chip-add" data-type-add="site" data-domain="${domain}">+</button></div>`;
  }

  if (!byDomain[normDomain]) {
    html += `<div class="group-label">${normDomain}</div><div class="chips"><button class="chip-add" data-type-add="site" data-domain="${normDomain}">+</button></div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.chip[data-id]').forEach(chip => {
    chip.addEventListener('click', async e => {
      if (e.target.classList.contains('chip-x') || e.target.classList.contains('chip-edit')) return;
      const id = chip.dataset.id;
      const site = siteData(normDomain);
      const set = new Set(site.activePresets || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      site.activePresets = [...set];
      if (!site.enabled && set.size > 0) site.enabled = true;
      await save({ [`site:${normDomain}`]: site });
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(normDomain));
      renderPresets();
      renderSites();
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
      ta.dataset.editingPresetId = id;
      ta.focus();
      updateLineNumbers(ta);
      const saveBtn = document.getElementById('btn-save-preset');
      saveBtn.textContent = `update "${preset.name}" ↗`;
      saveBtn.dataset.mode = 'edit';
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
      injectToTab(buildDomainCSS(normDomain));
      renderPresets();
      renderSites();
    });
  });

  container.querySelectorAll('.chip-add').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = prompt('Preset name:');
      if (!name) return;
      const css = prompt('CSS:');
      if (!css) return;
      const type = btn.dataset.typeAdd;
      const domain = btn.dataset.domain || normDomain;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type, domain: type === 'site' ? domain : undefined } });
      db = await browser.storage.local.get(null);
      renderPresets();
    });
  });
}

// ── Sites ────────────────────────────────────────────────
function renderSites() {
  const container = document.getElementById('sites-content');
  const search = (document.getElementById('sites-search').value || '').toLowerCase();

  const domains = new Set();
  allPresets().filter(p => p.domain).forEach(p => domains.add(p.domain));
  Object.keys(db).filter(k => k.startsWith('site:')).forEach(k => domains.add(k.slice(5)));
  if (currentDomain) domains.add(currentDomain);

  const filtered = [...domains].filter(d => d.includes(search));

  if (!filtered.length) {
    container.innerHTML = '<div class="empty">no sites yet</div>';
    return;
  }

  let html = '';
  filtered.forEach(domain => {
    const site = siteData(domain);
    const activeSet = new Set(site.activePresets || []);
    const domainPresets = allPresets().filter(p => p.domain === domain || p.type === 'global');
    const activePresets = domainPresets.filter(p => activeSet.has(p.id));
    const ruleCount = activePresets.reduce((a, p) =>
      a + (p.css || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('/')).length, 0);
    const meta = `${activePresets.length} preset${activePresets.length !== 1 ? 's' : ''} · ${ruleCount} rules`;

    html += `<div class="site-card ${site.enabled ? 'on' : ''}" data-domain="${domain}">
      <div class="site-top">
        <div class="favicon"><img src="https://www.google.com/s2/favicons?domain=${domain}" onerror="this.style.display='none'"></div>
        <div class="site-info">
          <div class="site-domain">${domain}</div>
          <div class="site-meta">${meta}</div>
        </div>
        <button class="toggle ${site.enabled ? 'on' : ''}" data-domain="${domain}"></button>
        <button class="site-del" data-domain="${domain}">×</button>
      </div>`;

    if (domainPresets.length) {
      html += `<button class="expand-btn" data-domain="${domain}">${site._expanded ? '▲ hide' : '▼ presets'}</button>`;
      if (site._expanded) {
        html += '<div class="preset-rows">';
        domainPresets.forEach(p => {
          const on = activeSet.has(p.id);
          html += `<div class="preset-row">
            <div class="preset-dot ${on ? '' : 'off'}"></div>
            <span class="preset-name">${p.name}</span>
            <span class="preset-rules">${(p.css||'').split('\n').filter(l=>l.trim()).length}r</span>
            <button class="preset-toggle-btn ${on ? 'on' : ''}" data-domain="${domain}" data-pid="${p.id}">${on ? 'on' : 'off'}</button>
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
      const domain = btn.dataset.domain;
      const pid = btn.dataset.pid;
      const site = siteData(domain);
      const set = new Set(site.activePresets || []);
      if (set.has(pid)) set.delete(pid); else set.add(pid);
      site.activePresets = [...set];
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      if (domain === currentDomain) injectToTab(buildDomainCSS(currentDomain));
      renderSites();
      renderPresets();
    });
  });

  document.getElementById('sites-search').addEventListener('input', renderSites);
}
