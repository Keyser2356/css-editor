let currentDomain = '';
let db = {};
let settings = {
  formatOnPaste: true,
  formatOnBlur: true,
  syntaxHL: true,
  analyticsEnabled: true,
  openInWindow: false,
  telemetryUrl: 'http://localhost:8787/ping',
  telemetrySecret: ''
};
let theme = 'system'; // system | dark | light
let editorMode = 'site'; // site | global
let presetsSearchTerm = '';
let analyticsPollT = null;
let telemetryPingT = null;

// Coalesce frequent re-renders to avoid visible "blinking" on fast storage updates.
const __render = {
  presets: { t: null, inFlight: false, dirty: false },
  sites: { t: null, inFlight: false, dirty: false }
};

function isPaneActive(tabName) {
  const pane = window.$pane ? window.$pane(tabName) : document.getElementById(`${tabName}-pane`);
  return !!(pane && pane.classList && pane.classList.contains('active'));
}

function getListContainer(kind) {
  if (kind === 'presets') return window.$id ? window.$id('presets-content', 'presets-list') : document.getElementById('presets-content');
  if (kind === 'sites') return window.$id ? window.$id('sites-content', 'sites-list') : document.getElementById('sites-content');
  return null;
}

function isListEmpty(kind) {
  const el = getListContainer(kind);
  if (!el) return true;
  // if render hasn't happened yet, container is empty
  return !el.firstElementChild && !(el.textContent || '').trim();
}

function scheduleRender(kind, opts = {}) {
  const st = __render[kind];
  if (!st) return;
  if (st.t) clearTimeout(st.t);
  const immediate = !!opts.immediate;
  st.t = setTimeout(async () => {
    st.t = null;
    if (st.inFlight) { st.dirty = true; return; }
    // Only paint when the pane is visible; otherwise defer.
    if (!isPaneActive(kind)) { st.dirty = true; return; }
    st.inFlight = true;
    try {
      if (kind === 'presets') await renderPresets();
      if (kind === 'sites') await renderSites();
    } finally {
      st.inFlight = false;
      if (st.dirty) { st.dirty = false; scheduleRender(kind); }
    }
  }, immediate ? 0 : 60);
}

(function ensureCompatHelpers(){
  // Tiny DOM helpers to keep popup.js compatible with both:
  // - new UI (`index.html`) uses `*-pane` + `presets-content/sites-content`
  // - old UI (`popup.html`) uses `pane-*` + `presets-list/sites-list`
  if (!window.$id) {
    window.$id = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean) || null;
  }
  if (!window.$pane) {
    window.$pane = (tabName) => window.$id(`${tabName}-pane`, `pane-${tabName}`);
  }
})();

(async () => {
  try {
    applyWindowMode();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try { currentDomain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
    db = await browser.storage.local.get(null);
    const s = db['settings'];
    if (s) Object.assign(settings, s);
    if (!('analyticsEnabled' in settings)) settings.analyticsEnabled = true;
    if (!('openInWindow' in settings)) settings.openInWindow = false;
  if (!('telemetryUrl' in settings) || !settings.telemetryUrl) settings.telemetryUrl = 'http://localhost:8787/ping';
  if (!('telemetrySecret' in settings)) settings.telemetrySecret = '';
    maybeOpenDetachedWindow();
    theme = (settings && settings.theme) || 'system';
    applyTheme(theme);
    setupTabs();
    setupPresetSearch();
    setupContextBar();
    setupEditor();
    setupSettings();
    await maybeTrackUsage();
    await renderPresets();
    await renderSites();

    // If storage updates arrive right after open, coalesce them.
    scheduleRender('presets');
    scheduleRender('sites');
  } catch (e) {
    // Fail-safe: don't let a missing element break the whole popup.
    try { console.warn('css-editor init failed:', e); } catch {}
    try { await renderPresets(); } catch {}
    try { await renderSites(); } catch {}
  }
})();

function save(updates) {
  Object.assign(db, updates);
  return browser.storage.local.set(updates);
}
function allPresets() {
  return Object.entries(db)
    .filter(([k]) => k.startsWith('preset:'))
    .map(([k, v]) => {
      if (!v || typeof v !== 'object') return null;
      // Back-compat: some older data may miss `id` or store partial shapes.
      if (!v.id) return { ...v, id: k.slice('preset:'.length) };
      return v;
    })
    .filter(Boolean);
}
function siteData(domain) {
  return db[`site:${domain}`] || { enabled: false, activePresets: [], tailwind: true };
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function normDom(d) { return (d || '').replace(/^www\./, ''); }

function applyTheme(nextTheme) {
  const t = nextTheme || 'system';
  theme = t;
  if (!settings) settings = {};
  settings.theme = t;
  const body = document.body;
  if (!body) return;
  if (t === 'dark') body.setAttribute('data-theme', 'dark');
  else if (t === 'light') body.setAttribute('data-theme', 'light');
  else body.removeAttribute('data-theme');
}

function normalizeCond(preset) {
  const c = preset && preset.conditions ? preset.conditions : {};
  return { urlContains: (c.urlContains || '').trim() };
}

function presetMatchesUrl(preset, url) {
  const c = normalizeCond(preset);
  if (!c.urlContains) return true;
  return (url || '').includes(c.urlContains);
}

function globalActivePresets() {
  return Array.isArray(db['global:activePresets']) ? db['global:activePresets'] : [];
}

function buildDomainCSS(domain, url = '') {
  const site = siteData(domain);
  const parts = [];
  const globalDraft = db['draft:global'];
  if (globalDraft && globalDraft.trim()) parts.push(globalDraft);

  globalActivePresets().forEach(id => {
    const p = db[`preset:${id}`];
    if (p && p.css && presetMatchesUrl(p, url)) parts.push(p.css);
  });

  if (site.enabled) {
    (site.activePresets || []).forEach(id => {
      const p = db[`preset:${id}`] || {};
      if (p.css && presetMatchesUrl(p, url)) parts.push(p.css);
    });
  }
  const draft = db[`draft:${domain}`];
  if (draft && draft.trim()) parts.push(draft);
  return parts.join('\n');
}

async function injectToTab(css) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let resolved = css;
  let domain = currentDomain;
  try { domain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  if (typeof resolved !== 'string') resolved = buildDomainCSS(domain, tab.url || '');
  const s = siteData(domain);
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css: resolved });
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_TAILWIND', enabled: false });
  } catch {
    await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css: resolved }).catch(() => {});
    await browser.tabs.sendMessage(tab.id, { type: 'APPLY_TAILWIND', enabled: false }).catch(() => {});
  }
}

