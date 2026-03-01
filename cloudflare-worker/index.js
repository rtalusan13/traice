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
