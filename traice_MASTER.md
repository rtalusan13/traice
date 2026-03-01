# traice — Complete Copilot Master File
### Architecture + Full Code Scaffold — paste this entire file into Copilot Chat before starting

---

# PART 1 — ARCHITECTURE CONTEXT & COPILOT INSTRUCTIONS
### Read this fully before writing or modifying any code

---

## What This Product Is

traice is a Chrome Extension (Manifest V3) that captures a user's web research behavior
during a session — text highlights, page navigations, time spent lingering on pages, and
manually pasted screenshots — and at the end of the session sends everything to an AI
backend that synthesizes it into two structured outputs: a CSV decision matrix and a
markdown action checklist.

The core thesis: what a person *does* while browsing is a stronger signal of intent than
any single page they read. traice captures that behavioral trace and crystallizes it.

---

## Folder Structure

```
traice/
├── extension/               ← Chrome Extension (runs in the browser)
│   ├── manifest.json
│   ├── popup.html           ← Extension UI (start/end session, paste screenshots)
│   ├── popup.js
│   ├── content.js           ← Injected into every webpage
│   └── background.js        ← Service worker (always running)
│
├── cloudflare-worker/       ← Edge API (Cloudflare Worker)
│   ├── index.js
│   └── wrangler.toml
│
└── aedify-backend/          ← AI synthesis server (deployed on Aedify)
    ├── index.js
    ├── package.json
    └── aedify.json
```

---

## Technology Stack and What Each One Does

### 1. Chrome Extension
Three JS contexts that cannot share memory directly — they communicate only via
`chrome.runtime.sendMessage` and `chrome.storage.local`.

- `content.js` — injected into every webpage. Captures text highlights via `mouseup` +
  `window.getSelection()`. Runs a 15-second dwell timer on every page load; if the user
  is still on the page at 15s it scrapes visible text and price patterns from the DOM,
  then re-polls at 20s to catch lazy-loaded content (React SPAs, flight prices, etc.).
  Sends activity heartbeats to background.js for the inactivity pause system.

- `background.js` — the service worker. Tracks URL navigations via `chrome.tabs.onUpdated`
  and tab switches via `chrome.tabs.onActivated`. Manages the inactivity pause system:
  30 seconds of no mouse/keyboard/scroll activity pauses the session; any activity
  resumes it. Routes all events to Cloudflare KV via fetch. Never auto-ends a session —
  only pauses. Data is never lost.

- `popup.html/js` — the UI. Start Session button, End Session button, pause state
  indicator, live event counter, and a screenshot drop zone that accepts Ctrl+V paste
  or drag-and-drop. Shows amber "Paused" state when inactivity pause triggers.

### 2. Cloudflare Worker (`cloudflare-worker/index.js`)
The extension NEVER talks directly to Aedify or Supermemory. Everything goes through
the Worker. Three routes:

- `POST /ingest` — receives individual events during the session, appends to KV keyed
  by sessionId, 2-hour TTL. This is a temporary buffer, not a database.

- `POST /upload-screenshot` — receives image file from extension popup, writes to R2
  object storage, returns a public URL. Extension stores only the URL, never raw base64.
  This keeps chrome.storage.local from hitting its ~5MB quota.

- `POST /end-session` — merges edge KV events with locally-stored extension events
  (deduped by composite key: timestamp + type + first 40 chars of content), forwards
  unified payload to Aedify, then DELETES the KV entry. KV is always clean after synthesis.

Cloudflare services used:
- Workers (edge compute — low latency API for the extension)
- KV (temporary session buffer)
- R2 (screenshot object storage)

### 3. Aedify Backend (`aedify-backend/index.js`)
A Node.js/Express server deployed on Aedify's cloud platform. Aedify is a deployment
platform (like a simplified Heroku/Railway) — it hosts and runs this server. It is NOT
an AI service itself.

This server does the actual AI work:
- Receives the full session payload from the Cloudflare Worker
- Formats all events into a structured narrative (highlights, navigations, dwell scrapes
  with extracted prices, tab focus events, screenshot R2 URLs)
- Sends to GPT-4o-mini with a carefully structured prompt that requests exactly two
  fenced code blocks: a CSV decision matrix and a markdown checklist
- Parses output with regex to extract CSV and markdown reliably
- Pushes the complete session object to Supermemory asynchronously (non-blocking)
- Returns CSV + markdown to the Worker which returns it to the extension popup

