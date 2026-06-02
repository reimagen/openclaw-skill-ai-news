# openclaw-skill-ai-news

An [OpenClaw](https://openclaw.ai) skill that delivers a daily AI news digest to Telegram. Four sections, up to 8 stories each, headline + link format. Runs every morning.

Published as part of the [30 Days of AI Systems](https://reimagen.ai) series.

## What it does

Every morning it pulls AI news from three sources, deduplicates across them, and sends a clean digest to your Telegram:

- **RSS feeds** — official lab blogs (OpenAI, Google DeepMind, Hugging Face, Cohere, Meta AI)
- **HackerNews** — stories scoring 75+ points in the last 48 hours
- **Gemini 2.5 Flash with Google Search** — fills gaps for labs with no RSS (Anthropic, xAI, Mistral, Chinese labs)

**Sections:**
- 🏢 Official Labs — OpenAI, Anthropic, Google DeepMind, Meta AI, xAI/Grok
- 🧠 Models — new releases and updates, including the watch list below
- ⚡ Agents — agentic frameworks, tooling, coding assistants
- 💼 Industry — funding, policy, regulation, deals

**Watch list** (edit `config.json` to customize):
- Video: Runway, Kling, Luma, Hailuo, MiniMax, Veo, Wan, Sora, Seedance
- Image: Midjourney, Flux, Black Forest Labs, Stability AI, Ideogram, Imagen
- Audio/Voice: ElevenLabs, Suno, Udio, HeyGen, Hedra
- Platforms: Higgsfield, Freepik, ComfyUI, OpenArt, Artlist
- Chinese labs: DeepSeek, ByteDance, Doubao, Qwen, Alibaba, Kimi, Moonshot

## Files

- `fetch-ai-news.js` — main script, run this daily via cron
- `suggest-watchlist.js` — optional monthly script that suggests new companies to add to your watch list
- `config.json` — watch list and RSS feed config

## Setup

### 1. Get your API keys

- **Gemini API key** — [aistudio.google.com](https://aistudio.google.com) (free tier works)
- **Telegram bot token** — create a bot via [@BotFather](https://t.me/BotFather) on Telegram
- **Telegram chat ID** — add your bot to a chat/group and get the ID (easiest way: send a message and check `https://api.telegram.org/bot<TOKEN>/getUpdates`)

### 2. Configure environment

```bash
cp .env.example .env
# fill in your values
```

Or set env vars directly in your cron or service config.

`TELEGRAM_THREAD_ID` is only needed if you're using a Telegram supergroup with topics — leave it blank for regular chats or groups.

### 3. Install

No npm packages needed — pure Node.js with stdlib only.

```bash
node --version  # requires Node 18+
```

### 4. Test it

```bash
GEMINI_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node fetch-ai-news.js
```

Check `logs/ai-news.log` if something goes wrong.

### 5. Schedule it

Add to crontab to run daily at 7am in your timezone:

```
# Example: 7am Pacific time daily
0 15 * * * cd /path/to/openclaw-skill-ai-news && GEMINI_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node fetch-ai-news.js >> logs/cron.log 2>&1
```

Or use `CRON_TZ` if your cron supports it:

```
CRON_TZ=America/Los_Angeles
0 7 * * * cd /path/to/openclaw-skill-ai-news && ...
```

### Optional: monthly watch list review

`suggest-watchlist.js` runs once a month and sends you a Telegram message suggesting new companies to add to your watch list. Same env vars, same setup — just schedule it on the 1st of each month.

## Customizing the watch list

Edit `config.json` to add or remove companies from the Models section watch list. Changes take effect on the next run — no restart needed.

## Why Gemini for search?

Anthropic, xAI, Mistral, and Chinese labs don't have public RSS feeds. Gemini's Google Search grounding is the most reliable way to catch their announcements from the last 24 hours without hallucination. The Gemini free tier is sufficient for this use case.

## License

MIT
