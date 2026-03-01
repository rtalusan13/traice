// popup.js — traice v2
// Handles: session start/end, screenshot paste/drop → Cloudflare R2, UI state,
// result persistence, past sessions, next action buttons, profile avatar,
// continue surfing flow

const WORKER_URL  = 'https://traice-worker.traice.workers.dev';
const BACKEND_URL = 'https://traice-backend-26c625a8-69ccf09a.aedify.ai';

const startBtn          = document.getElementById('startBtn');
const endBtn            = document.getElementById('endBtn');
const resumeBtn         = document.getElementById('resumeBtn');
const pill              = document.getElementById('pill');
const pillText          = document.getElementById('pillText');
const statsEl           = document.getElementById('stats');
const screenshotZone    = document.getElementById('screenshotZone');
const thumbsEl          = document.getElementById('thumbs');
const spinner           = document.getElementById('spinner');
const outputEl          = document.getElementById('output');
const csvDownloadBtn    = document.getElementById('csvDownloadBtn');
const actionBtnsEl      = document.getElementById('actionBtns');
const actionResponseEl  = document.getElementById('actionResponse');
const pastSessionsBtn   = document.getElementById('pastSessionsBtn');
const pastSessionsPanel = document.getElementById('pastSessionsPanel');
const pastSessionsList  = document.getElementById('pastSessionsList');
const backFromSessions  = document.getElementById('backFromSessions');
const filePickerInput   = document.getElementById('filePickerInput');
const uploadBtn         = document.getElementById('uploadBtn');

// Track screenshot R2 URLs for this popup session
let screenshotUrls = [];


// ── Session Type Labels ───────────────────────────────────────────────────────
const SESSION_TYPE_LABELS = {
  RESEARCH_ESSAY: 'Research Essay',
  COMPARISON:     'Comparison',
  PLANNING:       'Planning',
  SCIENTIFIC:     'Scientific Research',
  GENERAL:        'General Research'
};


// ── Continue Surfing Prompts ──────────────────────────────────────────────────
const CONTINUE_PROMPTS = {
  PLANNING:       { q: 'Want to keep planning this trip?',    yes: 'Yes, keep surfing →',  no: 'No, I\'m done ✓' },
  RESEARCH_ESSAY: { q: 'Keep researching this topic?',        yes: 'Yes, find more →',     no: 'No, I\'m done ✓' },
  COMPARISON:     { q: 'Still comparing options?',            yes: 'Yes, keep looking →',  no: 'No, ready to decide ✓' },
  SCIENTIFIC:     { q: 'Continue reading papers?',            yes: 'Yes, keep going →',    no: 'No, I\'m done ✓' },
  GENERAL:        { q: 'Want to keep exploring?',             yes: 'Yes, keep surfing →',  no: 'No, I\'m done ✓' }
};