Environment variables set in Aedify console (NOT in .env file on disk):
- OPENAI_API_KEY
- SUPERMEMORY_API_KEY

### 4. Supermemory
Long-term semantic storage. After every session is synthesized, the backend pushes the
complete session — URLs visited, highlights, screenshot URLs, generated CSV, markdown
summary — to Supermemory via their v3 REST API. Each session is a separate memory object
tagged with sessionId, highlight count, dwell count, screenshot count, and timestamp.

This makes traice compounding: weeks later a user can query "what flights was I comparing
last Tuesday" and retrieve the exact synthesized context. Without Supermemory every
session is disposable. With it the product builds a personal research knowledge graph.

Integration is a plain fetch POST to `https://api.supermemory.ai/v3/memories`.
No SDK required.

---

## Data Flow (end to end)

```
User highlights text
        ↓
content.js captures event
        ↓
background.js receives via sendMessage
        ↓
Stored in chrome.storage.local (source of truth)
        +
Streamed to Cloudflare Worker /ingest → KV (safety net)
        ↓
[session continues... navigations, dwells, tab switches, pasted screenshots → R2]
        ↓
User clicks "End Session"
        ↓
popup.js POSTs to Cloudflare Worker /end-session
        ↓
Worker merges local + KV events, dedupes, forwards to Aedify
        ↓
Aedify backend calls GPT-4o-mini → CSV + Markdown
        ↓
Aedify pushes to Supermemory (async, non-blocking)
        ↓
Result returned → Worker → popup.js → displayed to user
        ↓
KV entry deleted (KV is now clean)
```

---

## Storage Budget (important — this will not blow up)

Per session (5-10 min demo):
- KV: ~200KB text events (deleted after synthesis)
- R2: ~1.5-3MB images (5-10 screenshots × ~300KB each)
- Supermemory: ~50KB final synthesized object

For 6 sessions running at different times:
- Peak KV: ~200KB (only one session active at a time, each deleted after)
- R2 total: ~18MB (well within 10GB free tier)
- Supermemory total: ~300KB (6 objects)

What we explicitly DO NOT capture (would blow up storage):
- Scroll events (fire hundreds of times per minute)
- Auto-screenshots on every highlight (300KB × every highlight = hundreds of MB)
- Full DOM snapshots
- Mousemove coordinates

---

## Signals We Capture and Why

| Signal | Trigger | Why it matters |
|---|---|---|
| Text highlight | mouseup + selection ≥ 5 chars | Explicit intent marker |
| URL navigation | tab load complete | Research path |
| Dwell scrape | 15s on same page + repoll at 20s | Passive interest, catches prices |
| Tab focus | tab switch | Shows what user returns to |
| Pasted screenshot | Ctrl+V or drop in popup | Highest-signal manual annotation |

---

## Inactivity Pause System

30 seconds of zero activity (no mousemove, keydown, scroll, click on any tab) triggers
a PAUSE state. The extension badge turns amber. The popup shows "Paused — move mouse
to resume." Any activity (including tab switch or navigation) auto-resumes the session.

There is NO auto-end. A user who walks away for 10 minutes and comes back resumes
exactly where they left off. Zero data is ever lost due to inactivity.

---

## Screenshot Flow

User takes OS screenshot (Cmd+Shift+4, Snipping Tool, etc.)
→ OS puts it in clipboard
→ User clicks the extension popup (it stays open)
→ User presses Ctrl+V (or drags the saved file into the drop zone)
→ popup.js reads the image from clipboard via ClipboardEvent
→ Uploads to Cloudflare Worker /upload-screenshot as multipart FormData
→ Worker writes to R2, returns public URL
→ Extension stores URL in chrome.storage.local (not the raw image)
→ Thumbnail appears in popup confirming capture
→ At session end, all R2 URLs are included in the Aedify synthesis payload

Note: Chrome Extensions cannot detect when the user presses OS screenshot shortcuts.
The paste flow is intentional — it requires the user to consciously decide a screenshot
is worth capturing, which makes it a higher-quality signal than auto-capture.

---

## Placeholder Values to Replace Before Running

These strings appear in the code and must be replaced with real values after setup:

