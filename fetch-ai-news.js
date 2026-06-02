#!/usr/bin/env node
/**
 * ai-news: Fetch today's AI news via RSS + HackerNews + Gemini 2.5 Flash (Google Search grounding).
 * Sections: Official Labs | Models (incl. video/image/audio/platforms) | Agents | Industry
 * Format: Headline + link (token-efficient)
 * Cron: 7am PST daily (15:00 UTC)
 */

const { spawnSync } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');

const LOG_PATH = path.join(__dirname, 'logs', 'ai-news.log');
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;       // your Telegram chat/group ID
const THREAD_ID = process.env.TELEGRAM_THREAD_ID    // topic/thread ID (supergroups only — omit if not using topics)
  ? parseInt(process.env.TELEGRAM_THREAD_ID, 10)
  : undefined;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HN_SCORE_THRESHOLD = 75;

// Load config (watch lists + RSS feeds) — edit config.json to add/remove companies or feeds
const config = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const RSS_FEEDS = config.rss_feeds.filter(f => f.status === 'working');
const WATCH = config.watch;
const ALL_WATCH = Object.values(WATCH).flat().join(', ');

// Preferred sources for Google Search results
const PREFERRED_DOMAINS = [
  'techcrunch.com', 'theverge.com', 'venturebeat.com', 'wired.com',
  'arstechnica.com', 'reuters.com', 'bloomberg.com', 'ft.com',
  'technologyreview.com', 'theregister.com',
].join(', ');

function today() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles',
  });
}