async function injectToDomain(domain) {
  const tabs       = await browser.tabs.query({});
  const normTarget = domain.replace(/^www\./, '');
  for (const tab of tabs) {
    try {
      const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
      if (tabDomain !== normTarget) continue;
      const css = buildDomainCSS(domain, tab.url || '');
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css });
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_TAILWIND', enabled: false });
      } catch {
        await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css }).catch(() => {});
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_TAILWIND', enabled: false }).catch(() => {});
      }
    } catch {}
  }
}

function maybeOpenDetachedWindow() {
  const params = new URLSearchParams(location.search);
  const inDetachedWindow = params.get('window') === '1';
  if (!settings.openInWindow || inDetachedWindow) return;
  const url = browser.runtime.getURL('popup/index.html?window=1');
  browser.windows.create({
    url,
    type: 'popup',
    width: 980,
    height: 760
  }).catch(() => {});
  window.close();
}

function applyWindowMode() {
  if (!document.body) return;
  const params = new URLSearchParams(location.search);
  const inDetachedWindow = params.get('window') === '1';
  document.body.setAttribute('data-window-mode', inDetachedWindow ? 'detached' : 'popup');
}

// ── Context bar (current domain + quick actions) ───────────
function setupContextBar() {
  const domEl = document.getElementById('current-domain');
  if (domEl) domEl.textContent = currentDomain || '—';

  const toggleBtn = document.getElementById('btn-site-toggle');
  const toggleLabel = document.getElementById('site-toggle-label');
  const clearDraftBtn = document.getElementById('btn-clear-draft');
  const scopeBtn = document.getElementById('btn-editor-scope');
  const scopeLabel = document.getElementById('editor-scope-label');
  const refreshEditorCaption = () => {
    if (domEl) domEl.textContent = editorMode === 'global' ? 'global css (all sites)' : (currentDomain || '—');
    if (scopeLabel) scopeLabel.textContent = editorMode;
  };
  refreshEditorCaption();

  const render = () => {
    const s = siteData(currentDomain);
    const on = !!s.enabled;
    if (toggleLabel) toggleLabel.textContent = on ? 'on' : 'off';
    if (toggleBtn) {
      toggleBtn.style.borderColor = on ? 'rgba(46,204,113,.35)' : '';
      toggleBtn.style.background = on ? 'rgba(46,204,113,.10)' : '';
      toggleBtn.style.color = on ? 'rgba(46,204,113,.95)' : '';
    }
  };

  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const s = siteData(currentDomain);
      s.enabled = !s.enabled;
      await save({ [`site:${currentDomain}`]: s });
      db = await browser.storage.local.get(null);
      await injectToDomain(currentDomain);
      renderPresets();
      renderSites();
      render();
    });
  }

  if (clearDraftBtn) {
    clearDraftBtn.addEventListener('click', async () => {
      if (!currentDomain) return;
      await save({ [`draft:${currentDomain}`]: '' });
      db = await browser.storage.local.get(null);
      const ta = document.getElementById('css-input');
      if (ta) {
        ta.value = '';
        updateLines(ta);
        syncHL(ta);
      }
      await injectToDomain(currentDomain);
      notify('Draft cleared');
    });
  }

  if (scopeBtn) {
    scopeBtn.addEventListener('click', async () => {
      editorMode = editorMode === 'site' ? 'global' : 'site';
      const ta = document.getElementById('css-input');
      if (ta) {
        const key = editorMode === 'global' ? 'draft:global' : `draft:${currentDomain}`;
        ta.value = db[key] || '';
        updateLines(ta);
        syncHL(ta);
      }
      refreshEditorCaption();
    });
  }

  render();
}

// ── Tabs ─────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = window.$pane ? window.$pane(tab.dataset.tab) : document.getElementById(`${tab.dataset.tab}-pane`);
      if (pane) pane.classList.add('active');
      // On tab switch, avoid "empty → filled" flicker: only re-render if needed and do it immediately.
      if (tab.dataset.tab === 'presets') {
        const st = __render.presets;
        if ((st && st.dirty) || isListEmpty('presets')) scheduleRender('presets', { immediate: true });
      }
      if (tab.dataset.tab === 'sites') {
        const st = __render.sites;
        if ((st && st.dirty) || isListEmpty('sites')) scheduleRender('sites', { immediate: true });
      }
    });
  });

  // Gear icon — toggles settings pane
  const gear = document.getElementById('btn-settings');
  if (gear) {
    gear.addEventListener('click', () => {
      const sp = window.$id ? window.$id('settings-pane') : document.getElementById('settings-pane');
      if (!sp) return;
      const isOpen = sp.classList.contains('active');
      // close all
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      if (!isOpen) {
        // open settings — no tab active
        sp.classList.add('active');
      } else {
        // was open, close — restore editor tab
        const editorTab = document.querySelector('[data-tab="editor"]');
        if (editorTab) editorTab.classList.add('active');
        const ep = window.$pane ? window.$pane('editor') : document.getElementById('editor-pane');
        if (ep) ep.classList.add('active');
      }
    });
  }
}

function setupPresetSearch() {
  const input = document.getElementById('presets-search');
  if (!input) return;
  if (input.dataset.bound === '1') return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => {
    presetsSearchTerm = (input.value || '').trim().toLowerCase();
    renderPresets();
  });
}

