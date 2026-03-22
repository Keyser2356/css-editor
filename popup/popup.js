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
  return Object.entries(db)
    .filter(([k]) => k.startsWith('preset:'))
    .map(([, v]) => v);
}

function siteData(domain) {
  return db[`site:${domain}`] || { enabled: false, activePresets: [] };
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

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

function formatCSS(css) {
  let out = '', indent = 0;
  const IND = '  ';
  const tokens = css.match(/\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|[{}:;]|[^{}:;]+/g) || [];
  for (let tok of tokens) {
    tok = tok.trim();
    if (!tok) continue;
    if (tok === '{') {
      out = out.trimEnd() + ' {\n'; indent++;
    } else if (tok === '}') {
      indent = Math.max(0, indent - 1);
      out += IND.repeat(indent) + '}\n\n';
    } else if (tok === ';') {
      out = out.trimEnd() + ';\n';
    } else if (tok === ':') {
      out = out.trimEnd() + ': ';
    } else if (tok.startsWith('/*')) {
      out += IND.repeat(indent) + tok + '\n';
    } else {
      const t = tok.replace(/\s+/g, ' ').trim();
      if (t) out += IND.repeat(indent) + t;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function setupEditor() {
  const ta = document.getElementById('css-input');

  ta.value = db[`draft:${currentDomain}`] || '';
  ta.scrollTop = db[`scroll:${currentDomain}`] || 0;

  let scrollDebounce;
  ta.addEventListener('scroll', () => {
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      save({ [`scroll:${currentDomain}`]: ta.scrollTop });
    }, 300);
  });

  let debounce;
  ta.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const css = ta.value;
      await save({ [`draft:${currentDomain}`]: css });
      injectToTab(buildDomainCSS(currentDomain));
    }, 150);
  });

  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      ta.value = v.slice(0, s) + '  ' + v.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });

  ta.addEventListener('paste', () => setTimeout(() => {
    ta.value = formatCSS(ta.value);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
  }, 0));

  ta.addEventListener('blur', () => {
    if (!ta.value.trim()) return;
    ta.value = formatCSS(ta.value);
    save({ [`draft:${currentDomain}`]: ta.value });
  });

  document.getElementById('btn-format').addEventListener('click', () => {
    ta.value = formatCSS(ta.value);
    injectToTab(buildDomainCSS(currentDomain));
    save({ [`draft:${currentDomain}`]: ta.value });
  });

  document.getElementById('btn-save-preset').addEventListener('click', async () => {
    const css = ta.value.trim();
    if (!css) return;
    const name = prompt('Preset name:');
    if (!name) return;
    const id = genId();
    const domain = currentDomain.replace(/^www\./, '');
    await save({ [`preset:${id}`]: { id, name, css, type: 'site', domain } });
    const site = siteData(domain);
    site.activePresets = [...new Set([...(site.activePresets || []), id])];
    site.enabled = true;
    await save({ [`site:${domain}`]: site });
    db = await browser.storage.local.get(null);
    renderPresets();
    renderSites();
    const title = document.querySelector('.titlebar-title');
    title.classList.remove('title-saved');
    void title.offsetWidth;
    title.classList.add('title-saved');
  });
}

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

  const site = siteData(currentDomain);
  const active = new Set(site.activePresets || []);
  let html = '';

  if (globals.length) {
    html += '<div class="group-label">global</div><div class="chips">';
    globals.forEach(p => {
      html += `<div class="chip ${active.has(p.id) ? 'on-global' : ''}" data-id="${p.id}">${p.name}<span class="chip-x" data-del="${p.id}">×</span></div>`;
    });
    html += '<button class="chip-add" data-type-add="global">+</button></div>';
  } else {
    html += '<div class="group-label">global</div><div class="chips"><button class="chip-add" data-type-add="global">+</button></div>';
  }

  for (const [domain, dPresets] of Object.entries(byDomain)) {
    html += `<div class="group-label">${domain}</div><div class="chips">`;
    dPresets.forEach(p => {
      html += `<div class="chip ${active.has(p.id) ? 'on-site' : ''}" data-id="${p.id}">${p.name}<span class="chip-x" data-del="${p.id}">×</span></div>`;
    });
    html += `<button class="chip-add" data-type-add="site" data-domain="${domain}">+</button></div>`;
  }

  if (!byDomain[currentDomain]) {
    html += `<div class="group-label">${currentDomain}</div><div class="chips">`;
    html += `<button class="chip-add" data-type-add="site" data-domain="${currentDomain}">+</button></div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.chip[data-id]').forEach(chip => {
    chip.addEventListener('click', async e => {
      if (e.target.classList.contains('chip-x')) return;
      const id = chip.dataset.id;
      const site = siteData(currentDomain);
      const set = new Set(site.activePresets || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      site.activePresets = [...set];
      if (!site.enabled && set.size > 0) site.enabled = true;
      await save({ [`site:${currentDomain}`]: site });
      db = await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(currentDomain));
      renderPresets();
      renderSites();
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
      injectToTab(buildDomainCSS(currentDomain));
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
      const domain = btn.dataset.domain || currentDomain;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type, domain: type === 'site' ? domain : undefined } });
      db = await browser.storage.local.get(null);
      renderPresets();
    });
  });
}

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
    // presets available for this domain (domain-specific + global)
    const domainPresets = allPresets().filter(p => p.domain === domain || p.type === 'global');
    // only count active ones for the meta line
    const activePresets = domainPresets.filter(p => activeSet.has(p.id));
    const ruleCount = activePresets.reduce((a, p) =>
      a + (p.css || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('/')).length, 0);
    const meta = `${activePresets.length} preset${activePresets.length !== 1 ? 's' : ''} · ${ruleCount} rules`;

    html += `<div class="site-card ${site.enabled ? 'on' : ''}" data-domain="${domain}">
      <div class="site-top">
        <div class="favicon">
          <img src="https://www.google.com/s2/favicons?domain=${domain}" onerror="this.style.display='none'">
        </div>
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