function fetchHNStories() {
  const query = encodeURIComponent('AI');
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&numericFilters=points%3E%3D${HN_SCORE_THRESHOLD}&hitsPerPage=30`;
  const result = spawnSync('curl', ['-s', '-L', '--max-time', '15', url], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('HN fetch failed:', result.stderr || `exit ${result.status}`);
    return [];
  }

  const body = result.stdout.trim();
  if (!body) {
    console.error('HN fetch failed: empty response body');
    return [];
  }
  if (!body.startsWith('{')) {
    console.error(`HN fetch returned non-JSON response: ${body.substring(0, 120)}`);
    return [];
  }

  try {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return JSON.parse(body).hits
      .filter(h => new Date(h.created_at).getTime() > cutoff)
      .map(h => ({
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points,
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 15);
  } catch (e) {
    console.error(`HN parse failed: ${e.message}. Body preview: ${body.substring(0, 120)}`);
    return [];
  }
}

function fetchRSSStories() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const stories = [];

  for (const feed of RSS_FEEDS) {
    const result = spawnSync('curl', ['-s', '-L', '--max-time', '15', feed.url], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(`RSS fetch failed (${feed.name}) (exit ${result.status}): ${result.stderr || '(no stderr)'}`); continue; }

    // Parse <item> blocks from RSS XML
    const items = result.stdout.match(/<item[\s\S]*?<\/item>/g) || [];
    let addedForFeed = 0;
    for (const item of items) {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     item.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
      const link  = (item.match(/<link>(.*?)<\/link>/) ||
                     item.match(/<link href="(.*?)"/))?.[1]?.trim();
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ||
                      item.match(/<published>(.*?)<\/published>/)?.[1];

      if (!title || !link) continue;
      if (pubDate && new Date(pubDate).getTime() < cutoff) continue;

      stories.push({ source: feed.name, title, url: link });
      addedForFeed += 1;
      if (addedForFeed >= 5) break;
    }
    console.log(`RSS ${feed.name}: ${addedForFeed} recent items kept`);
  }

  return stories;
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST', timeout: 90000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out after 90s')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function geminiSearch(prompt, retries = 1) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) console.log(`Gemini retry attempt ${attempt}...`);
    let json;
    try {
      json = await httpsPost('generativelanguage.googleapis.com',
        '/v1beta/models/gemini-2.5-flash:generateContent',
        { 'x-goog-api-key': GEMINI_API_KEY }, body);
    } catch (e) {
      if (attempt < retries) continue;
      throw new Error(`Gemini request failed: ${e.message}`);
    }

    if (!json.candidates?.[0]) {
      if (attempt < retries) continue;
      throw new Error(`Gemini error: ${JSON.stringify(json).substring(0, 500)}`);
    }

    const text = json.candidates[0].content.parts[0].text.trim();

    try {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      JSON.parse(cleaned); // validate
      return cleaned;
    } catch (e) {
      if (attempt < retries) continue;
      throw new Error(`Gemini returned invalid JSON: ${text.substring(0, 500)}`);
    }
  }
}

async function sendTelegram(text, parseMode = 'HTML') {
  const payload = { chat_id: CHAT_ID, text, parse_mode: parseMode, disable_web_page_preview: true };
  if (THREAD_ID) payload.message_thread_id = THREAD_ID;
  const body = JSON.stringify(payload);
  const json = await httpsPost('api.telegram.org', `/bot${BOT_TOKEN}/sendMessage`, {}, body);
  if (!json.ok) throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
}

async function sendErrorAlert(err) {
  try {
    let logTail = '';
    try {
      if (fs.existsSync(LOG_PATH)) {
        const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-8).join('\n');
        if (lines) logTail = `\n\nRecent log:\n<code>${escapeHtml(lines.substring(0, 1200))}</code>`;
      }
    } catch (tailErr) {
      console.error('Could not read log tail for alert:', tailErr.message);
    }

    await sendTelegram(`⚠️ <b>AI News failed</b>\n${escapeHtml(err.message.substring(0, 300))}\n\nLog: <code>${escapeHtml(LOG_PATH)}</code>${logTail}`);
  } catch (e) {
    console.error('Could not send error alert:', e.message);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initLogging() {
  const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const stamp = new Date().toISOString();
  stream.write(`\n=== ${stamp} ===\n`);

  const wrap = (method) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const rendered = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      stream.write(`${rendered}\n`);
      original(...args);
    };
  };

  wrap('log');
  wrap('error');

  process.on('exit', () => stream.end());
}

initLogging();

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');

  console.log(`Fetching AI news for ${today()}...`);

  const hnStories = fetchHNStories();
  console.log(`HN: ${hnStories.length} stories with ${HN_SCORE_THRESHOLD}+ points`);

  const rssStories = fetchRSSStories();
  console.log(`RSS: ${rssStories.length} stories total across all feeds`);

  const hnContext = hnStories.length > 0
    ? `\n\nHackerNews stories scoring ${HN_SCORE_THRESHOLD}+ points (last 48h) — use as bonus signal:\n` +
      hnStories.map(s => `- [${s.points}pts] ${s.title} — ${s.url}`).join('\n')
    : '';

  const rssContext = rssStories.length > 0
    ? `\n\nRSS feed stories from official lab blogs (last 48h) — prioritise these:\n` +
      rssStories.map(s => `- [${s.source}] ${s.title} — ${s.url}`).join('\n')
    : '';

  const prompt = `You are a daily AI news curator. Today is ${today()}.

Using Google Search, find the most important AI news from the last 24-48 hours.${rssContext}${hnContext}

Pay close attention to these companies and models: ${ALL_WATCH}

For Google Search results, prefer reputable sources: ${PREFERRED_DOMAINS}

Return ONLY a valid JSON object — no markdown, no code fences, no extra text:
{
  "official_labs": [{"headline": "...", "url": "https://..."}],
  "models":        [{"headline": "...", "url": "https://..."}],
  "agents":        [{"headline": "...", "url": "https://..."}],
  "industry":      [{"headline": "...", "url": "https://..."}]
}

Section rules:
- official_labs: news from OpenAI, Anthropic, Google DeepMind, Meta AI, xAI/Grok
- models: new model releases and updates — include video/image/audio/platform companies from the watch list
- agents: agentic frameworks, tooling, automation, coding assistants
- industry: funding, policy, regulation, deals — include Chinese labs (DeepSeek, ByteDance/Doubao, Qwen, Kimi)

Format rules:
- Up to 12 items per section (we de-duplicate across sections after, aiming for 8 displayed per section)
- Headlines: concise, under 12 words, no trailing punctuation
- URLs: real source article URLs (use HN URL only if the discussion itself is the story)
- Prioritise RSS feed stories first, then Google Search results, then HN stories as bonus signal
- Only stories from the last 48 hours`;

  console.log('Calling Gemini 2.5 Flash...');
  const cleaned = await geminiSearch(prompt, 2);
  const sections = JSON.parse(cleaned);

  // De-duplicate across sections: first occurrence wins
  const seenUrls = new Set();
  const seenHeadlineWords = new Set();
  function isDupe(item) {
    const url = item.url.replace(/\/$/, '').toLowerCase();
    const words = item.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    if (seenUrls.has(url) || seenHeadlineWords.has(words)) return true;
    seenUrls.add(url);
    seenHeadlineWords.add(words);
    return false;
  }

  const sectionDefs = [
    { key: 'official_labs', emoji: '🏢', title: 'Official Labs' },
    { key: 'models',        emoji: '🧠', title: 'Models' },
    { key: 'agents',        emoji: '⚡', title: 'Agents' },
    { key: 'industry',      emoji: '💼', title: 'Industry' },
  ];

  const header = `📰 <b>AI News — ${today()}</b>\n`;
  const sectionBlocks = sectionDefs.map(({ key, emoji, title }) => {
    const items = (sections[key] || []).filter(item => !isDupe(item)).slice(0, 8);
    const lines = items.map(item => `• <a href="${item.url}">${escapeHtml(item.headline)}</a>`).join('\n');
    return `\n${emoji} <b>${title}</b>\n${lines}`;
  });

  const full = header + sectionBlocks.join('');

  if (full.length <= 4096) {
    console.log(`Sending (${full.length} chars)...`);
    await sendTelegram(full);
  } else {
    const msg1 = header + sectionBlocks[0] + sectionBlocks[1];
    const msg2 = sectionBlocks[2] + sectionBlocks[3];
    console.log(`Splitting (${full.length} chars) into 2 messages...`);
    await sendTelegram(msg1);
    await sendTelegram(msg2);
  }

  console.log('Done.');
}

main().catch(async err => {
  console.error('Fatal:', err.message);
  await sendErrorAlert(err);
  process.exit(1);
});
