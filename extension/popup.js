// popup.js — traice v2
// Handles: session start/end, screenshot paste/drop → Cloudflare R2, UI state

const WORKER_URL = 'https://traice-worker.traice.workers.dev';

const startBtn        = document.getElementById('startBtn');
const endBtn          = document.getElementById('endBtn');
const resumeBtn       = document.getElementById('resumeBtn');
const pill            = document.getElementById('pill');
const pillText        = document.getElementById('pillText');
const statsEl         = document.getElementById('stats');
const screenshotZone  = document.getElementById('screenshotZone');
const thumbsEl        = document.getElementById('thumbs');
const spinner         = document.getElementById('spinner');
const outputEl        = document.getElementById('output');
const csvDownloadBtn  = document.getElementById('csvDownloadBtn');

// ── Session Type Labels ───────────────────────────────────────────────────────
const SESSION_TYPE_LABELS = {
  RESEARCH_ESSAY: 'Research Essay',
  COMPARISON:     'Comparison',
  PLANNING:       'Planning',
  SCIENTIFIC:     'Scientific Research',
  GENERAL:        'General Research'
};

// ── Markdown → HTML Renderer ──────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const html = [];
  let inList = false;

  function closelist() {
    if (inList) { html.push('</ul>'); inList = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Empty line
    if (line.trim() === '') {
      closelist();
      html.push('<div style="height:6px"></div>');
      continue;
    }

    // ## Heading
    if (/^## /.test(line)) {
      closelist();
      const content = inlineFmt(line.replace(/^## /, ''));
      html.push(`<h3 style="color:#a78bfa;font-size:13px;font-weight:600;margin:12px 0 4px 0;padding-bottom:4px;border-bottom:1px solid #222">${content}</h3>`);
      continue;
    }

    // ### Subheading
    if (/^### /.test(line)) {
      closelist();
      const content = inlineFmt(line.replace(/^### /, ''));
      html.push(`<h4 style="color:#c4b5fd;font-size:12px;font-weight:500;margin:8px 0 3px 0">${content}</h4>`);
      continue;
    }

    // - [ ] checkbox
    if (/^[-*]\s*\[[ x]\]\s+/.test(line)) {
      closelist();
      const checked = /\[x\]/i.test(line);
      const content = inlineFmt(line.replace(/^[-*]\s*\[[ x]\]\s+/, ''));
      html.push(`<div style="display:flex;align-items:center;gap:6px;margin:3px 0"><input type="checkbox" disabled${checked ? ' checked' : ''} style="accent-color:#a78bfa"><span style="color:#ccc;font-size:11px">${content}</span></div>`);
      continue;
    }

    // - item or * item (non-checkbox bullet)
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html.push('<ul style="list-style:none;padding-left:0;margin:0">'); inList = true; }
      const content = inlineFmt(line.replace(/^[-*]\s+/, ''));
      html.push(`<li style="color:#ccc;font-size:11px;line-height:1.7;margin:2px 0;padding-left:12px;border-left:2px solid #2a2a2a">${content}</li>`);
      continue;
    }

    // Plain paragraph
    closelist();
    html.push(`<p style="color:#bbb;font-size:11px;line-height:1.7;margin:6px 0">${inlineFmt(line)}</p>`);
  }

  closelist();
  return html.join('\n');
}

function inlineFmt(text) {
  // Bold **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff">$1</strong>');
  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#a78bfa">$1</a>');
  return text;
}

// Track screenshot R2 URLs for this popup session
// (In-memory only — URLs are also stored in chrome.storage.local under 'screenshots')
let screenshotUrls = [];


// ── UI State Helpers ──────────────────────────────────────────────────────────
function setUI(state) {
  // state: 'idle' | 'active' | 'paused'
  startBtn.style.display  = state === 'idle'   ? 'block' : 'none';
  endBtn.style.display    = state !== 'idle'   ? 'block' : 'none';
  resumeBtn.style.display = state === 'paused' ? 'block' : 'none';
  screenshotZone.style.display = state !== 'idle' ? 'block' : 'none';

  pill.className = `pill ${state}`;
  pillText.textContent = state === 'idle' ? 'Idle'
    : state === 'paused' ? '⏸ Paused — move mouse to resume'
    : 'Recording…';
}


// ── Restore state on popup open ───────────────────────────────────────────────
chrome.storage.local.get(
  ['sessionActive', 'sessionPaused', 'events', 'screenshots'],
  (data) => {
    if (data.sessionActive) {
      setUI(data.sessionPaused ? 'paused' : 'active');
      updateStats(data.events || []);
      // Restore thumbnails from stored URLs
      (data.screenshots || []).forEach(url => addThumb(url, false));
      screenshotUrls = (data.screenshots || []).map(s => s.r2Url);
    } else {
      setUI('idle');
    }
  }
);


// ── Session Controls ──────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => {
  const sessionId = crypto.randomUUID();
  chrome.storage.local.set({
    sessionActive: true,
    sessionPaused: false,
    sessionId,
    events: [],
    screenshots: []
  });
  chrome.runtime.sendMessage({ type: 'SESSION_START' });
  screenshotUrls = [];
  thumbsEl.innerHTML = '';
  setUI('active');
  statsEl.textContent = '0 events captured';
});