1. `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev`
   → Replace with your actual Cloudflare Worker URL after `wrangler deploy`
   → Appears in: content.js, background.js, popup.js, cloudflare-worker/index.js

2. `https://YOUR_R2_PUBLIC_URL`
   → Replace with your R2 bucket public domain from Cloudflare dashboard
   → Appears in: cloudflare-worker/index.js

3. `https://YOUR_AEDIFY_APP_URL/synthesize`
   → Replace with your deployed Aedify backend URL after deploying via VS Code extension
   → Appears in: cloudflare-worker/index.js

4. KV Namespace ID in wrangler.toml
   → Replace `YOUR_KV_NAMESPACE_ID` with the ID returned by `wrangler kv:namespace create SESSION_STORE`

---

## Setup Order (do not skip steps or do them out of order)

### Step 1 — Cloudflare (~20 minutes)
```bash
npm install -g wrangler
wrangler login

# Create KV namespace — copy the ID it returns into wrangler.toml
wrangler kv:namespace create SESSION_STORE

# Create R2 bucket
wrangler r2 bucket create traice-screenshots

# Deploy the Worker (do this AFTER pasting your KV namespace ID into wrangler.toml)
cd cloudflare-worker
wrangler deploy
```
Then in the Cloudflare dashboard:
- Go to R2 → traice-screenshots → Settings → Public Access → Enable
- Copy the public bucket URL (looks like `https://pub-xxxx.r2.dev`) → paste into
  `cloudflare-worker/index.js` where it says `YOUR_R2_PUBLIC_URL`

After deploy, Wrangler prints your Worker URL. Paste it everywhere that says
`YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev`.

### Step 2 — Aedify (~10 minutes)
1. Install "Aedify" extension from VS Code marketplace
2. Click Aedify icon in sidebar → Sign In with API Key
3. Get API key from aedify.ai/console → API Keys → Create API Key
4. Before deploying, make sure `.env` is in both `.gitignore` and `.deployignore`
5. Open `aedify-backend/` folder in VS Code
6. Press Cmd+Shift+D (Mac) or Ctrl+Shift+D (Windows) to deploy
7. After deploy, go to Aedify console → your app → Environment Variables:
   - Add `OPENAI_API_KEY` = your OpenAI key
   - Add `SUPERMEMORY_API_KEY` = your Supermemory key
8. Copy the deployed app URL → paste into Worker's `AEDIFY_URL` constant
9. Redeploy the Worker: `wrangler deploy`

### Step 3 — Supermemory (~5 minutes)
1. Create account at supermemory.ai
2. Go to dashboard → API Keys → Create
3. Copy key — you already set it in Aedify environment variables above
4. No local install needed. Integration is already written in aedify-backend/index.js.

### Step 4 — Chrome Extension (~2 minutes)
1. Open Chrome → chrome://extensions
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the `/extension` folder
5. Extension appears in toolbar. Pin it for easy access.

To reload after any code change: go to chrome://extensions → click the refresh icon
on the traice card. No reinstall needed.

---

## Key Constraints and Edge Cases Copilot Should Know

**chrome.storage.local quota** — hard limit of ~5-10MB. Never store raw base64 image
data here. Always store R2 URLs only. This is already handled in popup.js.

**content.js cannot call chrome.tabs.captureVisibleTab** — only background.js (service
worker context) can. If screenshot functionality is extended, keep capture in background.

**chrome:// pages block content scripts** — this is expected and cannot be changed.
content.js simply will not inject on chrome:// URLs. background.js handles this by
checking `tab.url.startsWith('chrome://')` before processing navigation events.

**MV3 service workers can go idle** — Chrome can suspend background.js between events.
Do not store state in module-level variables in background.js. Always read from
chrome.storage.local. The scaffold already does this correctly.

**Cloudflare KV is eventually consistent** — reads after writes may not reflect the
latest value immediately. For the ingest → end-session flow this is fine because there
is a time gap between them. Do not use KV for anything requiring immediate read-after-write.

**Aedify .env must not be uploaded** — Aedify's secret scanner will block deployment if
it detects API keys in files. Set all secrets as environment variables in the Aedify
console post-deploy, never in files.

**Supermemory push is async and non-blocking** — if Supermemory is down or the key is
wrong, the synthesis still completes and returns to the user. The push failure is logged
but does not affect the user-facing output.

---

## What Copilot Should Help With

