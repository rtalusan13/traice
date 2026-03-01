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
      max_tokens:  4000,
      messages: [
        {
          role:    'system',
          content: 'You are an expert research analyst. Convert raw browsing behavior into structured, actionable documents. Respond ONLY with the requested code blocks — no prose outside them.'
        },
        { role: 'user', content: prompt }
      ]
    });

    const raw = completion.choices[0].message.content.trim();
    const { sessionType, csv, markdown } = parseOutput(raw);

    // Push to Supermemory async
    pushToSupermemory({ sessionId, events, screenshots, csv, markdown, endedAt })
      .catch(e => console.error('[Supermemory]', e.message));

    res.json({ ok: true, sessionId, sessionType, csv, markdown, synthesizedAt: new Date().toISOString() });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


function formatEvents(events) {
  // Separate dwell scrapes from other events for special treatment
  const dwellEvents = events.filter(e => e.type === 'dwell_scrape');
  const otherEvents = events.filter(e => e.type !== 'dwell_scrape');

  // Format chronological events (non-dwell)
  const chronological = otherEvents.map((e, i) => {
    switch (e.type) {
      case 'highlight':
        return `[${i+1}] HIGHLIGHT on "${e.title}" (${e.url})\n    "${e.text}"`;
      case 'navigation':
        return `[${i+1}] VISITED: "${e.title}" → ${e.url}`;
      case 'tab_focus':
        return `[${i+1}] FOCUSED TAB: "${e.title}" → ${e.url}`;
      case 'screenshot':
        return `[${i+1}] SCREENSHOT TAKEN: ${e.r2Url}`;
      default:
        return `[${i+1}] ${e.type}: ${JSON.stringify(e)}`;
    }
  }).join('\n\n');

  // Format dwell scrapes as a grouped high-signal section
  let dwellSection = '';
  if (dwellEvents.length > 0) {
    const dwellFormatted = dwellEvents.map((e, i) => {
      const prices = e.prices?.length ? `\n    Prices found: ${e.prices.join(', ')}` : '';
      return `  [DWELL-${i+1}] "${e.title}" (${e.url}) [${e.label}]${prices}\n    Content: ${e.visibleText?.slice(0, 800)}`;
    }).join('\n\n');

    dwellSection = `\n\n` +
      `══════════════════════════════════════════════════════════════\n` +
      `PAGES WHERE USER LINGERED (highest intent signal — the user stayed on these pages\n` +
      `for 15+ seconds, meaning they were actively reading and considering this content.\n` +
      `Weight these heavily in your analysis. Extract ALL prices, specs, and facts from here.)\n` +
      `══════════════════════════════════════════════════════════════\n\n` +
      dwellFormatted;
  }

  return chronological + dwellSection;
}


