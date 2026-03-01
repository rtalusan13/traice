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