- Wiring the placeholder URLs once setup is complete
- Debugging any Chrome Extension messaging issues (the most common source of bugs)
- Testing the dwell scrape output on specific sites (Expedia, Amazon, etc.)
- Adjusting the LLM prompt if CSV output is not structured correctly for a given session
- Adding the aedify.json deployment config if not already present
- Any Node.js/Express issues in the Aedify backend

---
---

# PART 2 — COMPLETE CODE SCAFFOLD
### Every file needed to build traice, ready to copy into your project

# traice — Final Complete Scaffold v3
### All systems integrated: inactivity pause, dwell scraping, paste-to-R2 screenshots

---

## Final File Structure
```
traice/
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   ├── content.js
│   └── background.js
├── cloudflare-worker/
│   ├── index.js          (ingestion + R2 upload + session end)
│   └── wrangler.toml
└── aedify-backend/
    ├── index.js
    └── package.json
```

---

## Signal Budget (what we capture and why)

| Signal | Trigger | Volume (5-10 min demo) | Goes to |
|---|---|---|---|
| URL navigation | Tab load complete | ~10-20 events | KV via Worker |
| Text highlight | mouseup + selection | ~10-30 events | KV via Worker |
| Dwell scrape | 15s on same page | ~5-10 events | KV via Worker |
| Pasted screenshot | Ctrl/Cmd+V in popup | ~5-10 images | R2, URL stored in KV |
| Tab focus | Tab switch | ~10-20 events | KV via Worker |

**What we explicitly do NOT capture:** scroll events, mousemove coordinates, auto-viewport screenshots. These are the three things that would blow up storage.

---

## 1. `extension/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "traice",
  "version": "2.0.0",
  "description": "Trace your research intent. AI-synthesized session outputs.",
  "permissions": [
    "activeTab",
    "storage",
    "scripting",
    "tabs"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "32": "icons/32.png",
      "48": "icons/48.png",
      "128": "icons/128.png"
    }
  }
}
```

---

## 2. `extension/content.js`

```javascript
// content.js — traice v2
// Responsibilities:
//   1. Activity heartbeat (for inactivity pause system in background.js)
//   2. Text highlight capture
//   3. Dwell detection — 15s on page → scrape visible text + prices

const DWELL_THRESHOLD_MS   = 15_000; // 15s before we consider user "lingering"
const DWELL_REPOLL_MS      = 5_000;  // re-poll 5s later to catch lazy-loaded content
const ACTIVITY_THROTTLE_MS = 1_000;

// ── Activity Heartbeat ────────────────────────────────────────────────────────
let lastActivitySignal = 0;

function sendActivity() {
  const now = Date.now();
  if (now - lastActivitySignal < ACTIVITY_THROTTLE_MS) return;
  lastActivitySignal = now;
  chrome.runtime.sendMessage({ type: 'USER_ACTIVITY' }).catch(() => {});
}

document.addEventListener('mousemove', sendActivity, { passive: true });
document.addEventListener('keydown',   sendActivity, { passive: true });
document.addEventListener('scroll',    sendActivity, { passive: true });
document.addEventListener('click',     sendActivity, { passive: true });


// ── Text Highlight Capture ────────────────────────────────────────────────────
let highlightDebounce = null;

document.addEventListener('mouseup', () => {
  clearTimeout(highlightDebounce);
  highlightDebounce = setTimeout(async () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (!text || text.length < 5) return;

    const { sessionActive, sessionPaused } =
      await chrome.storage.local.get(['sessionActive', 'sessionPaused']);
    if (!sessionActive) return;

    // Deliberate highlight = activity, auto-resume if paused
    chrome.runtime.sendMessage({ type: 'USER_ACTIVITY' }).catch(() => {});

    const event = {
      type:      'highlight',
      text:      text.slice(0, 1000),
      context:   selection.anchorNode?.parentElement?.innerText?.slice(0, 300) || '',
      url:       window.location.href,
      title:     document.title,
      timestamp: new Date().toISOString()
    };

    chrome.runtime.sendMessage({ type: 'INGEST_EVENT', event }).catch(() => {});
  }, 400);
});


// ── Dwell Detection ───────────────────────────────────────────────────────────
// Fires when the user has been on this page for DWELL_THRESHOLD_MS.
// Grabs visible text + all price/number patterns found on the page.
// Re-polls after DWELL_REPOLL_MS to catch lazy-loaded content (e.g. Expedia prices).