// ── Arborium-compatible CSS highlighter ──────────────────
// Uses same custom element tags as Arborium: <a-k> <a-pr> <a-s> <a-c> <a-n> <a-p> <a-at>
// Can be swapped for real Arborium bundle later with zero CSS changes.
function highlightCSS(raw) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const w = (tag, s) => `<${tag}>${esc(s)}</${tag}>`;

  let out = '';
  let i = 0, depth = 0, inVal = false;
  const src = raw;

  while (i < src.length) {
    // Comment
    if (src[i]==='/' && src[i+1]==='*') {
      const end = src.indexOf('*/', i+2);
      const s = end<0 ? src.slice(i) : src.slice(i, end+2);
      out += w('a-c', s); i += s.length; continue;
    }
    // String
    if (src[i]==='"' || src[i]==="'") {
      const q=src[i]; let j=i+1;
      while (j<src.length && src[j]!==q) { if(src[j]==='\\') j++; j++; }
      out += w('a-s', src.slice(i,j+1)); i=j+1; continue;
    }
    // @rule
    if (src[i]==='@') {
      let j=i+1; while(j<src.length && /[\w-]/.test(src[j])) j++;
      out += w('a-k', src.slice(i,j)); i=j; continue;
    }
    // {
    if (src[i]==='{') { depth++; inVal=false; out += w('a-p','{'); i++; continue; }
    // }
    if (src[i]==='}') { depth=Math.max(0,depth-1); inVal=false; out += w('a-p','}'); i++; continue; }
    // ;
    if (src[i]===';') { inVal=false; out += w('a-p',';'); i++; continue; }
    // :  — property separator only at depth>0 and not in parens
    if (src[i]===':' && depth>0 && !inVal) {
      inVal=true; out += w('a-p',':'); i++; continue;
    }
    // paren content — pass through with number highlight
    if (src[i]==='(' || src[i]===')') {
      out += w('a-p', src[i]); i++; continue;
    }
    // Collect token
    let j=i;
    while (j<src.length && !'{}:;"\'/@()'.includes(src[j]) && !(src[j]==='/'&&src[j+1]==='*')) j++;
    if (j===i) { out += esc(src[i]); i++; continue; }
    const tok = src.slice(i,j);
    i=j;

    if (depth===0) {
      // selector
      out += w('a-tg', tok);
    } else if (!inVal) {
      // property
      out += w('a-pr', tok);
    } else {
      // value — highlight numbers + !important
      const highlighted = tok
        .replace(/(&amp;|&lt;|&gt;|[^&<>])+/g, chunk => {
          return esc(chunk)
            .replace(/\b(\d*\.?\d+)(px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in)?\b/g,
              (_, n, u) => `<a-n>${n}</a-n>${u?`<a-p>${u}</a-p>`:''}`)
            .replace(/!important/g, `<a-k>!important</a-k>`);
        });
      out += highlighted;
    }
  }
  return out;
}

// ── Formatter ─────────────────────────────────────────────
function formatCSS(css) {
  let out='', indent=0, parenD=0;
  const IND='  ';
  let i=0;
  while (i<css.length) {
    // comment
    if (css[i]==='/'&&css[i+1]==='*') {
      const end=css.indexOf('*/',i+2);
      const s=end<0?css.slice(i):css.slice(i,end+2);
      out+=IND.repeat(indent)+s.trim()+'\n'; i+=s.length; continue;
    }
    // string
    if (css[i]==='"'||css[i]==="'") {
      const q=css[i]; let j=i+1;
      while(j<css.length&&css[j]!==q){if(css[j]==='\\')j++;j++;}
      out+=css.slice(i,j+1); i=j+1; continue;
    }
    if (css[i]==='(') { parenD++; out+='('; i++; continue; }
    if (css[i]===')') { parenD=Math.max(0,parenD-1); out+=')'; i++; continue; }
    if (parenD>0) { out+=css[i]; i++; continue; }
    if (css[i]==='{') { out=out.trimEnd()+' {\n'; indent++; i++; continue; }
    if (css[i]==='}') { indent=Math.max(0,indent-1); out=out.trimEnd()+'\n'+IND.repeat(indent)+'}\n\n'; i++; continue; }
    if (css[i]===';') { out=out.trimEnd()+';\n'; i++; continue; }
    if (css[i]===':' && indent>0) {
      const before=out.trimEnd();
      const lastNL=before.lastIndexOf('\n');
      const lastLine=before.slice(lastNL+1);
      if (lastLine.trim()&&!lastLine.includes(':')) { out=before+': '; i++; continue; }
    }
    if (css[i]==='\n'||css[i]==='\r') { i++; continue; }
    if (css[i]===' '||css[i]==='\t') {
      if (out.length&&!out.endsWith(' ')&&!out.endsWith('\n')) out+=' ';
      i++; continue;
    }
    if (out.endsWith('\n')||out==='') out+=IND.repeat(indent);
    out+=css[i]; i++;
  }
  return out.replace(/\n{3,}/g,'\n\n').trim();
}

// ── History ────────────────────────────────────────────────
function getHistory() { return db[`history:${currentDomain}`]||{stack:[],pos:-1}; }
function pushHistory(css) {
  const h=getHistory();
  h.stack=h.stack.slice(0,h.pos+1); h.stack.push(css);
  if(h.stack.length>80)h.stack.shift();
  h.pos=h.stack.length-1;
  save({[`history:${currentDomain}`]:h});
}
function undo(){const h=getHistory();if(h.pos<=0)return null;h.pos--;save({[`history:${currentDomain}`]:h});return h.stack[h.pos];}
function redo(){const h=getHistory();if(h.pos>=h.stack.length-1)return null;h.pos++;save({[`history:${currentDomain}`]:h});return h.stack[h.pos];}

// ── Line numbers ───────────────────────────────────────────
function updateLines(ta) {
  const n=(ta.value.match(/\n/g)||[]).length+1;
  const g=document.getElementById('line-numbers');
  if(!g)return;
  while(g.children.length<n){const d=document.createElement('div');d.textContent=g.children.length+1;g.appendChild(d);}
  while(g.children.length>n)g.lastChild.remove();
  g.scrollTop=ta.scrollTop;
}

// ── Highlight sync ─────────────────────────────────────────
function syncHL(ta) {
  const hl=document.getElementById('css-highlight');
  if(!hl)return;
  if(!settings.syntaxHL){hl.innerHTML='';return;}
  hl.innerHTML=highlightCSS(ta.value+'\n');
  hl.scrollTop=ta.scrollTop;
  hl.scrollLeft=ta.scrollLeft;
}

function makeShareURL(css, domain, name) {
  const data = JSON.stringify({ name: name || 'shared preset', css, domain, v: 1 });
  const b64 = btoa(unescape(encodeURIComponent(data)));
  // Use import.html for local share, workshop for public share
  return browser.runtime.getURL('import.html') + '#data=' + b64;
}

