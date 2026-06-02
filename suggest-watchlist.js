#!/usr/bin/env node
/**
 * suggest-watchlist: Monthly review of ai-news watch list.
 * Calls Gemini to find emerging AI companies not yet in config.json.
 * Sends suggestions to Telegram — you decide what to add to config.json.
 * Cron: 1st of each month, 8am PST (16:00 UTC)
 */

const { spawnSync } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;       // your Telegram chat/group ID
const THREAD_ID = process.env.TELEGRAM_THREAD_ID    // topic/thread ID (supergroups only — omit if not using topics)
  ? parseInt(process.env.TELEGRAM_THREAD_ID, 10)
  : undefined;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const ALL_CURRENT = Object.values(config.watch).flat().join(', ');

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function geminiSearch(prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
  });
  const json = await httpsPost('generativelanguage.googleapis.com',
    '/v1beta/models/gemini-2.5-flash:generateContent',
    { 'x-goog-api-key': GEMINI_API_KEY }, body);
  if (!json.candidates?.[0]) throw new Error(`Gemini error: ${JSON.stringify(json).substring(0, 500)}`);
  return json.candidates[0].content.parts[0].text.trim();
}

async function sendTelegram(text) {
  const payload = { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (THREAD_ID) payload.message_thread_id = THREAD_ID;
  const body = JSON.stringify(payload);
  const json = await httpsPost('api.telegram.org', `/bot${BOT_TOKEN}/sendMessage`, {}, body);
  if (!json.ok) throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');

  console.log('Running monthly watch list review...');

  const prompt = `You are an AI industry analyst doing a monthly review of companies to watch.

The current watch list already includes: ${ALL_CURRENT}

Using Google Search, identify up to 3 emerging or newly notable companies or models in EACH of these categories that are NOT already in the list above:

- video (AI video generation)
- image (AI image generation)
- audio (AI voice, music, sound generation)
- platforms (AI creative tools, workflows, marketplaces)
- chinese (Chinese AI labs releasing notable models)

Criteria for inclusion:
- Active in the last 30 days (new release, funding, or significant buzz)
- Not already in the current watch list
- Worth tracking for AI news — genuinely notable, not obscure

Return ONLY a valid JSON object — no markdown, no code fences, no extra text:
{
  "video":     [{"name": "...", "reason": "..."}],
  "image":     [{"name": "...", "reason": "..."}],
  "audio":     [{"name": "...", "reason": "..."}],
  "platforms": [{"name": "...", "reason": "..."}],
  "chinese":   [{"name": "...", "reason": "..."}]
}

Keep reasons under 10 words. If nothing new and notable exists for a category, return an empty array.`;

  console.log('Calling Gemini...');
  const raw = await geminiSearch(prompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  const suggestions = JSON.parse(cleaned);

  const categoryLabels = {
    video:     '🎬 Video',
    image:     '🖼 Image',
    audio:     '🎵 Audio',
    platforms: '🛠 Platforms',
    chinese:   '🇨🇳 Chinese Labs',
  };

  const lines = [];
  for (const [key, label] of Object.entries(categoryLabels)) {
    const items = suggestions[key] || [];
    if (items.length === 0) continue;
    lines.push(`\n${label}`);
    for (const item of items) {
      lines.push(`• <b>${escapeHtml(item.name)}</b> — ${escapeHtml(item.reason)}`);
    }
  }

  if (lines.length === 0) {
    await sendTelegram('🔍 <b>Monthly watch list review</b>\n\nNo new candidates found this month.');
    console.log('No suggestions. Done.');
    return;
  }

  const message = `🔍 <b>Monthly watch list review</b>\n\nNew candidates to consider:${lines.join('\n')}\n\n<i>Tell me which ones to add and I'll update config.json.</i>`;
  await sendTelegram(message);
  console.log('Suggestions sent. Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  try {
    await sendTelegram(`⚠️ <b>Watch list review failed</b>\n${escapeHtml(err.message.substring(0, 300))}`);
  } catch (e) {}
  process.exit(1);
});