// ── Next Action Definitions ───────────────────────────────────────────────────
function getNextActions(sessionType) {
  const actions = {
    COMPARISON: [
      { icon: '📊', label: 'Download Spreadsheet', action: 'csv' },
      { icon: '📝', label: 'Write Summary', action: 'summary' },
      { icon: '🔍', label: 'Find Missing Data', action: 'gaps' }
    ],
    RESEARCH_ESSAY: [
      { icon: '📄', label: 'Generate Doc Outline', action: 'outline' },
      { icon: '📚', label: 'Find More Sources', action: 'sources' },
      { icon: '✍️', label: 'Draft Introduction', action: 'intro' }
    ],
    PLANNING: [
      { icon: '🗓', label: 'Build Itinerary', action: 'itinerary' },
      { icon: '💰', label: 'Budget Breakdown', action: 'budget' },
      { icon: '✈️', label: 'Find Alternatives', action: 'alternatives' }
    ],
    SCIENTIFIC: [
      { icon: '🔬', label: 'Identify Gaps', action: 'gaps' },
      { icon: '📑', label: 'Literature Review', action: 'litreview' },
      { icon: '📊', label: 'Export Data', action: 'csv' }
    ],
    GENERAL: [
      { icon: '📝', label: 'Summarize Findings', action: 'summary' },
      { icon: '📊', label: 'Download Spreadsheet', action: 'csv' },
      { icon: '🔍', label: 'Dig Deeper', action: 'gaps' }
    ]
  };
  return actions[sessionType] || actions.GENERAL;
}


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
      html.push(`<h3 style="color:#6ab3bb;font-size:13px;font-weight:600;margin:12px 0 4px 0;padding-bottom:4px;border-bottom:1px solid #1e1e1e">${content}</h3>`);
      continue;
    }

    // ### Subheading
    if (/^### /.test(line)) {
      closelist();
      const content = inlineFmt(line.replace(/^### /, ''));
      html.push(`<h4 style="color:rgba(106,179,187,0.8);font-size:12px;font-weight:500;margin:8px 0 3px 0">${content}</h4>`);
      continue;
    }

    // - [ ] checkbox
    if (/^[-*]\s*\[[ x]\]\s+/.test(line)) {
      closelist();
      const checked = /\[x\]/i.test(line);
      const content = inlineFmt(line.replace(/^[-*]\s*\[[ x]\]\s+/, ''));
      html.push(`<div style="display:flex;align-items:center;gap:6px;margin:3px 0"><input type="checkbox" disabled${checked ? ' checked' : ''} style="accent-color:#6ab3bb"><span style="color:#c5c3c3;font-size:11px">${content}</span></div>`);
      continue;
    }

    // - item or * item (non-checkbox bullet)
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html.push('<ul style="list-style:none;padding-left:0;margin:0">'); inList = true; }
      const content = inlineFmt(line.replace(/^[-*]\s+/, ''));
      html.push(`<li style="color:#c5c3c3;font-size:11px;line-height:1.7;margin:2px 0;padding-left:12px;border-left:2px solid #1e3a3e">${content}</li>`);
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
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#6ab3bb">$1</a>');
  return text;
}


// ── CSV Download Helper ───────────────────────────────────────────────────────
function downloadCsv(csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'traice-session.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// Helper to trigger CSV download from stored lastResult
function triggerCSVDownload() {
  chrome.storage.local.get('lastResult', ({ lastResult }) => {
    if (lastResult?.csv) downloadCsv(lastResult.csv);
  });
}


// ── Render Full Result ────────────────────────────────────────────────────────
// Displays: stats → badge → divider → markdown → continue section
// Action buttons, CSV button, and past sessions rendered outside #output
function renderResult(result, stats) {
  const typeLabel = SESSION_TYPE_LABELS[result.sessionType] || 'General Research';

  // Build continue surfing section
  const cp = CONTINUE_PROMPTS[result.sessionType] || CONTINUE_PROMPTS.GENERAL;
  const continueHTML =
    `<div id="continueSection" style="margin-top:16px;text-align:center">` +
      `<div style="color:#666;font-size:11px">${cp.q}</div>` +
      `<div style="display:flex;gap:8px;margin-top:8px">` +
        `<button id="continueYes" style="background:#0a1a1c;border:1px solid #6ab3bb;color:#6ab3bb;font-size:11px;padding:6px 12px;border-radius:6px;flex:1;cursor:pointer">${cp.yes}</button>` +
        `<button id="continueNo" style="background:#111111;border:1px solid #1e1e1e;color:#555555;font-size:11px;padding:6px 12px;border-radius:6px;flex:1;cursor:pointer">${cp.no}</button>` +
      `</div>` +
    `</div>`;

  // Order: stats line → session type badge → divider → rendered markdown → continue section
  outputEl.innerHTML =
    `<div style="color:#555;font-size:10px;margin-bottom:10px">${stats.highlights} highlights · ${stats.pages} pages · ${stats.scrapes} scrapes · ${stats.images} images</div>` +
    `<span style="background:#0a1a1c;color:#6ab3bb;font-size:10px;padding:3px 10px;border-radius:999px;border:1px solid #1e3a3e;display:inline-block;margin-bottom:10px;font-weight:500">✦ ${typeLabel}</span>` +
    `<div style="height:1px;background:#1e1e1e;margin-bottom:10px"></div>` +
    renderMarkdown(result.markdown) +
    continueHTML;

  outputEl.style.display = 'block';

  // Action buttons — rendered with data-action attributes for event delegation
  const actions = getNextActions(result.sessionType);
  actionBtnsEl.innerHTML = actions.map(a =>
    `<button class="action-btn" data-action="${a.action}">` +
    `<span class="action-icon">${a.icon}</span>${a.label}</button>`
  ).join('');
  actionBtnsEl.style.display = 'flex';

  // CSV download button
  if (result.csv) {
    csvDownloadBtn.style.display = 'block';
    csvDownloadBtn.onclick = () => downloadCsv(result.csv);
  } else {
    csvDownloadBtn.style.display = 'none';
  }

  // Past sessions button
  pastSessionsBtn.style.display = 'block';

  // Reset action response area
  actionResponseEl.style.display = 'none';
  actionResponseEl.innerHTML = '';
}


// ── Event Delegation: Action Buttons ──────────────────────────────────────────
// Single stable listener on #actionBtns — handles dynamically created buttons
actionBtnsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  // CSV download handled locally
  if (action === 'csv') {
    triggerCSVDownload();
    return;
  }

  // Fetch stored result for context
  const stored = await new Promise(r => chrome.storage.local.get('lastResult', r));
  const result = stored.lastResult;
  if (!result) return;

  const origHTML = btn.innerHTML;
  btn.innerHTML = `<span class="action-icon">⏳</span>thinking…`;
  btn.disabled = true;

  try {
    const resp = await fetch(`${BACKEND_URL}/action`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        sessionType: result.sessionType,
        markdown:    result.markdown,
        csv:         result.csv
      })
    });
    const data = await resp.json();
    if (data.ok && data.result) {
      actionResponseEl.style.display = 'block';
      actionResponseEl.innerHTML =
        `<div style="color:rgba(106,179,187,0.6);font-size:10px;margin-bottom:8px">✦ traice suggests</div>` +
        `<div style="height:1px;background:#1e1e1e;margin-bottom:8px"></div>` +
        renderMarkdown(data.result);
    }
  } catch (err) {
    console.error('[traice] Action failed:', err);
    btn.innerHTML = `<span class="action-icon">⚠️</span>Error — retry`;
  } finally {
    if (btn.innerHTML.includes('thinking')) {
      btn.innerHTML = origHTML;
    }
    btn.disabled = false;
  }
});


