async function init() {
  const status = document.getElementById('status');
  const closeBtn = document.getElementById('close-btn');
  const subtitle = document.getElementById('subtitle');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  // Determine mode
  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode') || 'link';

  if (mode === 'file') {
    // FILE IMPORT MODE
    subtitle.textContent = 'Upload a .json file with your presets';
    dropZone.style.display = 'flex';

    const processFile = async (file) => {
      if (!file || !file.name.endsWith('.json')) {
        status.innerHTML = '<span class="error">❌ Only .json files are supported</span>';
        return;
      }

      try {
        status.innerHTML = '⏳ Processing...';
        const text = await file.text();
        const presets = JSON.parse(text);

        if (!Array.isArray(presets)) {
          status.innerHTML = '<span class="error">❌ Invalid file format</span>';
          return;
        }

        // Send to background
        const response = await browser.runtime.sendMessage({
          type: 'IMPORT_FROM_FILE',
          presets: presets
        });

        if (response && response.success) {
          status.innerHTML = `<span class="success">✓ Imported <strong>${response.count}</strong> preset${response.count === 1 ? '' : 's'}</span>`;
          closeBtn.style.display = 'inline-block';
          closeBtn.addEventListener('click', () => window.close());
        } else {
          status.innerHTML = '<span class="error">❌ Import failed</span>';
        }
      } catch (err) {
        console.error('File import error:', err);
        status.innerHTML = '<span class="error">❌ Failed to process file</span>';
      }
    };

    // File input change
    fileInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (file) await processFile(file);
    });

    // Drag & drop
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) await processFile(file);
    });

    return;
  }

  // LINK IMPORT MODE (default)
  subtitle.textContent = 'Import from link';

  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const b64 = params.get('data') || params.get('import');

    if (!b64) {
      status.innerHTML = '<span class="error">❌ No import data found</span>';
      return;
    }

    let data;
    try {
      const decoded = decodeURIComponent(escape(atob(b64)));
      data = JSON.parse(decoded);
    } catch (e) {
      status.innerHTML = '<span class="error">❌ Invalid link data</span>';
      return;
    }

    if (!data.name || !data.css) {
      status.innerHTML = '<span class="error">❌ Invalid preset format</span>';
      return;
    }

    const response = await browser.runtime.sendMessage({
      type: 'IMPORT_PRESET',
      preset: {
        name: data.name,
        css: data.css,
        domain: data.domain || 'localhost'
      }
    });

    if (response && response.success) {
      status.innerHTML = `<span class="success">✓ Preset "<strong>${data.name}</strong>" imported!</span>`;
      closeBtn.style.display = 'inline-block';
      closeBtn.textContent = 'Close tab';
      closeBtn.addEventListener('click', () => window.close());
    } else {
      status.innerHTML = '<span class="error">❌ Failed to save preset</span>';
    }
  } catch (err) {
    console.error('Import error:', err);
    status.innerHTML = '<span class="error">❌ Unexpected error</span>';
  }
}

init();
