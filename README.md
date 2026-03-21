<p align="center">
  <h1 align="center">CSS Editor</h1>
  <p align="center">
    <b>"Your browser, your rules."</b><br>
    A Firefox extension for injecting custom CSS into any website in real-time, with preset management and per-site configuration.
  </p>

  <p align="center">
    <a href="https://www.mozilla.org/firefox/"><img src="https://img.shields.io/badge/Firefox-%23FF7139.svg?style=for-the-badge&logo=firefox-browser&logoColor=white" alt="Firefox"></a>
    <a href="https://www.waterfox.net/"><img src="https://img.shields.io/badge/Waterfox-%2300AEEF.svg?style=for-the-badge&logo=waterfox&logoColor=white" alt="Waterfox"></a>
    <a href="https://www.google.com/chrome/"><img src="https://img.shields.io/badge/Chromium-%234285F4.svg?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chromium"></a>
    <a href="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions"><img src="https://img.shields.io/badge/WebExtension-MV2-555?style=for-the-badge&logo=googlechrome&logoColor=white" alt="WebExtension MV2"></a>
  </p>
</p>

---

### ✨ What does this extension do?

A minimal popup-based CSS injector that lets you style any website on the fly. Changes apply instantly as you type — no reloads, no Apply button.

1. **Write** CSS directly in the built-in editor.
2. **Watch** styles apply to the page in real-time as you type.
3. **Save** snippets as named presets (global or per-site).
4. **Manage** all your sites and their active presets from one place.
5. **Auto-applies** saved CSS on every page load — no manual action needed.

---

### 📋 Features

- **Real-time Injection:** CSS applies as you type with 150ms debounce.
- **Auto-apply on Load:** Saved drafts and presets are injected automatically when you visit a site.
- **Preset System:** Save and reuse styles across sessions — global or domain-specific.
- **Per-site Control:** Enable/disable injection per domain with a single toggle.
- **Format on Paste/Blur:** CSS is auto-formatted when you paste or leave the editor.
- **Scroll Memory:** Editor remembers your scroll position per domain.
- **Delete Presets & Sites:** Remove entries with the × button.

---

### 🚀 Quick Start

#### 🦊 Firefox / 🌊 Waterfox — `.xpi`

1. Download the latest `.xpi` from [Releases](../../releases)
2. Go to `about:addons` → gear icon → **Install Add-on From File...**
3. Select the `.xpi` file

> **Note:** If Firefox shows a "corrupted" error, set `xpinstall.signatures.required` to `false` in `about:config`. Required for unsigned extensions on Developer Edition / Nightly / Waterfox.

Alternatively, load temporarily via `about:debugging` → **This Firefox** → **Load Temporary Add-on**.

#### 🔵 Chromium — `.zip`

1. Download the latest `.zip` from [Releases](../../releases)
2. Extract the archive to any folder
3. Go to `chrome://extensions/` → enable **Developer mode** (top right)
4. Click **Load unpacked** → select the extracted folder

---

### 🛠️ Customize

To build your own version from source:

1. Clone the repo and edit files inside `popup/` or `content/`
2. Package the extension:
   - **Firefox / Waterfox** — zip the folder as `*.xpi`:
     ```
     my-archive.xpi
     ├── manifest.json
     ├── popup/
     │   └── index.html
     ├── content/
     │   └── injector.js
     └── background/
         └── background.js
     ```
   - **Chromium** — zip the folder as `*.zip` with the same structure, then load via **Load unpacked** in `chrome://extensions/`

3. **Firefox / Waterfox:** drag the `.xpi` into the browser window to install. If a previous version is already installed — it will be replaced automatically.

> Make sure `manifest.json` includes a `browser_specific_settings.gecko.id` field, otherwise Firefox and Waterfox will reject the archive as corrupted.

---

### 🖼️ Logo

To set a custom icon for the extension:

1. Prepare two PNG files: `icon48.png` (48×48px) and `icon96.png` (96×96px)
2. Replace the files in the `icons/` folder
3. Repackage into `.xpi` and reinstall

The icons are referenced in `manifest.json` under `browser_action.default_icon` — you can add that key if you want the toolbar button to show your icon:

```json
"browser_action": {
  "default_popup": "popup/index.html",
  "default_title": "css editor",
  "default_icon": {
    "48": "icons/icon48.png",
    "96": "icons/icon96.png"
  }
}
```

---

### 🏪 Publishing to Firefox Add-ons (AMO)

1. **Create an account** at [addons.mozilla.org](https://addons.mozilla.org/developers/)
2. Go to **Submit a New Add-on** → choose **On this site** (listed) or **On your own** (unlisted/self-hosted)
3. Upload your `.xpi` file
4. Mozilla will **auto-review** the submission — most extensions are reviewed within a few days
5. Fill in the listing details: name, description, screenshots, category
6. Once approved, your extension gets a public AMO page and can be installed by anyone without disabling signature checks

> **Signing:** AMO automatically signs your `.xpi`. Signed `.xpi` files work in all Firefox builds including stable — no `about:config` changes needed for users.

For automated signing without a full AMO listing, use the [web-ext](https://github.com/mozilla/web-ext) CLI tool:
```bash
npm install -g web-ext
web-ext sign --api-key=... --api-secret=...
```

---

### 📁 Project Structure

```
css-editor/
├── manifest.json
├── popup/
│   ├── index.html      # Extension UI
│   └── popup.js        # Editor, presets & sites logic
├── content/
│   └── injector.js     # Injects CSS into active tab
├── background/
│   └── background.js   # Background service worker
└── icons/
    ├── icon48.png
    └── icon96.png
```