// ── Event Delegation: Continue Surfing Buttons ────────────────────────────────
// These are inside #output, so use delegation on outputEl
outputEl.addEventListener('click', async (e) => {
  // "Yes" — continue surfing
  if (e.target.id === 'continueYes') {
    const stored = await new Promise(r => chrome.storage.local.get('lastResult', r));
    const sessionType = stored.lastResult?.sessionType || 'GENERAL';
    await chrome.storage.local.set({
      continuingSurf: true,
      continueSessionType: sessionType
    });
    window.close();
    return;
  }

  // "No" — done
  if (e.target.id === 'continueNo') {
    const section = document.getElementById('continueSection');
    if (section) {
      section.innerHTML = '<div style="color:#555;font-size:11px;text-align:center;margin-top:8px">✓ Session complete</div>';
    }
    return;
  }
});


// ── Profile Avatar ────────────────────────────────────────────────────────────
async function loadProfileAvatar() {
  const avatarEl = document.getElementById('profileAvatar');
  if (!avatarEl) return;
  try {
    const profile = await new Promise((resolve, reject) => {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(info);
      });
    });
    if (profile?.email) {
      const initial = profile.email.charAt(0).toUpperCase();
      if (profile.id) {
        const img = document.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        img.onerror = () => {
          avatarEl.innerHTML = '';
          avatarEl.style.background = '#0a1a1c';
          avatarEl.style.color = '#6ab3bb';
          avatarEl.style.fontSize = '13px';
          avatarEl.style.fontWeight = '600';
          avatarEl.textContent = initial;
        };
        img.onload = () => {
          avatarEl.innerHTML = '';
          avatarEl.appendChild(img);
          avatarEl.style.border = '1.5px solid #6ab3bb';
        };
        img.src = `https://lh3.googleusercontent.com/a/${profile.id}`;
        avatarEl.innerHTML = '';
        avatarEl.appendChild(img);
      } else {
        avatarEl.textContent = initial;
        avatarEl.style.background = '#0a1a1c';
        avatarEl.style.color = '#6ab3bb';
        avatarEl.style.fontWeight = '600';
      }
      avatarEl.title = profile.email;
    } else {
      avatarEl.textContent = '○';
      avatarEl.style.color = '#444';
      avatarEl.title = 'Not signed into Chrome';
    }
  } catch (err) {
    console.log('[traice] Could not load profile:', err.message);
  }
}