// ── Editor ────────────────────────────────────────────────
function setupEditor() {
  const ta=document.getElementById('css-input');
  if (!ta) return;
  ta.value=db[`draft:${currentDomain}`]||'';
  ta.scrollTop=db[`scroll:${currentDomain}`]||0;
  updateLines(ta); syncHL(ta);
  if(!getHistory().stack.length&&ta.value)pushHistory(ta.value);
  const lastVisualSelector = db['visual:lastSelector'];
  const lastVisualCss = db['visual:lastCss'];
  if (lastVisualSelector && lastVisualCss && String(lastVisualCss).trim()) {
    upsertVisualCSSBlock(ta, lastVisualSelector, lastVisualCss);
    const key = editorMode === 'global' ? 'draft:global' : `draft:${currentDomain}`;
    db[key] = ta.value;
    save({ [key]: ta.value });
    // Clear so it won't be duplicated by content-script injection.
    browser.storage.local.set({ 'visual:lastCss': '' }).catch(() => {});
    notify('Visual CSS restored');
  }

  let scrollD;
  ta.addEventListener('scroll',()=>{
    clearTimeout(scrollD);
    scrollD=setTimeout(()=>save({[`scroll:${currentDomain}`]:ta.scrollTop}),300);
    const hl=document.getElementById('css-highlight');
    if(hl){hl.scrollTop=ta.scrollTop;hl.scrollLeft=ta.scrollLeft;}
    updateLines(ta);
  });

  let inpD,histD;
  ta.addEventListener('input',()=>{
    updateLines(ta); syncHL(ta);
    clearTimeout(inpD);
    inpD=setTimeout(async()=>{
      const key = editorMode === 'global' ? 'draft:global' : `draft:${currentDomain}`;
      await save({ [key]: ta.value });
      if (editorMode === 'global') {
        const domains = new Set(Object.keys(db).filter(k => k.startsWith('site:')).map(k => k.slice(5)));
        domains.add(currentDomain);
        for (const d of domains) await injectToDomain(d);
      } else {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        injectToTab(buildDomainCSS(currentDomain, tab && tab.url ? tab.url : ''));
      }
    },150);
    clearTimeout(histD);
    histD=setTimeout(()=>pushHistory(ta.value),800);
  });

  ta.addEventListener('keydown',e=>{
    if(e.key==='Tab'){
      e.preventDefault();
      const s=ta.selectionStart,v=ta.value;
      ta.value=v.slice(0,s)+'  '+v.slice(ta.selectionEnd);
      ta.selectionStart=ta.selectionEnd=s+2;
      updateLines(ta);syncHL(ta);
    }
    if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!e.shiftKey){
      e.preventDefault();
      const v=undo();
      if(v!==null){ta.value=v;updateLines(ta);syncHL(ta);injectToTab(buildDomainCSS(currentDomain));save({[editorMode==='global'?'draft:global':`draft:${currentDomain}`]:v});}
    }
    if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){
      e.preventDefault();
      const v=redo();
      if(v!==null){ta.value=v;updateLines(ta);syncHL(ta);injectToTab(buildDomainCSS(currentDomain));save({[editorMode==='global'?'draft:global':`draft:${currentDomain}`]:v});}
    }
  });

  ta.addEventListener('paste',()=>setTimeout(()=>{
    if(settings.formatOnPaste)ta.value=formatCSS(ta.value);
    updateLines(ta);syncHL(ta);
    injectToTab(buildDomainCSS(currentDomain));
    save({[editorMode==='global'?'draft:global':`draft:${currentDomain}`]:ta.value});
    pushHistory(ta.value);
  },0));

  ta.addEventListener('blur',()=>{
    if(settings.formatOnBlur&&ta.value.trim()){
      ta.value=formatCSS(ta.value);
      updateLines(ta);syncHL(ta);
      save({[editorMode==='global'?'draft:global':`draft:${currentDomain}`]:ta.value});
    }
  });

  const formatBtn = document.getElementById('btn-format');
  if (formatBtn) {
    formatBtn.addEventListener('click',()=>{
      ta.value=formatCSS(ta.value);
      updateLines(ta);syncHL(ta);
      injectToTab(buildDomainCSS(currentDomain));
      save({[editorMode==='global'?'draft:global':`draft:${currentDomain}`]:ta.value});
      pushHistory(ta.value);
    });
  }

  // Save preset
  const saveBtn=document.getElementById('btn-save-preset');
  if (!saveBtn) return;
  saveBtn.addEventListener('click',async()=>{
    const css=ta.value.trim();
    if(!css)return;
    const domain=normDom(currentDomain);
    const askUrlContains = (initial = '') => {
      const v = prompt('Condition (optional): URL contains', initial || '');
      return v === null ? null : v.trim();
    };
    if(saveBtn.dataset.mode==='edit'){
      const id=ta.dataset.editingId;
      const preset=db[`preset:${id}`];
      if(!preset)return;
      const urlContains = askUrlContains((preset.conditions && preset.conditions.urlContains) || '');
      if (urlContains === null) return;
      await save({[`preset:${id}`]:{...preset,css,conditions:{urlContains}}});
      db=await browser.storage.local.get(null);
      injectToTab(buildDomainCSS(domain));
      saveBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/></svg>save preset';
      saveBtn.dataset.mode='';
      ta.dataset.editingId='';
    } else {
      const name=prompt('Preset name:');
      if(!name)return;
      const id=genId();
      const urlContains = askUrlContains('');
      if (urlContains === null) return;
      if (editorMode === 'global') {
        await save({[`preset:${id}`]:{id,name,css,type:'global',domain:'*',conditions:{urlContains}}});
        const gset = new Set(globalActivePresets());
        gset.add(id);
        await save({ 'global:activePresets': [...gset], 'draft:global': '' });
      } else {
        await save({[`preset:${id}`]:{id,name,css,type:'site',domain,conditions:{urlContains}}});
        const site=siteData(domain);
        site.activePresets=[...new Set([...(site.activePresets||[]),id])];
        site.enabled=true;
        await save({[`site:${domain}`]:site,[`draft:${domain}`]:''});
      }
      ta.value=''; updateLines(ta); syncHL(ta);
      db=await browser.storage.local.get(null);
    }
    renderPresets();renderSites();
    const title=document.querySelector('.titlebar-title');
    if (title) { title.classList.remove('title-saved'); void title.offsetWidth; title.classList.add('title-saved'); }
  });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertVisualCSSBlock(ta, selector, cssBlock) {
  const sel = String(selector || '').trim();
  const block = String(cssBlock || '').trim();
  if (!sel || !block) return;
  const re = new RegExp(`(^|\\n)\\s*${escapeRegExp(sel)}\\s*\\{[\\s\\S]*?\\}\\s*(?=\\n|$)`, 'm');
  if (re.test(ta.value)) {
    ta.value = ta.value.replace(re, '\n' + block + '\n');
  } else {
    ta.value = (ta.value.trimEnd() ? ta.value.trimEnd() + '\n\n' : '') + block + '\n';
  }
  updateLines(ta);
  syncHL(ta);
}

