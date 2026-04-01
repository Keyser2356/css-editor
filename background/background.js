// MV2 background — works in Firefox and Chrome
// Polyfill: Firefox uses 'browser', Chrome uses 'chrome'
if (typeof browser === 'undefined') { var browser = chrome; }

function genId() {
  return 'p' + Math.random().toString(36).substr(2, 9);
}

function normDom(d) {
  return (d || '').replace(/^www\./, '').toLowerCase();
}

async function maybePingTelemetry() {
  try {
    const db = await browser.storage.local.get(null);
    const settings = db.settings || {};
    if (!settings.telemetryUrl) settings.telemetryUrl = 'http://localhost:8787/ping';
    if (!settings.analyticsClientId) settings.analyticsClientId = genId() + genId();

    const payload = {
      event: 'active',
      clientId: settings.analyticsClientId,
      version: (browser.runtime && browser.runtime.getManifest && browser.runtime.getManifest().version) || ''
    };

    await fetch(settings.telemetryUrl, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        settings.telemetrySecret ? { 'x-telemetry-secret': settings.telemetrySecret } : {}
      ),
      body: JSON.stringify(payload)
    }).catch(() => {});

    await browser.storage.local.set({ settings });
  } catch {}
}

async function maybeSendInstallTelemetry(details) {
  try {
    const db = await browser.storage.local.get(null);
    const settings = db.settings || {};
    if (!settings.telemetryUrl) settings.telemetryUrl = 'http://localhost:8787/ping';
    if (!settings.analyticsClientId) settings.analyticsClientId = genId() + genId();

    // Send install only once per profile.
    if (settings.telemetryInstallSent) return;
    if (details && details.reason && details.reason !== 'install') return;

    const payload = {
      event: 'install',
      clientId: settings.analyticsClientId,
      version: (browser.runtime && browser.runtime.getManifest && browser.runtime.getManifest().version) || ''
    };

    await fetch(settings.telemetryUrl, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        settings.telemetrySecret ? { 'x-telemetry-secret': settings.telemetrySecret } : {}
      ),
      body: JSON.stringify(payload)
    }).catch(() => {});

    settings.telemetryInstallSent = true;
    await browser.storage.local.set({ settings });
  } catch {}
}

async function buildDomainCSS(domain) {
  const db   = await browser.storage.local.get(null);
  const site = db[`site:${domain}`] || { activePresets: [] };
  return (site.activePresets || [])
    .map(id => db[`preset:${id}`])
    .filter(p => p && p.css)
    .map(p => p.css)
    .join('\n');
}

async function injectToDomain(domain, css) {
  const tabs       = await browser.tabs.query({});
  const normTarget = normDom(domain);
  for (const tab of tabs) {
    try {
      const tabDomain = normDom(new URL(tab.url).hostname);
      if (tabDomain !== normTarget) continue;
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css: css || '' });
      } catch {
        // Content script not yet loaded — inject it first (MV2 style)
        await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
        await browser.tabs.sendMessage(tab.id, { type: 'APPLY_CSS', css: css || '' }).catch(() => {});
      }
    } catch { /* invalid tab URL */ }
  }
}

// Ping on startup and periodically (MV2 alarms)
try {
  browser.runtime.onStartup && browser.runtime.onStartup.addListener(() => { maybePingTelemetry(); });
  browser.runtime.onInstalled && browser.runtime.onInstalled.addListener((details) => {
    maybeSendInstallTelemetry(details);
    maybePingTelemetry();
  });
  if (browser.alarms && browser.alarms.create) {
    browser.alarms.create('telemetry', { periodInMinutes: 60 });
    browser.alarms.onAlarm.addListener(a => { if (a && a.name === 'telemetry') maybePingTelemetry(); });
  }
} catch {}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // opportunistic telemetry: any message means extension is in use
    maybePingTelemetry();

    // Relay from popup to active tab
    if (msg.type === 'TO_TAB') {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        try { await browser.tabs.sendMessage(tab.id, msg.payload); }
        catch {
          await browser.tabs.executeScript(tab.id, { file: 'content/injector.js' }).catch(() => {});
          await browser.tabs.sendMessage(tab.id, msg.payload).catch(() => {});
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'IMPORT_PRESET') {
      try {
        const id     = genId();
        const domain = normDom(msg.preset.domain || 'localhost');
        const db     = await browser.storage.local.get(null);

        await browser.storage.local.set({
          [`preset:${id}`]: { id, name: msg.preset.name, css: msg.preset.css, type: 'site', domain }
        });

        const siteKey = `site:${domain}`;
        const site    = db[siteKey] || { activePresets: [], enabled: true };
        if (!site.activePresets) site.activePresets = [];
        if (!site.activePresets.includes(id)) site.activePresets.push(id);
        site.enabled = true;
        await browser.storage.local.set({ [siteKey]: site });

        await injectToDomain(domain, await buildDomainCSS(domain));
        sendResponse({ success: true, id, domain });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'IMPORT_FROM_FILE') {
      try {
        const presets = msg.presets;
        if (!Array.isArray(presets)) { sendResponse({ success: false, error: 'Invalid format' }); return; }

        const db      = await browser.storage.local.get(null);
        const domains = new Set();
        let count     = 0;

        for (const p of presets) {
          if (!p.name || !p.css) continue;
          const id     = genId();
          const domain = normDom(p.domain || 'localhost');
          domains.add(domain);

          await browser.storage.local.set({
            [`preset:${id}`]: { id, name: p.name, css: p.css, type: 'site', domain }
          });

          const siteKey = `site:${domain}`;
          const site    = db[siteKey] || { activePresets: [], enabled: true };
          if (!site.activePresets) site.activePresets = [];
          if (!site.activePresets.includes(id)) site.activePresets.push(id);
          site.enabled = true;
          await browser.storage.local.set({ [siteKey]: site });
          count++;
        }

        for (const domain of domains) {
          await injectToDomain(domain, await buildDomainCSS(domain));
        }

        sendResponse({ success: true, count });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }
  })();

  return true; // keep message channel open for async response
});