// ── UI State Helpers ──────────────────────────────────────────────────────────
function setUI(state) {
  // state: 'idle' | 'active' | 'paused'
  startBtn.style.display  = state === 'idle'   ? 'block' : 'none';
  endBtn.style.display    = state !== 'idle'   ? 'block' : 'none';
  resumeBtn.style.display = state === 'paused' ? 'block' : 'none';
  screenshotZone.style.display = state !== 'idle' ? 'block' : 'none';
  uploadBtn.style.display      = state !== 'idle' ? 'block' : 'none';

  // Zone pulse animation only when active
  if (state === 'active') {
    screenshotZone.classList.add('session-active');
  } else {
    screenshotZone.classList.remove('session-active');
  }

  pill.className = `pill ${state}`;
  pillText.textContent = state === 'idle' ? 'Idle'
    : state === 'paused' ? '⏸ Paused — move mouse to resume'
    : 'Recording…';
}


// ── Restore state on popup open ───────────────────────────────────────────────
chrome.storage.local.get(
  ['sessionActive', 'sessionPaused', 'events', 'screenshots', 'lastResult'],
  (data) => {
    if (data.sessionActive) {
      setUI(data.sessionPaused ? 'paused' : 'active');
      updateStats(data.events || []);
      // Restore thumbnails from stored URLs
      (data.screenshots || []).forEach(s => addThumb(s, false));
      screenshotUrls = (data.screenshots || []).map(s => s.r2Url);
    } else {
      setUI('idle');
      // Restore last result if session is not active and result exists
      if (data.lastResult) {
        renderResult(data.lastResult, data.lastResult.stats);
      }
    }
  }
);