let dwellTimer    = null;
let dwellRepoll   = null;
let dwellFired    = false; // only fire once per page load

function extractPageContent() {
  // Grab visible text — excludes scripts, styles, hidden elements
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip script/style tag content
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textParts = [];
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t.length > 3) textParts.push(t);
  }

  const fullText = textParts.join(' ').replace(/\s+/g, ' ').trim();

  // Extract price-like patterns: $123, $1,234.56, €99, £45.00, "from $299"
  const pricePattern = /(?:from\s+)?[$€£¥₹]\s?[\d,]+(?:\.\d{1,2})?/gi;
  const prices = [...new Set(fullText.match(pricePattern) || [])].slice(0, 30);

  return {
    // Cap at 3000 chars — enough for AI context, won't blow up payload
    visibleText: fullText.slice(0, 3000),
    prices
  };
}

function fireDwellEvent(label) {
  chrome.storage.local.get(['sessionActive'], ({ sessionActive }) => {
    if (!sessionActive) return;

    const { visibleText, prices } = extractPageContent();
    if (!visibleText || visibleText.length < 50) return; // skip empty/stub pages

    const event = {
      type:        'dwell_scrape',
      label,                           // 'initial' | 'repoll'
      url:         window.location.href,
      title:       document.title,
      visibleText,
      prices,
      timestamp:   new Date().toISOString()
    };

    chrome.runtime.sendMessage({ type: 'INGEST_EVENT', event }).catch(() => {});
  });
}

// Start dwell timer on page load
function initDwellTimer() {
  dwellFired = false;
  clearTimeout(dwellTimer);
  clearTimeout(dwellRepoll);

  dwellTimer = setTimeout(() => {
    if (dwellFired) return;
    dwellFired = true;

    fireDwellEvent('initial');

    // Re-poll 5s later for lazy-loaded content (React SPAs, flight prices, etc.)
    dwellRepoll = setTimeout(() => fireDwellEvent('repoll'), DWELL_REPOLL_MS);

  }, DWELL_THRESHOLD_MS);
}

// Run on initial load
initDwellTimer();

// Reset if user navigates within an SPA (URL changes without full page reload)
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    initDwellTimer();
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });
```

---

## 3. `extension/background.js`

```javascript
// background.js — traice v2
// Responsibilities:
//   1. Inactivity pause/resume (30s idle → pause, any activity → resume)
//   2. Route INGEST_EVENT messages → local storage + Cloudflare KV
//   3. URL/tab navigation tracking