// ── Settings ──────────────────────────────────────────────
function setupSettings() {
  document.querySelectorAll('[data-setting]').forEach(btn=>{
    const key=btn.dataset.setting;
    btn.classList.toggle('on',!!settings[key]);
    btn.addEventListener('click',async()=>{
      settings[key]=!settings[key];
      btn.classList.toggle('on',settings[key]);
      await save({settings});
      if(key==='syntaxHL'){
        const ta=document.getElementById('css-input');
        if (ta) {
          ta.style.color = settings[key] ? 'transparent' : '#c9d1d9';
          syncHL(ta);
        }
      }
    });
  });

  // Theme button
  const themeBtn = document.getElementById('btn-theme');
  const themes = ['system', 'dark', 'light'];
  const syncThemeBtn = () => {
    if (!themeBtn) return;
    themeBtn.textContent = (settings.theme || 'system');
  };
  syncThemeBtn();
  if (themeBtn) {
    themeBtn.addEventListener('click', async () => {
      const cur = settings.theme || 'system';
      const next = themes[(themes.indexOf(cur) + 1) % themes.length];
      applyTheme(next);
      await save({ settings });
      syncThemeBtn();
    });
  }

  const analyticsBtn = document.getElementById('btn-analytics');
  const syncAnalyticsBtn = () => {
    if (!analyticsBtn) return;
    analyticsBtn.textContent = settings.analyticsEnabled ? 'on' : 'off';
  };
  const ensureAnalyticsPolling = async () => {
    if (analyticsPollT) {
      clearInterval(analyticsPollT);
      analyticsPollT = null;
    }
    // installs row removed from settings UI
  };
  syncAnalyticsBtn();
  ensureAnalyticsPolling();
  if (analyticsBtn) {
    analyticsBtn.addEventListener('click', async () => {
      settings.analyticsEnabled = !settings.analyticsEnabled;
      if (!settings.analyticsClientId) settings.analyticsClientId = genId() + genId();
      await save({ settings });
      syncAnalyticsBtn();
      await maybeTrackUsage();
      await ensureAnalyticsPolling();
    });
  }

  // TEMP: active users ping for bot, every 5s while popup is open
  if (telemetryPingT) clearInterval(telemetryPingT);
  const startPing = async () => {
    try {
      const s = (db && db.settings) ? db.settings : settings;
      if (!s || !s.telemetryUrl) return;
      if (!s.analyticsClientId) s.analyticsClientId = genId() + genId();
      await save({ settings: s });
      telemetryPingT = setInterval(() => {
        fetch(s.telemetryUrl, {
          method: 'POST',
          headers: Object.assign(
            { 'content-type': 'application/json' },
            s.telemetrySecret ? { 'x-telemetry-secret': s.telemetrySecret } : {}
          ),
          body: JSON.stringify({
            event: 'active',
            clientId: s.analyticsClientId,
            version: (browser.runtime && browser.runtime.getManifest && browser.runtime.getManifest().version) || ''
          })
        }).catch(() => {});
      }, 5000);
    } catch {}
  };
  startPing();
  window.addEventListener('beforeunload', () => { try { if (telemetryPingT) clearInterval(telemetryPingT); } catch {} });

  const visualBtn = document.getElementById('btn-visual-mode');
  if (visualBtn) {
    visualBtn.addEventListener('click', async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      notify('Visual mode: click an element');
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'START_VISUAL_MODE' });
      } catch {
        await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
        await browser.tabs.sendMessage(tab.id, { type: 'START_VISUAL_MODE' }).catch(() => {});
      }
    });
  }

  const openInWindowBtn = document.getElementById('btn-open-window');
  const syncOpenWindowBtn = () => {
    if (!openInWindowBtn) return;
    openInWindowBtn.textContent = settings.openInWindow ? 'on' : 'off';
  };
  syncOpenWindowBtn();
  if (openInWindowBtn) {
    openInWindowBtn.addEventListener('click', async () => {
      settings.openInWindow = !settings.openInWindow;
      await save({ settings });
      syncOpenWindowBtn();
    });
  }

  const exportBtn = document.getElementById('btn-export-all');
  if (exportBtn) {
    exportBtn.addEventListener('click',()=>{
      const presets=allPresets();
      const blob=new Blob([JSON.stringify(presets,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=`css-editor-presets-${Date.now()}.json`;a.click();
      URL.revokeObjectURL(url);
      notify('Presets exported');
    });
  }

  // Import from file - opens in separate tab
  const importBtn = document.getElementById('btn-import-all');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const importPageUrl = browser.runtime.getURL('import.html') + '?mode=file';
      await browser.tabs.create({ url: importPageUrl });
    });
  }

  const clearBtn = document.getElementById('btn-clear-all');
  if (clearBtn) {
    clearBtn.addEventListener('click',async()=>{
      if(!confirm('Delete all presets, drafts and site data?'))return;
      const keys=Object.keys(db).filter(k=>k.startsWith('preset:')||k.startsWith('site:')||k.startsWith('draft:')||k.startsWith('history:')||k.startsWith('scroll:'));
      await browser.storage.local.remove(keys);
      keys.forEach(k=>delete db[k]);
      const ta=document.getElementById('css-input');
      if (ta) { ta.value=''; updateLines(ta); syncHL(ta); }
      injectToTab('');renderPresets();renderSites();
      notify('All data cleared');
    });
  }


}

async function maybeTrackUsage() {
  if (!settings.analyticsEnabled) return;
  if (!settings.analyticsClientId) settings.analyticsClientId = genId() + genId();
  try {
    const url = settings.telemetryUrl;
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        settings.telemetrySecret ? { 'x-telemetry-secret': settings.telemetrySecret } : {}
      ),
      body: JSON.stringify({
        event: 'active',
        clientId: settings.analyticsClientId,
        version: (browser.runtime && browser.runtime.getManifest && browser.runtime.getManifest().version) || ''
      })
    }).catch(() => {});
    await save({ settings });
  } catch {}
}