// Load profile avatar on popup open
loadProfileAvatar();


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
  // Clear previous result so it doesn't bleed into new session
  chrome.storage.local.remove('lastResult');
  chrome.runtime.sendMessage({ type: 'SESSION_START' });
  screenshotUrls = [];
  thumbsEl.innerHTML = '';
  // Reset all output areas
  outputEl.style.display = 'none';
  outputEl.innerHTML = '';
  actionBtnsEl.style.display = 'none';
  actionBtnsEl.innerHTML = '';
  actionResponseEl.style.display = 'none';
  actionResponseEl.innerHTML = '';
  csvDownloadBtn.style.display = 'none';
  pastSessionsBtn.style.display = 'none';
  pastSessionsPanel.style.display = 'none';
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
  actionBtnsEl.style.display = 'none';
  actionResponseEl.style.display = 'none';
  csvDownloadBtn.style.display = 'none';

  const data = await chrome.storage.local.get([
    'events', 'sessionId', 'screenshots', 'userId',
    'continuingSurf', 'continueSessionType'
  ]);

  const payload = {
    sessionId:        data.sessionId || 'unknown',
    timestamp:        new Date().toISOString(),
    events:           data.events || [],
    screenshots:      data.screenshots || [],
    userId:           data.userId || 'anonymous',
    continuingSurf:   data.continuingSurf || false,
    continueSessionType: data.continueSessionType || null
  };

  // Clear continuation flag after reading it
  chrome.storage.local.remove(['continuingSurf', 'continueSessionType']);

  try {
    const resp = await fetch(`${WORKER_URL}/end-session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const result = await resp.json();
    spinner.style.display = 'none';

    if (result.csv || result.markdown) {
      const evts = payload.events;
      const resultStats = {
        highlights: evts.filter(e => e.type === 'highlight').length,
        pages:      new Set(evts.filter(e => e.url).map(e => e.url)).size,
        scrapes:    evts.filter(e => e.type === 'dwell_scrape').length,
        images:     (data.screenshots || []).length
      };

      // Persist result for popup reopen
      const storedResult = {
        sessionType:   result.sessionType,
        csv:           result.csv,
        markdown:      result.markdown,
        synthesizedAt: result.synthesizedAt,
        stats:         resultStats
      };
      chrome.storage.local.set({ lastResult: storedResult });

      renderResult(storedResult, resultStats);
    } else {
      outputEl.style.display = 'block';
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


// ── Past Sessions ─────────────────────────────────────────────────────────────
pastSessionsBtn.addEventListener('click', async () => {
  pastSessionsBtn.textContent = 'Loading sessions…';
  pastSessionsBtn.disabled = true;

  try {
    const { userId } = await chrome.storage.local.get('userId');
    console.log('[traice] Fetching sessions for userId:', userId);

    if (!userId) {
      pastSessionsList.innerHTML = '<p style="color:#555;font-size:11px;text-align:center;padding:16px 0">No user ID found. Complete a session first.</p>';
      pastSessionsPanel.style.display = 'block';
      pastSessionsBtn.style.display = 'none';
      return;
    }

    const resp = await fetch(`${BACKEND_URL}/sessions?userId=${encodeURIComponent(userId)}`);
    const data = await resp.json();
    console.log('[traice] Sessions response:', data);
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      pastSessionsList.innerHTML = '<p style="color:#555;font-size:11px;text-align:center;padding:16px 0">No sessions found. Complete a session first.</p>';
    } else {
      pastSessionsList.innerHTML = sessions.map((s, idx) => {
        const date = new Date(s.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const time = new Date(s.recordedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const typeLabel = SESSION_TYPE_LABELS[s.sessionType] || 'General Research';
        const preview = (s.summary || '').replace(/[#*\[\]\-_]/g, '').slice(0, 80);

        return `<div class="session-card" data-idx="${idx}">` +
          `<span style="background:#0a1a1c;color:#6ab3bb;font-size:9px;padding:2px 8px;border-radius:999px;border:1px solid #1e3a3e;font-weight:500">✦ ${typeLabel}</span>` +
          `<div class="session-date">${date} · ${time}</div>` +
          `<div class="session-preview">${preview}${preview.length >= 80 ? '…' : ''}</div>` +
          `<div class="session-expanded" style="display:none">${renderMarkdown(s.fullMarkdown || '')}</div>` +
          `</div>`;
      }).join('');

      // Toggle expand on click
      pastSessionsList.querySelectorAll('.session-card').forEach(card => {
        card.addEventListener('click', () => {
          const expanded = card.querySelector('.session-expanded');
          const isOpen = expanded.style.display !== 'none';
          // Close all others first
          pastSessionsList.querySelectorAll('.session-expanded').forEach(e => e.style.display = 'none');
          expanded.style.display = isOpen ? 'none' : 'block';
        });
      });
    }

    pastSessionsPanel.style.display = 'block';
    pastSessionsBtn.style.display = 'none';
  } catch (err) {
    console.error('[traice] Failed to load sessions:', err);
    pastSessionsList.innerHTML = '<p style="color:#555;font-size:11px;text-align:center;padding:16px 0">Failed to load sessions. Check your connection.</p>';
    pastSessionsPanel.style.display = 'block';
    pastSessionsBtn.style.display = 'none';
  } finally {
    pastSessionsBtn.textContent = '📋 Past Sessions';
    pastSessionsBtn.disabled = false;
  }
});

backFromSessions.addEventListener('click', () => {
  pastSessionsPanel.style.display = 'none';
  pastSessionsBtn.style.display = 'block';
});


// ── Screenshot Handling ───────────────────────────────────────────────────────
// Accepts: paste (Ctrl+V / Cmd+V), drag-and-drop, or file picker
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

// Paste handler — check for image first, then preventDefault
document.addEventListener('paste', async (e) => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();

  const { sessionActive } = await chrome.storage.local.get('sessionActive');
  if (!sessionActive) return;

  handleImageFile(item.getAsFile());
});

// File picker
uploadBtn.addEventListener('click', () => filePickerInput.click());
filePickerInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file?.type.startsWith('image/')) handleImageFile(file);
  filePickerInput.value = ''; // reset so same file can be re-selected
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
