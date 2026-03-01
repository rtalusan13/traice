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