resumeBtn.addEventListener('click', () => {
  chrome.storage.local.set({ sessionPaused: false });
  chrome.runtime.sendMessage({ type: 'USER_ACTIVITY' });
  setUI('active');
});

endBtn.addEventListener('click', async () => {
  chrome.storage.local.set({ sessionActive: false, sessionPaused: false });
  chrome.runtime.sendMessage({ type: 'SESSION_END' });
  setUI('idle');
  endBtn.disabled = true;
  spinner.style.display = 'block';
  outputEl.style.display = 'none';

  const data = await chrome.storage.local.get(['events', 'sessionId', 'screenshots']);

  const payload = {
    sessionId:   data.sessionId || 'unknown',
    timestamp:   new Date().toISOString(),
    events:      data.events || [],
    screenshots: data.screenshots || []   // array of { r2Url, timestamp, caption }
  };

  try {
    const resp = await fetch(`${WORKER_URL}/end-session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const result = await resp.json();
    spinner.style.display = 'none';
    outputEl.style.display = 'block';

    if (result.csv || result.markdown) {
      const typeLabel = SESSION_TYPE_LABELS[result.sessionType] || 'General Research';
      const evts = payload.events;
      const hCount = evts.filter(e => e.type === 'highlight').length;
      const pCount = evts.filter(e => e.type === 'navigation').length;
      const dCount = evts.filter(e => e.type === 'dwell_scrape').length;
      const sCount = evts.filter(e => e.type === 'screenshot').length;

      outputEl.innerHTML =
        `<span style="background:#1a1a2e;color:#a78bfa;font-size:10px;padding:3px 10px;border-radius:999px;display:inline-block;margin-bottom:10px">✦ ${typeLabel}</span>` +
        `<div style="color:#555;font-size:10px;margin-bottom:10px">${hCount} highlights · ${pCount} pages · ${dCount} scrapes · ${sCount} images</div>` +
        `<div style="height:1px;background:#1e1e1e;margin-bottom:10px"></div>` +
        renderMarkdown(result.markdown);

      // CSV download
      if (result.csv) {
        csvDownloadBtn.style.display = 'block';
        csvDownloadBtn.onclick = () => {
          const blob = new Blob([result.csv], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'traice-session.csv';
          a.click();
          URL.revokeObjectURL(url);
        };
      } else {
        csvDownloadBtn.style.display = 'none';
      }
    } else {
      outputEl.textContent = result.error || '⚠️ No output returned.';
      csvDownloadBtn.style.display = 'none';
    }
  } catch (err) {
    spinner.style.display = 'none';
    outputEl.style.display = 'block';
    outputEl.textContent = `❌ ${err.message}`;
  } finally {
    endBtn.disabled = false;
  }
});


// ── Screenshot Handling ───────────────────────────────────────────────────────
// Accepts: paste (Ctrl+V / Cmd+V) or drag-and-drop onto the zone
// Flow: image blob → POST /upload-screenshot on Worker → R2 → get back public URL
//       → store URL in chrome.storage.local → show thumbnail

const MAX_SCREENSHOTS = 10;

async function handleImageFile(file) {
  const { screenshots = [] } = await chrome.storage.local.get('screenshots');
  if (screenshots.length >= MAX_SCREENSHOTS) {
    alert(`Max ${MAX_SCREENSHOTS} screenshots per session.`);
    return;
  }

  const { sessionId } = await chrome.storage.local.get('sessionId');
  if (!sessionId) return;

  // Show optimistic thumbnail while uploading
  const localUrl = URL.createObjectURL(file);
  const thumbId  = `thumb-${Date.now()}`;
  addThumb({ localUrl, r2Url: null }, true, thumbId);

  try {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('sessionId', sessionId);
    formData.append('timestamp', new Date().toISOString());

    const resp = await fetch(`${WORKER_URL}/upload-screenshot`, {
      method: 'POST',
      body:   formData
    });

    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const { r2Url } = await resp.json();

    // Replace optimistic thumb with confirmed URL
    const thumbEl = document.getElementById(thumbId);
    if (thumbEl) thumbEl.classList.remove('uploading');

    const screenshotRecord = {
      r2Url,
      timestamp: new Date().toISOString()
    };

    const updated = [...screenshots, screenshotRecord];
    await chrome.storage.local.set({ screenshots: updated });
    screenshotUrls.push(r2Url);

    // Also ingest as an event so it appears in the timeline
    chrome.runtime.sendMessage({
      type: 'INGEST_EVENT',
      event: {
        type:      'screenshot',
        r2Url,
        timestamp: screenshotRecord.timestamp
      }
    }).catch(() => {});

  } catch (err) {
    console.error('[traice] Screenshot upload failed:', err);
    document.getElementById(thumbId)?.remove();
    alert(`Screenshot upload failed: ${err.message}`);
  }
}

function addThumb(screenshot, uploading = false, id = null) {
  const div = document.createElement('div');
  div.className = `thumb${uploading ? ' uploading' : ''}`;
  if (id) div.id = id;

  const img = document.createElement('img');
  img.src = screenshot.localUrl || screenshot.r2Url;

  const rm = document.createElement('span');
  rm.className = 'remove';
  rm.textContent = '✕';
  rm.addEventListener('click', async () => {
    div.remove();
    const { screenshots = [] } = await chrome.storage.local.get('screenshots');
    await chrome.storage.local.set({
      screenshots: screenshots.filter(s => s.r2Url !== screenshot.r2Url)
    });
  });

  div.appendChild(img);
  div.appendChild(rm);
  thumbsEl.appendChild(div);
}

// Paste handler
document.addEventListener('paste', async (e) => {
  const { sessionActive } = await chrome.storage.local.get('sessionActive');
  if (!sessionActive) return;

  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!item) return;
  handleImageFile(item.getAsFile());
});

// Drag and drop
screenshotZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  screenshotZone.classList.add('drag-over');
});
screenshotZone.addEventListener('dragleave', () => {
  screenshotZone.classList.remove('drag-over');
});
screenshotZone.addEventListener('drop', (e) => {
  e.preventDefault();
  screenshotZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type.startsWith('image/')) handleImageFile(file);
});


// ── Stats Refresh ─────────────────────────────────────────────────────────────
function updateStats(events) {
  const highlights   = events.filter(e => e.type === 'highlight').length;
  const navigations  = events.filter(e => e.type === 'navigation').length;
  const dwells       = events.filter(e => e.type === 'dwell_scrape').length;
  const screenshots  = events.filter(e => e.type === 'screenshot').length;
  statsEl.textContent =
    `${highlights} highlights · ${navigations} pages · ${dwells} scrapes · ${screenshots} images`;
}

setInterval(async () => {
  const { sessionActive, sessionPaused, events } =
    await chrome.storage.local.get(['sessionActive', 'sessionPaused', 'events']);
  if (!sessionActive) return;
  setUI(sessionPaused ? 'paused' : 'active');
  updateStats(events || []);
}, 1500);