// ── Toast ─────────────────────────────────────────────────
let notifT;
function notify(msg) {
  let el=document.getElementById('notif-toast');
  if(!el){
    el=document.createElement('div');el.id='notif-toast';
    el.style.cssText='position:fixed;bottom:10px;right:10px;left:10px;background:rgba(255,255,255,.06);backdrop-filter:blur(8px);border:1px solid rgba(46,204,113,.35);border-radius:12px;padding:8px 10px;font-size:9px;color:rgba(46,204,113,.95);z-index:999;transition:opacity .25s, transform .25s;font-family:"Fira Code",monospace;transform:translateY(4px);';
    document.body.appendChild(el);
  }
  el.textContent='✓ '+msg;
  el.style.opacity='1';
  el.style.transform='translateY(0)';
  clearTimeout(notifT);
  notifT=setTimeout(()=>{el.style.opacity='0';el.style.transform='translateY(4px)';},2200);
}

// ── Share Link Functions ──────────────────────────────────
function generatePresetLink(preset) {
  const data = JSON.stringify({
    name: preset.name,
    css: preset.css,
    domain: preset.domain,
    v: 1
  });
  const b64 = btoa(unescape(encodeURIComponent(data)));
  return browser.runtime.getURL('import.html') + '#data=' + b64;
}

