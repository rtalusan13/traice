require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const OpenAI  = require('openai');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.post('/synthesize', async (req, res) => {
  const { sessionId, events, screenshots, endedAt, userId, continuingSurf, continueSessionType } = req.body;
  if (!events?.length) return res.status(400).json({ error: 'No events' });

  try {
    const formattedEvents = formatEvents(events);
    const screenshotNote  = screenshots?.length
      ? `\n\nThe user also pasted ${screenshots.length} screenshot(s) during this session. ` +
        `They are available at:\n${screenshots.map(s => `- ${s.r2Url} (at ${s.timestamp})`).join('\n')}\n` +
        `Reference them as visual evidence in your analysis where relevant.`
      : '';

    const continuationNote = continuingSurf
      ? '\n\nNOTE: This is a CONTINUATION session. The user previously researched this topic and chose to keep surfing for more information. Build on and extend the previous findings rather than repeating them. Reference what was already found and focus on what is NEW in this session.\n'
      : '';

    const prompt = continuationNote + buildPrompt(formattedEvents, screenshotNote);

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
    pushToSupermemory({ sessionId, events, screenshots, csv, markdown, endedAt, userId, sessionType })
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

CRITICAL CSV RULE: Every CSV row must contain ACTUAL named entities extracted from the session — real player names, real city names, real hotel names, real product names, real prices, real statistics. Do NOT generate generic rows like "Source URL, Key Insight, 5". If a player was researched, the CSV must contain their actual stats. If travel was researched, the CSV must contain actual city names, hotel names, and prices found. If products were compared, the CSV must contain actual product names and specs. A CSV row with a relevance score of 5 and no specific named content is a FAILURE. Extract and tabulate what was actually seen.

▸ RULES THAT APPLY TO ALL SESSION TYPES:
- The markdown summary opening line MUST name the specific topic. Write "This session focused on comparing economy flights from Chicago to Miami" NOT "The user was researching travel."
- If the user highlighted text, those highlights are the HIGHEST-SIGNAL inputs. Reference them explicitly in your analysis (quote them).
- If prices were found in dwell scrapes, ALWAYS include a "## Price Summary" section in markdown.
- Next steps MUST be specific and reference actual URLs, page titles, or content from the session. NEVER write generic advice like "explore more options" or "investigate further" or "continue researching."
- Never truncate. If content is long, prioritize specificity over brevity.
- Write the Session Summary as 2-3 sentences of clean natural prose. No bullet points in the summary. No markdown symbols in the summary sentences.
- Use ## only for major section headers. Never use ### for anything except Essay Outline subsections in RESEARCH_ESSAY sessions.
- Write next steps as imperative action sentences. Start each with a strong verb. Reference specific page titles, URLs, prices, or quoted content from the session. Never start a next step with "Explore", "Look into", "Consider", or "Research".
- Do not add any section that is not defined in the session type template above.
- Keep Key Highlights to the 3 most impactful user highlights maximum. Quote the exact highlighted text in quotation marks then add one sentence of analytical commentary.
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

▸ IF SESSION_TYPE = PLANNING (TRAVEL/TRIPS/EVENTS — most important section):
This session involves real-world planning. The user is trying to make decisions with real money. Treat this with maximum specificity.

CSV: Do NOT use generic columns. Use these exact columns based on what was found:
- If travel: Destination, Accommodation Name, Price Per Night, Total Cost, Dates Available, Rating, Pros, Cons, Booking URL
- If flights: Origin, Destination, Airline, Departure Time, Price, Duration, Stops, Booking URL
- If activities/restaurants: Name, Location, Price Range, Rating, Hours, Booking Required, URL
- If events: Event Name, Date, Venue, Ticket Price, Availability, URL

Extract EVERY named hotel, flight, airline, city, attraction, restaurant, or price that appeared anywhere in the session including dwell scrape content. If a price appeared in a dwell scrape, it MUST appear in the CSV.

Markdown structure:
  ## Session Summary
  [1 sentence naming the specific trip or event — e.g. "This session focused on planning a 5-day trip to Tokyo in April 2026."]

  ## What You Looked At
  [Bullet list of every specific option the user viewed — every hotel name, every flight route, every attraction — with the price if found]

  ## Recommended Itinerary
  [Day-by-day plan built entirely from what was actually viewed in the session. Day 1, Day 2 etc. Include specific names, addresses, and costs where found. If not enough data for full days, build the best possible plan from available data.]

  ## Budget Breakdown
  [Table showing: Category | Item | Estimated Cost | Notes]
  [Must include every price found in the session. End with a Total Estimated Cost row.]

  ## Key Highlights (quote user's highlighted text)

  ## Booking Priority
  [Ordered list of what to book first, second, third — with specific URLs from the session]

  ## Next Steps
  - [ ] Book [specific item] at [specific URL] — [price]
  - [ ] [specific action with real data from session]

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


async function pushToSupermemory({ sessionId, events, screenshots, csv, markdown, endedAt, userId, sessionType }) {
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
        userId:         userId || 'anonymous',
        sessionId,
        sessionType:    sessionType || 'GENERAL',
        type:           'research_session',
        highlightCount: events.filter(e => e.type === 'highlight').length,
        dwellCount:     events.filter(e => e.type === 'dwell_scrape').length,
        screenshotCount: (screenshots || []).length,
        recordedAt:     endedAt
      }
    })
  });
}