function buildPrompt(formattedEvents, screenshotNote) {
  return `
You are analyzing a user's web research session. Below are all captured micro-behaviors — pages visited, text the user deliberately highlighted, pages they lingered on for 15+ seconds (with extracted visible text and prices), tab switches, and manually pasted screenshots.${screenshotNote}

---SESSION DATA---
${formattedEvents}
---END SESSION DATA---

═══════════════════════════════════════════
STEP 1 — CLASSIFY THE SESSION (do this first)
═══════════════════════════════════════════

Before generating any output, classify this session into EXACTLY ONE of these types based on the behavioral evidence:

• COMPARISON — user was comparing products, flights, services, specs, or pricing across multiple options. Evidence: multiple similar pages visited, price patterns in dwell scrapes, highlights on specs/features/prices.
• RESEARCH_ESSAY — user was reading biographical, academic, Wikipedia, news, or long-form content to learn about a topic. Evidence: Wikipedia pages, news articles, long text highlights, few or no prices.
• SCIENTIFIC — user was reading academic papers, studies, methodology descriptions, or data-heavy sources. Evidence: .edu or journal URLs, highlights on methodology/findings/sample sizes, technical vocabulary.
• PLANNING — user was planning travel, events, schedules, or logistics. Evidence: calendar/booking sites, itinerary pages, hotel/flight/activity pages with dates and prices.
• GENERAL — mixed signals or does not clearly fit any category above.

Output your classification as the FIRST line of your response, exactly like this:
SESSION_TYPE: [TYPE]

Then generate the two code blocks below based on that classification.

═══════════════════════════════════════════
STEP 2 — GENERATE OUTPUT (tailored to session type)
═══════════════════════════════════════════

▸ RULES THAT APPLY TO ALL SESSION TYPES:
- The markdown summary opening line MUST name the specific topic. Write "This session focused on comparing economy flights from Chicago to Miami" NOT "The user was researching travel."
- If the user highlighted text, those highlights are the HIGHEST-SIGNAL inputs. Reference them explicitly in your analysis (quote them).
- If prices were found in dwell scrapes, ALWAYS include a "## Price Summary" section in markdown.
- Next steps MUST be specific and reference actual URLs, page titles, or content from the session. NEVER write generic advice like "explore more options" or "investigate further" or "continue researching."
- Never truncate. If content is long, prioritize specificity over brevity.
- Extract ACTUAL values from the session data for CSV cells — do not leave cells empty if the data exists anywhere in the session events.

▸ IF SESSION_TYPE = COMPARISON:
CSV: Each ROW = a distinct item/product/option found across the session. Each COLUMN = a comparable attribute (price, specs, features, ratings, availability). Fill every cell with actual extracted data.
Markdown structure:
  ## Session Summary (1 specific sentence)
  ## Comparison Verdict (best option with explicit tradeoffs)
  ## Price Summary (if prices found)
  ## Key Highlights (quote user's highlighted text and explain why it matters)
  ## Next Steps
  - [ ] Open a Google Sheet with this comparison data pre-filled
  - [ ] Return to [specific URL] to verify [specific attribute]
  - [ ] [other specific actions referencing session content]

▸ IF SESSION_TYPE = RESEARCH_ESSAY:
CSV columns: Source URL, Key Claim, Direct Quote or Evidence, Relevance (1-5)
Markdown structure:
  ## Session Summary (1 specific sentence naming the topic)
  ## Essay Outline (H3 section headers the user could paste into a Google Doc)
  ## Key Highlights (quote user's highlighted text)
  ## Bibliography (all URLs visited, formatted as sources)
  ## Next Steps
  - [ ] Start a Google Doc with this outline
  - [ ] Find a source for [specific claim that lacked evidence in the session]
  - [ ] [other specific actions]

▸ IF SESSION_TYPE = SCIENTIFIC:
CSV columns: Source, Methodology, Key Finding, Sample Size (if mentioned), Limitations (if mentioned)
Markdown structure:
  ## Session Summary (1 specific sentence naming the research area)
  ## Literature Review Outline (structured by theme or methodology)
  ## Key Highlights (quote user's highlighted text)
  ## Research Gaps Identified
  ## Next Steps
  - [ ] Read [specific paper or claim from session] in full
  - [ ] Search for studies addressing [identified gap]
  - [ ] [other specific actions]

▸ IF SESSION_TYPE = PLANNING:
CSV columns: Name, Price, Date/Time (if found), Pros, Cons, URL
Markdown structure:
  ## Session Summary (1 specific sentence naming the plan)
  ## Itinerary / Step-by-Step Plan (built from session content, day-by-day if travel)
  ## Budget Summary (if prices found)
  ## Key Highlights (quote user's highlighted text)
  ## Next Steps (booking priority order)
  - [ ] Book [specific item] at [specific URL] — [price]
  - [ ] [other specific actions with URLs and prices]

▸ IF SESSION_TYPE = GENERAL:
CSV columns: Source URL, Key Insight, Relevance (1-5)
Markdown structure:
  ## Session Summary (1 specific sentence)
  ## Key Findings (grouped by topic)
  ## Key Highlights (quote user's highlighted text)
  ## Next Steps
  - [ ] [specific actions referencing session content]

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════

Return EXACTLY this structure — the classification line, then two fenced code blocks. No other prose.

SESSION_TYPE: [TYPE]

\`\`\`csv
[your CSV here]
\`\`\`

\`\`\`markdown
[your markdown here]
\`\`\`
`.trim();
}


function parseOutput(raw) {
  // Extract the session type classification from the first line
  const sessionType = (raw.match(/^SESSION_TYPE:\s*(\w+)/m) || [])[1] || 'GENERAL';

  return {
    sessionType,
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