// ── Presets ───────────────────────────────────────────────
async function renderPresets() {
  const container = window.$id ? window.$id('presets-content', 'presets-list') : document.getElementById('presets-content');
  if (!container) return;
  try {
    // Popup can be opened/closed frequently; always refresh from storage.
    db = await browser.storage.local.get(null);

    const presets   = allPresets();
    if (!presets.length) {
      container.innerHTML = '<div class="empty">no presets yet</div>';
      return;
    }

  const nd     = normDom(currentDomain);

  // Group: collect all domains that have presets + current domain
  const allHosts = new Set();
  presets.forEach(p => { if (p.type === 'site' && p.domain) allHosts.add(p.domain); });
  allHosts.add(nd);

  // Icons (inline SVG, no emoji)
  const icEdit  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const icShare = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
  const icDel   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
  const icPlus  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  let html = `<div class="view-hero">
    <div class="view-hero-title">preset workspace</div>
    <div class="view-hero-sub">${presets.length} total preset${presets.length !== 1 ? 's' : ''}</div>
  </div>`;

  const groupCollapsed = db['ui:presetsCollapsed'] || {};
  const matchesSearch = (preset, host) => {
    if (!presetsSearchTerm) return true;
    const hay = `${preset.name || ''} ${preset.css || ''} ${host || ''} ${(preset.conditions && preset.conditions.urlContains) || ''}`.toLowerCase();
    return hay.includes(presetsSearchTerm);
  };

  const globalPresets = presets.filter(p => p.type === 'global' && matchesSearch(p, 'global'));
  if (globalPresets.length) {
    const gActive = new Set(globalActivePresets());
    const isCollapsed = !!groupCollapsed['__global__'];
    html += `<div class="preset-group">
      <div class="preset-group-header">
        <button class="preset-group-toggle" data-group-toggle="__global__">${isCollapsed ? '▸' : '▾'}</button>
        <span class="preset-group-domain">global</span>
        <span class="preset-group-count">${globalPresets.length}</span>
      </div>`;
    globalPresets.forEach(p => {
      const isOn = gActive.has(p.id);
      const ruleCount = (p.css || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('/')).length;
      const scopeTxt = p.conditions && p.conditions.urlContains ? ` · url:*${p.conditions.urlContains}*` : '';
      html += `<div class="preset-card ${isOn ? 'on' : ''}" data-id="${p.id}" data-domain="__global__" ${isCollapsed ? 'style="display:none"' : ''}>
        <div class="preset-card-left"><div class="preset-card-dot ${isOn ? 'on' : ''}"></div>
        <div class="preset-card-info"><span class="preset-card-name">${p.name}</span>
        <span class="preset-card-meta">${ruleCount} rules${scopeTxt}</span></div></div>
        <div class="preset-card-actions">
          <button class="preset-action-btn preset-edit" data-edit="${p.id}" title="Edit">${icEdit}</button>
          <button class="preset-action-btn preset-share" data-share="${p.id}" title="Share">${icShare}</button>
          <button class="preset-action-btn preset-del" data-del="${p.id}" title="Delete">${icDel}</button>
          <button class="preset-toggle-btn ${isOn ? 'on' : ''}" data-domain="__global__" data-pid="${p.id}">${isOn ? 'on' : 'off'}</button>
        </div></div>`;
    });
    html += `</div>`;
  }

  for (const host of [...allHosts].sort()) {
    const hostPresets = presets.filter(p => p.type === 'site' && p.domain === host && matchesSearch(p, host));
    if (!hostPresets.length) continue;

    const hostActive = new Set(siteData(host).activePresets || []);
    const isCollapsed = !!groupCollapsed[host];

    html += `<div class="preset-group">
      <div class="preset-group-header">
        <button class="preset-group-toggle" data-group-toggle="${host}">${isCollapsed ? '▸' : '▾'}</button>
        <span class="preset-group-domain">${host}</span>
        <span class="preset-group-count">${hostPresets.length}</span>
        <button class="preset-add-btn" data-type-add="site" data-domain="${host}" title="Add preset for ${host}">
          ${icPlus}
        </button>
      </div>`;

    hostPresets.forEach(p => {
      const isOn = hostActive.has(p.id);
      const ruleCount = (p.css || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('/')).length;
      const scopeTxt = p.conditions && p.conditions.urlContains ? ` · url:*${p.conditions.urlContains}*` : '';
      html += `
      <div class="preset-card ${isOn ? 'on' : ''}" data-id="${p.id}" data-domain="${host}" ${isCollapsed ? 'style="display:none"' : ''}>
        <div class="preset-card-left">
          <div class="preset-card-dot ${isOn ? 'on' : ''}"></div>
          <div class="preset-card-info">
            <span class="preset-card-name">${p.name}</span>
            <span class="preset-card-meta">${ruleCount} rule${ruleCount !== 1 ? 's' : ''}${scopeTxt}</span>
          </div>
        </div>
        <div class="preset-card-actions">
          <button class="preset-action-btn preset-edit" data-edit="${p.id}" title="Edit">${icEdit}</button>
          <button class="preset-action-btn preset-share" data-share="${p.id}" title="Share">${icShare}</button>
          <button class="preset-action-btn preset-del" data-del="${p.id}" title="Delete">${icDel}</button>
          <button class="preset-toggle-btn ${isOn ? 'on' : ''}" data-domain="${host}" data-pid="${p.id}">${isOn ? 'on' : 'off'}</button>
        </div>
      </div>`;
    });

    html += `</div>`;
  }

  container.innerHTML = html;

  // Toggle on card click (not on action buttons)
  container.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.closest('.preset-action-btn') || e.target.closest('.preset-toggle-btn')) return;
      const id = card.dataset.id, domain = card.dataset.domain;
      if (domain === '__global__') {
        const gset = new Set(globalActivePresets());
        if (gset.has(id)) gset.delete(id); else gset.add(id);
        await save({ 'global:activePresets': [...gset] });
        db = await browser.storage.local.get(null);
        await injectToDomain(currentDomain);
        scheduleRender('presets'); scheduleRender('sites');
        return;
      }
      const site = siteData(domain);
      const set  = new Set(site.activePresets || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      site.activePresets = [...set];
      if (!site.enabled && set.size > 0) site.enabled = true;
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      await injectToDomain(domain);
      scheduleRender('presets'); scheduleRender('sites');
    });
  });

  // Toggle button
  container.querySelectorAll('.preset-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const { domain, pid } = btn.dataset;
      if (domain === '__global__') {
        const gset = new Set(globalActivePresets());
        if (gset.has(pid)) gset.delete(pid); else gset.add(pid);
        await save({ 'global:activePresets': [...gset] });
        db = await browser.storage.local.get(null);
        await injectToDomain(currentDomain);
        scheduleRender('presets'); scheduleRender('sites');
        return;
      }
      const site = siteData(domain);
      const set  = new Set(site.activePresets || []);
      if (set.has(pid)) set.delete(pid); else set.add(pid);
      site.activePresets = [...set];
      if (!site.enabled && set.size > 0) site.enabled = true;
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      await injectToDomain(domain);
      scheduleRender('presets'); scheduleRender('sites');
    });
  });

  // Edit
  container.querySelectorAll('.preset-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id     = btn.dataset.edit;
      const preset = db[`preset:${id}`];
      if (!preset) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      const editorTab = document.querySelector('[data-tab="editor"]');
      if (editorTab) editorTab.classList.add('active');
      const ep = window.$pane ? window.$pane('editor') : document.getElementById('editor-pane');
      if (ep) ep.classList.add('active');
      const ta = document.getElementById('css-input');
      ta.value = preset.css; ta.dataset.editingId = id; ta.focus();
      updateLines(ta); syncHL(ta);
      const sb = document.getElementById('btn-save-preset');
      sb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/></svg>update "${preset.name}"`;
      sb.dataset.mode = 'edit';
    });
  });

  // Share — copy generatePresetLink (correct format with name)
  container.querySelectorAll('.preset-share').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id     = btn.dataset.share;
      const preset = db[`preset:${id}`];
      if (!preset) return;
      const link = generatePresetLink(preset);
      try { await navigator.clipboard.writeText(link); } catch {
        const inp = document.createElement('input');
        inp.value = link; document.body.appendChild(inp); inp.select();
        document.execCommand('copy'); document.body.removeChild(inp);
      }
      notify('Link copied!');
    });
  });

  // Delete
  container.querySelectorAll('.preset-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.del;
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
      scheduleRender('presets'); scheduleRender('sites');
    });
  });

  // Add preset (+ button per group)
  container.querySelectorAll('.preset-add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = prompt('Preset name:'); if (!name) return;
      const css  = prompt('CSS:');         if (!css)  return;
      const cond = prompt('Condition (optional): URL contains', '') || '';
      const domain = btn.dataset.domain;
      const id = genId();
      await save({ [`preset:${id}`]: { id, name, css, type: 'site', domain, conditions: { urlContains: cond.trim() } } });
      const site = siteData(domain);
      site.activePresets = [...new Set([...(site.activePresets || []), id])];
      site.enabled = true;
      await save({ [`site:${domain}`]: site });
      db = await browser.storage.local.get(null);
      scheduleRender('presets'); scheduleRender('sites');
    });
  });

  // Collapse/expand site groups in presets view
  container.querySelectorAll('[data-group-toggle]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.groupToggle;
      const state = db['ui:presetsCollapsed'] || {};
      state[key] = !state[key];
      await save({ 'ui:presetsCollapsed': state });
      db['ui:presetsCollapsed'] = state;
      scheduleRender('presets');
    });
  });
  } catch (e) {
    try { console.warn('renderPresets failed:', e); } catch {}
    container.innerHTML = '<div class="empty">no presets yet</div>';
  }
}





// ── Sites ─────────────────────────────────────────────────
async function renderSites() {
  const container = window.$id ? window.$id('sites-content', 'sites-list') : document.getElementById('sites-content');
  if (!container) return;
  try {
    db = await browser.storage.local.get(null);

    const searchEl = document.getElementById('sites-search');
    const search = ((searchEl && searchEl.value) || '').toLowerCase();
    const domains=new Set();
    allPresets().filter(p=>p.domain).forEach(p=>domains.add(p.domain));
    Object.keys(db).filter(k=>k.startsWith('site:')).forEach(k=>domains.add(k.slice(5)));
    if(currentDomain)domains.add(currentDomain);
    const filtered=[...domains].filter(d=>d.includes(search));
    if(!filtered.length){container.innerHTML='<div class="empty">no sites yet</div>';return;}

  let html=`<div class="view-hero">
    <div class="view-hero-title">sites control</div>
    <div class="view-hero-sub">${filtered.length} tracked site${filtered.length!==1?'s':''}</div>
  </div>`;
  filtered.forEach(domain=>{
    const site=siteData(domain);
    const activeSet=new Set(site.activePresets||[]);
    const globalSet=new Set(globalActivePresets());
    const domPs=allPresets().filter(p=>p.domain===domain||p.type==='global');
    const activePs=domPs.filter(p=>p.type==='global'?globalSet.has(p.id):activeSet.has(p.id));
    const rules=activePs.reduce((a,p)=>a+(p.css||'').split('\n').filter(l=>l.trim()&&!l.trim().startsWith('/')).length,0);
    const meta=`${activePs.length} preset${activePs.length!==1?'s':''} · ${rules} rules`;

    html+=`<div class="site-card ${site.enabled?'on':''}" data-domain="${domain}">
      <div class="site-top">
        <div class="favicon"><img src="https://www.google.com/s2/favicons?domain=${domain}" onerror="this.style.display='none'"></div>
        <div class="site-info"><div class="site-domain">${domain}</div><div class="site-meta">${meta}</div></div>
        <button class="toggle ${site.enabled?'on':''}" data-domain="${domain}"></button>
        <button class="disable-all" data-domain="${domain}" title="Disable all styles on this site">⊘</button>
        <button class="site-del" data-domain="${domain}" title="remove site">x</button>
      </div>`;
    if(domPs.length){
      html+=`<button class="expand-btn" data-domain="${domain}">
        <span>${site._expanded ? '▴' : '▾'}</span>
        ${site._expanded?'hide':'presets'}
      </button>`;
      if(site._expanded){
        html+='<div class="preset-rows">';
        domPs.forEach(p=>{
          const on=activeSet.has(p.id);
          const isOn = p.type === 'global' ? globalSet.has(p.id) : on;
          html+=`<div class="preset-row">
            <div class="preset-dot ${isOn?'':'off'}"></div>
            <span class="preset-name">${p.name}</span>
            <span class="preset-rules">${(p.css||'').split('\n').filter(l=>l.trim()).length}r</span>
            <button class="preset-toggle-btn ${isOn?'on':''}" data-domain="${domain}" data-ptype="${p.type||'site'}" data-pid="${p.id}">${isOn?'on':'off'}</button>
          </div>`;
        });
        html+='</div>';
      }
    }
    html+='</div>';
  });

  container.innerHTML=html;

  container.querySelectorAll('.site-del').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      const domain=btn.dataset.domain;
      if(!confirm(`Remove ${domain}?`))return;
      await browser.storage.local.remove(`site:${domain}`);
      delete db[`site:${domain}`];
      await injectToDomain(domain);
      scheduleRender('sites');
    });
  });
  container.querySelectorAll('.toggle').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      const domain=btn.dataset.domain;
      const site=siteData(domain);
      site.enabled=!site.enabled;
      await save({[`site:${domain}`]:site});
      db=await browser.storage.local.get(null);
      await injectToDomain(domain);
      scheduleRender('sites');
    });
  });
  container.querySelectorAll('.disable-all:not(.site-tailwind)').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      const domain=btn.dataset.domain;
      const site=siteData(domain);
      site.activePresets=[];
      await save({[`site:${domain}`]:site});
      db=await browser.storage.local.get(null);
      await injectToDomain(domain);
      scheduleRender('sites');
      notify('All styles disabled');
    });
  });
  container.querySelectorAll('.expand-btn').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const domain=btn.dataset.domain;
      const site=siteData(domain);
      site._expanded=!site._expanded;
      await save({[`site:${domain}`]:site});
      db=await browser.storage.local.get(null);
      scheduleRender('sites');
    });
  });
  container.querySelectorAll('.preset-toggle-btn').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const domain=btn.dataset.domain,pid=btn.dataset.pid,ptype=btn.dataset.ptype||'site';
      if (ptype === 'global') {
        const gset = new Set(globalActivePresets());
        if(gset.has(pid))gset.delete(pid);else gset.add(pid);
        await save({'global:activePresets':[...gset]});
        db=await browser.storage.local.get(null);
        await injectToDomain(domain);
        scheduleRender('sites'); scheduleRender('presets');
        return;
      }
      const site=siteData(domain);
      const set=new Set(site.activePresets||[]);
      if(set.has(pid))set.delete(pid);else set.add(pid);
      site.activePresets=[...set];
      await save({[`site:${domain}`]:site});
      db=await browser.storage.local.get(null);
      await injectToDomain(domain);
      scheduleRender('sites'); scheduleRender('presets');
    });
  });
  const sitesSearchInput = document.getElementById('sites-search');
  if (sitesSearchInput && sitesSearchInput.dataset.bound !== '1') {
    sitesSearchInput.dataset.bound = '1';
    sitesSearchInput.addEventListener('input', () => {
      const val = document.getElementById('sites-search').value.trim();
    // Detect paste of a share link — open import page instead of filtering
    if (val.includes('import.html#data=') || val.includes('#data=')) {
      const hash = val.includes('#') ? val.slice(val.indexOf('#')) : '';
      if (hash) {
        document.getElementById('sites-search').value = '';
        browser.tabs.create({ url: browser.runtime.getURL('import.html') + hash });
        return;
      }
    }
    scheduleRender('sites');
    });
  }
  } catch (e) {
    try { console.warn('renderSites failed:', e); } catch {}
    container.innerHTML = '<div class="empty">no sites yet</div>';
  }
}

// Listen for storage changes (when import happens)
browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local') {
    // Reload all data from storage
    db = await browser.storage.local.get(null);
    await maybeTrackUsage();
    // Update UI only when relevant keys change (avoid rare "blink" on frequent draft/settings writes)
    const keys = changes ? Object.keys(changes) : [];
    const affectsPresets = keys.some(k =>
      k.startsWith('preset:') ||
      k === 'global:activePresets' ||
      k === 'ui:presetsCollapsed'
    );
    const affectsSites = keys.some(k =>
      k.startsWith('site:') ||
      k.startsWith('preset:') ||
      k === 'global:activePresets'
    );
    if (affectsPresets) scheduleRender('presets');
    if (affectsSites) scheduleRender('sites');
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'VISUAL_SELECTOR_CSS') {
    (async () => {
      const ta = document.getElementById('css-input');
      if (!ta) return;
      upsertVisualCSSBlock(ta, msg.selector, msg.css);

      const key = editorMode === 'global' ? 'draft:global' : `draft:${currentDomain}`;
      db[key] = ta.value;
      await save({ [key]: ta.value });

      // Immediately inject combined CSS.
      if (editorMode === 'global') {
        const domains = new Set(Object.keys(db).filter(k => k.startsWith('site:')).map(k => k.slice(5)));
        domains.add(currentDomain);
        for (const d of domains) await injectToDomain(d);
      } else {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        await injectToTab(buildDomainCSS(currentDomain, tab && tab.url ? tab.url : ''));
      }

      // Avoid duplicate injection on next reload.
      browser.storage.local.set({ 'visual:lastCss': '' }).catch(() => {});
      notify('Visual CSS updated');
    })();
    return;
  }

  if (msg.type === 'VISUAL_SELECTOR_PICKED') {
    const ta = document.getElementById('css-input');
    if (!ta) return;
    const snippet = `${msg.selector} {\n  \n}`;
    const start = ta.selectionStart || ta.value.length;
    const end = ta.selectionEnd || ta.value.length;
    ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + msg.selector.length + 5;
    updateLines(ta);
    syncHL(ta);
    notify('Selector pasted into editor');
  }
});
