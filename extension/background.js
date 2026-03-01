// background.js — traice v2
// Responsibilities:
//   1. Inactivity pause/resume (30s idle → pause, any activity → resume)
//   2. Route INGEST_EVENT messages → local storage + Cloudflare KV
//   3. URL/tab navigation tracking
//   4. Persistent user identity generation

const WORKER_URL         = 'https://traice-worker.traice.workers.dev';

// ── User Identity ─────────────────────────────────────────────────────────────
// Generate a persistent userId on first install. Never shown to user.
chrome.runtime.onInstalled.addListener(async () => {
  const { userId } = await chrome.storage.local.get('userId');
  if (!userId) {
    await chrome.storage.local.set({ userId: crypto.randomUUID() });
    console.log('[traice] New user ID generated');
  }
});
const INACTIVITY_PAUSE_MS = 30_000;

let inactivityTimer = null;

// ── Inactivity Pause ──────────────────────────────────────────────────────────
function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(pauseSession, INACTIVITY_PAUSE_MS);
}

async function pauseSession() {
  const { sessionActive } = await chrome.storage.local.get('sessionActive');
  if (!sessionActive) return;
  await chrome.storage.local.set({ sessionPaused: true });
  chrome.action.setBadgeText({ text: '⏸' });
  chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  console.log('[traice] Paused — idle 30s');
}

async function resumeSession() {
  const { sessionActive, sessionPaused } =
    await chrome.storage.local.get(['sessionActive', 'sessionPaused']);
  if (!sessionActive || !sessionPaused) return;
  await chrome.storage.local.set({ sessionPaused: false });
  chrome.action.setBadgeText({ text: '●' });
  chrome.action.setBadgeBackgroundColor({ color: '#a78bfa' });
  resetInactivityTimer();
  console.log('[traice] Resumed');
}


// ── Event Ingestion ───────────────────────────────────────────────────────────
async function ingestEvent(event) {
  const { sessionId } = await chrome.storage.local.get('sessionId');
  if (!sessionId) return;

  // Local storage first — source of truth
  const { events = [] } = await chrome.storage.local.get('events');
  events.push(event);
  await chrome.storage.local.set({ events });

  // Stream to Cloudflare KV (fire and forget)
  fetch(`${WORKER_URL}/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sessionId, event })
  }).catch(() => {});
}


// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'USER_ACTIVITY') {
    chrome.storage.local.get(['sessionActive', 'sessionPaused'], ({ sessionActive, sessionPaused }) => {
      if (!sessionActive) return;
      if (sessionPaused) resumeSession();
      else resetInactivityTimer();
    });
    return;
  }

  if (msg.type === 'INGEST_EVENT') {
    ingestEvent(msg.event)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (msg.type === 'SESSION_START') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#a78bfa' });
    resetInactivityTimer();
  }

  if (msg.type === 'SESSION_END') {
    clearTimeout(inactivityTimer);
    chrome.action.setBadgeText({ text: '' });
  }
});


// ── Tab Navigation Tracking ───────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

  const { sessionActive, sessionPaused } =
    await chrome.storage.local.get(['sessionActive', 'sessionPaused']);
  if (!sessionActive) return;

  if (sessionPaused) await resumeSession();
  else resetInactivityTimer();

  const { events = [] } = await chrome.storage.local.get('events');
  const last = events[events.length - 1];
  if (last?.type === 'navigation' && last?.url === tab.url) return;

  ingestEvent({
    type:      'navigation',
    url:       tab.url,
    title:     tab.title || '',
    timestamp: new Date().toISOString()
  });
});


// ── Tab Focus Tracking ────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { sessionActive } = await chrome.storage.local.get('sessionActive');
  if (!sessionActive) return;

  resetInactivityTimer();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.url.startsWith('chrome://')) return;

  ingestEvent({
    type:      'tab_focus',
    url:       tab.url,
    title:     tab.title || '',
    timestamp: new Date().toISOString()
  });
});