// ── GET /sessions — Fetch past sessions from Supermemory ──────────────────────
app.get('/sessions', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json({ ok: true, sessions: [] });

  try {
    if (!process.env.SUPERMEMORY_API_KEY) {
      return res.json({ ok: true, sessions: [] });
    }

    // Broader query that includes userId directly for better matching
    const searchResp = await fetch(
      `https://api.supermemory.ai/v3/memories/search?q=${encodeURIComponent('traice ' + userId)}&limit=20`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SUPERMEMORY_API_KEY}`,
          'Content-Type':  'application/json'
        }
      }
    );

    if (!searchResp.ok) {
      console.error('[sessions] Supermemory search failed:', searchResp.status);
      return res.json({ ok: true, sessions: [] });
    }

    const data = await searchResp.json();
    const memories = data.memories || data.results || [];

    // Permissive filter: accept any result where content contains traice Session
    // and userId appears anywhere in the result object
    const userSessions = memories
      .filter(m => {
        const content = m.content || '';
        const meta = JSON.stringify(m.metadata || {});
        return content.includes('traice Session:') && (meta.includes(userId) || !userId);
      })
      .map(m => {
        // Strip markdown symbols for summary
        const rawContent = m.content || '';
        const summary = rawContent
          .replace(/^#+\s*/gm, '')
          .replace(/[\*\[\]\-_`]/g, '')
          .slice(0, 150)
          .trim();

        // Extract full markdown from content (between ## AI Output and ## CSV)
        const mdMatch = rawContent.match(/## AI Output\n([\s\S]*?)(?=## CSV|$)/);
        const fullMarkdown = mdMatch ? mdMatch[1].trim() : '';

        return {
          sessionId:    m.metadata?.sessionId || 'unknown',
          recordedAt:   m.metadata?.recordedAt || new Date().toISOString(),
          sessionType:  m.metadata?.sessionType || 'GENERAL',
          summary,
          fullMarkdown
        };
      });

    res.json({ ok: true, sessions: userSessions });
  } catch (err) {
    console.error('[sessions] Error:', err.message);
    res.json({ ok: true, sessions: [] });
  }
});


// ── POST /action — Targeted AI follow-up actions ─────────────────────────────
app.post('/action', async (req, res) => {
  const { action, sessionType, markdown, csv } = req.body;
  if (!action || !markdown) {
    return res.status(400).json({ error: 'Missing action or markdown' });
  }

  const context = csv ? `${markdown}\n\nCSV Data:\n${csv}` : markdown;

  const actionPrompts = {
    summary: {
      system: 'You are a research analyst. Write clean, professional prose.',
      user:   `Write a 150-200 word polished summary paragraph of this research session. No bullets, no headers, clean flowing prose only.\n\n${context}`
    },
    outline: {
      system: 'You are a document structure expert.',
      user:   `Create a Google Doc ready outline from this research session with an H1 title, H2 sections, and bullet sub-items.\n\n${context}`
    },
    sources: {
      system: 'You are a research librarian.',
      user:   `Based on this research session, identify exactly 3 specific gaps in the sources. For each gap, provide an exact search query the user should run referencing the actual topic.\n\n${context}`
    },
    intro: {
      system: 'You are an essay writer.',
      user:   `Write a 100-word essay introduction with an engaging hook naming the specific topic from this research session.\n\n${context}`
    },
    gaps: {
      system: 'You are a critical research analyst.',
      user:   `Identify the 3 most important missing pieces from this research session and state exactly where to find them.\n\n${context}`
    },
    itinerary: {
      system: 'You are a travel planner.',
      user:   `Create a complete day-by-day itinerary with times, activities, and estimated costs based on this planning session.\n\n${context}`
    },
    budget: {
      system: 'You are a financial planner.',
      user:   `Create a full budget breakdown table in markdown with categories and totals based on this session.\n\n${context}`
    },
    alternatives: {
      system: 'You are a comparison shopping expert.',
      user:   `Suggest 3 specific cheaper or better alternatives referencing actual items from this session.\n\n${context}`
    },
    litreview: {
      system: 'You are an academic researcher.',
      user:   `Create a structured literature review outline with themes, methodologies, and key findings based on this research session.\n\n${context}`
    }
  };

  const promptConfig = actionPrompts[action];
  if (!promptConfig) {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  try {
    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0.3,
      max_tokens:  1000,
      messages: [
        { role: 'system', content: promptConfig.system },
        { role: 'user',   content: promptConfig.user }
      ]
    });

    const result = completion.choices[0].message.content.trim();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[action]', err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[traice] Backend on :${PORT}`));
