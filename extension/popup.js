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
      outputEl.innerHTML = `
        ✅ Session synthesized!<br>
        ${result.csvUrl ? `<a href="${result.csvUrl}" target="_blank">⬇ Download CSV</a><br>` : ''}
        <pre style="margin-top:8px;white-space:pre-wrap;color:#ccc;font-size:10px">
${(result.markdown || '').slice(0, 400)}…</pre>`;
    } else {
      outputEl.textContent = result.error || '⚠️ No output returned.';
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