const WORKER_URL         = 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev';
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
```

---

## 4. `extension/popup.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 300px;
      font-family: 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #f0f0f0;
      padding: 18px;
    }
    h1 { font-size: 22px; font-weight: 700; letter-spacing: 1px; color: #a78bfa; }
    .tagline { font-size: 11px; color: #555; margin-top: 3px; margin-bottom: 16px; }

    /* Status pill */
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; padding: 3px 10px; border-radius: 999px;
      margin-bottom: 14px;
    }
    .pill.idle   { background: #1a1a1a; color: #555; }
    .pill.active { background: #1a1a2e; color: #a78bfa; }
    .pill.paused { background: #2a1f00; color: #f59e0b; }
    .dot { width: 7px; height: 7px; border-radius: 50%; }
    .idle   .dot { background: #444; }
    .active .dot { background: #a78bfa; animation: blink 1.2s infinite; }
    .paused .dot { background: #f59e0b; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

    /* Buttons */
    .btn {
      width: 100%; padding: 11px;
      border: none; border-radius: 8px;
      font-size: 13px; font-weight: 600;
      cursor: pointer; transition: opacity .15s;
      margin-bottom: 8px;
    }
    .btn:hover { opacity: .85; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    #startBtn  { background: #a78bfa; color: #0f0f0f; }
    #endBtn    { background: #ef4444; color: #fff;    display: none; }
    #resumeBtn { background: #f59e0b; color: #0f0f0f; display: none; }

    /* Stats */
    #stats { font-size: 11px; color: #555; text-align: center; margin-bottom: 10px; }

    /* Screenshot drop zone */
    #screenshotZone {
      display: none;
      border: 1.5px dashed #333;
      border-radius: 8px;
      padding: 12px;
      text-align: center;
      font-size: 11px;
      color: #555;
      cursor: pointer;
      margin-bottom: 10px;
      transition: border-color .15s;
    }
    #screenshotZone:hover,
    #screenshotZone.drag-over { border-color: #a78bfa; color: #a78bfa; }
    #screenshotZone .hint { font-size: 10px; margin-top: 4px; color: #444; }

    /* Screenshot thumbnails */
    #thumbs {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-bottom: 10px;
    }
    .thumb {
      position: relative; width: 60px; height: 40px;
      border-radius: 4px; overflow: hidden;
      border: 1px solid #222;
    }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .thumb .remove {
      position: absolute; top: 1px; right: 2px;
      font-size: 10px; color: #fff; cursor: pointer;
      background: rgba(0,0,0,.6); border-radius: 2px;
      padding: 0 2px; line-height: 14px;
    }
    .uploading { opacity: .5; }

    /* Output */
    #spinner { display:none; font-size:11px; color:#888; text-align:center; margin:10px 0; }
    #output  {
      display: none; margin-top: 10px; padding: 10px;
      background: #1a1a1a; border-radius: 8px;
      font-size: 11px; color: #a78bfa; word-break: break-word;
    }
    #output a { color: #a78bfa; }
  </style>
</head>
<body>
  <h1>traice</h1>
  <p class="tagline">trace your intent. synthesize your session.</p>

  <div class="pill idle" id="pill">
    <div class="dot"></div>
    <span id="pillText">Idle</span>
  </div>

  <button class="btn" id="startBtn">▶ Start Session</button>
  <button class="btn" id="resumeBtn">▶ Resume Session</button>
  <button class="btn" id="endBtn">■ End Session & Synthesize</button>

  <div id="stats"></div>

  <!-- Screenshot paste/drop zone — only visible during active session -->
  <div id="screenshotZone" tabindex="0">
    📋 Paste or drop a screenshot here
    <div class="hint">Ctrl+V / Cmd+V · or drag an image file</div>
  </div>
  <div id="thumbs"></div>

  <div id="spinner">⏳ Synthesizing with AI…</div>
  <div id="output"></div>

  <script src="popup.js"></script>
</body>
</html>
```

---

## 5. `extension/popup.js`

```javascript
// popup.js — traice v2
// Handles: session start/end, screenshot paste/drop → Cloudflare R2, UI state

const WORKER_URL = 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev';

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
```

---

## 6. `cloudflare-worker/index.js`

```javascript
// Cloudflare Worker — traice v2
// Routes: POST /ingest, POST /upload-screenshot, POST /end-session
// Bindings needed: SESSION_STORE (KV), SCREENSHOT_BUCKET (R2)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AEDIFY_URL = 'https://YOUR_AEDIFY_APP_URL/synthesize';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // ── POST /ingest ────────────────────────────────────────────────────────
    if (url.pathname === '/ingest' && request.method === 'POST') {
      try {
        const { sessionId, event } = await request.json();
        if (!sessionId || !event) return json({ error: 'Missing fields' }, 400);

        const stored = await env.SESSION_STORE.get(sessionId, { type: 'json' });
        const events = stored?.events || [];
        events.push(event);

        await env.SESSION_STORE.put(
          sessionId,
          JSON.stringify({ sessionId, events }),
          { expirationTtl: 7200 } // 2hr TTL
        );

        return json({ ok: true, count: events.length });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── POST /upload-screenshot ─────────────────────────────────────────────
    // Receives multipart form data: image file + sessionId + timestamp
    // Stores in R2, returns the public URL
    if (url.pathname === '/upload-screenshot' && request.method === 'POST') {
      try {
        const formData  = await request.formData();
        const imageFile = formData.get('image');
        const sessionId = formData.get('sessionId');
        const timestamp = formData.get('timestamp') || new Date().toISOString();

        if (!imageFile || !sessionId) return json({ error: 'Missing image or sessionId' }, 400);

        const ext      = imageFile.type === 'image/png' ? 'png' : 'jpg';
        const key      = `sessions/${sessionId}/${Date.now()}.${ext}`;
        const buffer   = await imageFile.arrayBuffer();

        await env.SCREENSHOT_BUCKET.put(key, buffer, {
          httpMetadata: { contentType: imageFile.type }
        });

        // Construct public URL — requires R2 bucket to have public access enabled
        // or use a custom domain bound in Workers settings
        const r2Url = `https://YOUR_R2_PUBLIC_URL/${key}`;

        return json({ ok: true, r2Url, key });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── POST /end-session ───────────────────────────────────────────────────
    if (url.pathname === '/end-session' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { sessionId, events: localEvents, screenshots } = body;
        if (!sessionId) return json({ error: 'Missing sessionId' }, 400);

        const kvData   = await env.SESSION_STORE.get(sessionId, { type: 'json' });
        const kvEvents = kvData?.events || [];

        const allEvents = mergeEvents(localEvents || [], kvEvents);

        const payload = {
          sessionId,
          events:      allEvents,
          screenshots: screenshots || [],
          endedAt:     new Date().toISOString()
        };

        const aedResp = await fetch(AEDIFY_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload)
        });

        if (!aedResp.ok) return json({ error: `Aedify: ${await aedResp.text()}` }, 502);
        const result = await aedResp.json();

        // Clean up KV
        await env.SESSION_STORE.delete(sessionId);
        return json(result);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    return json({ error: 'Not found' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function mergeEvents(local, remote) {
  const seen = new Set();
  return [...local, ...remote]
    .filter(e => {
      const key = `${e.timestamp}-${e.type}-${(e.text || e.url || e.r2Url || '').slice(0, 40)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
```

### `cloudflare-worker/wrangler.toml`
```toml
name = "traice-worker"
main = "index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "SESSION_STORE"
id      = "YOUR_KV_NAMESPACE_ID"

[[r2_buckets]]
binding = "SCREENSHOT_BUCKET"
bucket_name = "traice-screenshots"
```

---

## 7. `aedify-backend/index.js`

```javascript
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const OpenAI  = require('openai');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.post('/synthesize', async (req, res) => {
  const { sessionId, events, screenshots, endedAt } = req.body;
  if (!events?.length) return res.status(400).json({ error: 'No events' });

  try {
    const formattedEvents = formatEvents(events);
    const screenshotNote  = screenshots?.length
      ? `\n\nThe user also pasted ${screenshots.length} screenshot(s) during this session. ` +
        `They are available at:\n${screenshots.map(s => `- ${s.r2Url} (at ${s.timestamp})`).join('\n')}\n` +
        `Reference them as visual evidence in your analysis where relevant.`
      : '';

    const prompt = buildPrompt(formattedEvents, screenshotNote);

    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0.2,
      max_tokens:  2500,
      messages: [
        {
          role:    'system',
          content: 'You are an expert research analyst. Convert raw browsing behavior into structured, actionable documents. Respond ONLY with the requested code blocks — no prose outside them.'
        },
        { role: 'user', content: prompt }
      ]
    });

    const raw = completion.choices[0].message.content.trim();
    const { csv, markdown } = parseOutput(raw);

    // Push to Supermemory async
    pushToSupermemory({ sessionId, events, screenshots, csv, markdown, endedAt })
      .catch(e => console.error('[Supermemory]', e.message));

    res.json({ ok: true, sessionId, csv, markdown, synthesizedAt: new Date().toISOString() });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


function formatEvents(events) {
  return events.map((e, i) => {
    switch (e.type) {
      case 'highlight':
        return `[${i+1}] HIGHLIGHT on "${e.title}" (${e.url})\n    "${e.text}"`;
      case 'navigation':
        return `[${i+1}] VISITED: "${e.title}" → ${e.url}`;
      case 'tab_focus':
        return `[${i+1}] FOCUSED TAB: "${e.title}" → ${e.url}`;
      case 'screenshot':
        return `[${i+1}] SCREENSHOT TAKEN: ${e.r2Url}`;
      case 'dwell_scrape':
        const prices = e.prices?.length ? `\n    Prices found: ${e.prices.join(', ')}` : '';
        return `[${i+1}] LINGERED ON "${e.title}" (${e.url}) [${e.label}]${prices}\n    Content: ${e.visibleText?.slice(0, 500)}`;
      default:
        return `[${i+1}] ${e.type}: ${JSON.stringify(e)}`;
    }
  }).join('\n\n');
}


function buildPrompt(formattedEvents, screenshotNote) {
  return `
You are analyzing a user's web research session. Below are all micro-behaviors captured in chronological order — pages visited, text highlighted, tabs lingered on (with full visible text and prices extracted), and screenshots taken.${screenshotNote}

---SESSION DATA---
${formattedEvents}
---END SESSION DATA---

TASK 1 — CSV DECISION MATRIX:
Infer the core research subject (e.g., flights, laptops, APIs, apartments).
Create a CSV comparison table. Each ROW is a distinct item/option found in the session data. COLUMNS are the key attributes being compared (extracted from highlights, dwell content, and prices).
If no clear comparison exists, create a "Key Findings" table: Source, Key Insight, Relevance (1–5).

Format:
\`\`\`csv
Column1,Column2,Column3
Value1,Value2,Value3
\`\`\`

TASK 2 — MARKDOWN CHECKLIST:
Infer what the user likely wants to do next. Group action items logically.

Format:
\`\`\`markdown
## Session Summary
[1-sentence summary of intent]

## Key Findings
- [finding]

## Action Items
- [ ] [action]
\`\`\`

Return ONLY these two code blocks. Nothing else.
`.trim();
}


function parseOutput(raw) {
  return {
    csv:      (raw.match(/```csv\n([\s\S]*?)```/)      || [])[1]?.trim() || '',
    markdown: (raw.match(/```markdown\n([\s\S]*?)```/) || [])[1]?.trim() || raw
  };
}


async function pushToSupermemory({ sessionId, events, screenshots, csv, markdown, endedAt }) {
  if (!process.env.SUPERMEMORY_API_KEY) return;

  const content = [
    `# traice Session: ${sessionId}`,
    `Recorded: ${endedAt}`,
    `## Pages Visited`,
    [...new Set(events.filter(e => e.url).map(e => e.url))].map(u => `- ${u}`).join('\n'),
    `## Highlights`,
    events.filter(e => e.type === 'highlight').map(e => `- "${e.text}" (${e.url})`).join('\n'),
    `## Screenshots`,
    (screenshots || []).map(s => `- ${s.r2Url}`).join('\n'),
    `## AI Output\n${markdown}`,
    `## CSV\n\`\`\`csv\n${csv}\n\`\`\``
  ].join('\n\n');

  await fetch('https://api.supermemory.ai/v3/memories', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SUPERMEMORY_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      content,
      metadata: {
        source:         'traice',
        sessionId,
        type:           'research_session',
        highlightCount: events.filter(e => e.type === 'highlight').length,
        dwellCount:     events.filter(e => e.type === 'dwell_scrape').length,
        screenshotCount: (screenshots || []).length,
        recordedAt:     endedAt
      }
    })
  });
}


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[traice] Backend on :${PORT}`));
```

---

## 8. Setup Checklist (run in order)

```bash
# 1. Cloudflare — create KV namespace
wrangler kv:namespace create SESSION_STORE
# paste the returned ID into wrangler.toml

# 2. Cloudflare — create R2 bucket
wrangler r2 bucket create traice-screenshots
# enable public access in Cloudflare dashboard → R2 → traice-screenshots → Settings → Public Access
# paste the public URL into index.js where it says YOUR_R2_PUBLIC_URL

# 3. Deploy worker
cd cloudflare-worker && wrangler deploy

# 4. Install and run Aedify backend
cd aedify-backend && npm install
# create .env:
#   OPENAI_API_KEY=sk-...
#   SUPERMEMORY_API_KEY=sm-...
npm start

# 5. Load extension
# Chrome → chrome://extensions → Developer mode → Load unpacked → select /extension folder

# 6. Wire up the URL
# Replace all instances of https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
# in content.js, background.js, popup.js with your actual deployed worker URL
```

---

## Data Budget Summary

For a 5–10 minute demo session:

| Signal | Est. events | Est. payload |
|---|---|---|
| Navigations | 15 | ~3KB |
| Highlights | 20 | ~40KB |
| Dwell scrapes (2 passes × ~5 pages) | 10 | ~150KB |
| Tab focus events | 20 | ~4KB |
| Screenshots (5–10 × ~300KB in R2) | 5–10 | ~0 in KV (URL only ~200B each) |
| **Total in KV** | | **~200KB** |
| **Total in R2** | | **~1.5–3MB** |

Well within free tier limits for both. KV free tier is 1GB stored, R2 free tier is 10GB.
