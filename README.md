# Telegram HTML widget bot

A zero-dependency Node.js bot that sends the repository's `index.html` as a Telegram Bot API **10.4** widget with `sendWidget`. The card displays OKX P2P merchant offers, and its buttons send `refresh` or `offer:<id>` requests to the bot through `TelegramWidget.request()`.

The widget itself has no network access. The bot supplies offers in `chat_data` (private card) or `public_data` (shared `/live` card), answers each widget query, and edits the widget data to repaint the card. This project does **not** execute trades and is not affiliated with OKX.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather) for real bot use
- A Telegram client that supports Bot API 10.4 widgets

Widgets are currently available in private bot chats in production; sending `/widget` in a group will show a private-chat notice instead.

## Quick start

```sh
cp .env.example .env
# Edit .env and set BOT_TOKEN
npm run build
npm start
```

Open the bot in Telegram and send `/start` or `/widget`. Long polling is the default for local use. If Telegram reports a 409 conflict because a webhook is active, remove it first:

```sh
npm run unset-webhook
npm start
```

### No-token preview

Run the interactive preview without a Telegram token:

```sh
npm run dev
```

Open `http://localhost:3000`. The preview includes the HTML widget in a bubble, a mock Bot API, buttons for bot commands and inline callbacks, a state view, and a log of Bot API calls. Tapping **Refresh** or a merchant exercises the same handlers used by the real bot.

## Offers feed

With `FEED_URL` empty, the bot uses a deterministic built-in **sample** feed and labels it as sample data. It is for preview/testing only; those merchant names and prices are not live market data.

To provide real offers, set `FEED_URL` to your own HTTPS JSON endpoint. The bot accepts an array or an object containing an `offers`, `data`, or `result` array. For example:

```json
{
  "offers": [
    {
      "id": "adv-123",
      "name": "Example Merchant",
      "verified": true,
      "orders": 1240,
      "completion": "99.2%",
      "price": "1.0012",
      "currency": "USD",
      "min": 100,
      "max": 2000,
      "payment": ["Bank transfer", "Wing"]
    }
  ]
}
```

Common field aliases are normalised by `src/widget.mjs` (`merchantName`/`advName`, `orderCount`, `completionRate`, `unitPrice`, `ccy`, `paymentMethods`, and others). The endpoint should return only offers you are entitled to publish and should identify its source accurately. On a feed error, the bot uses its last good response if one exists; otherwise it falls back to labelled sample data.

Relevant settings: `FEED_TIMEOUT_MS` (500–8000 ms) and `FEED_CACHE_MS` (0–3,600,000 ms). Widget refresh taps bypass the feed cache.

## Commands

- `/start` — greeting, command buttons, and a private merchant card
- `/widget` — send a private card with per-chat `chat_data`
- `/live` — send a shared widget with `public_data` (all instances of that shared widget use the same state)
- `/resend` — send the last known shared widget again by ID
- `/refresh` — refresh the last card in the chat
- `/feed` — show feed source and state size
- `/id` — show chat and user IDs
- `/help` — command list

The widget's **Refresh** button fetches offers and edits its state. Tapping **View offer** returns that merchant's details in the widget's query response. Shared-widget edits are serialized and throttled to one per second per running bot instance, as required by Telegram.

## Deploy to Vercel (webhook mode)

The same codebase exposes Vercel functions at `/api/webhook`, `/api/setup`, and `/api/index` (the root `/` rewrites to the status endpoint). Polling is for local/VPS use; Vercel uses the webhook entrypoint.

1. Import this repository into Vercel, using the repository root as the project root. The included `vercel.json` runs `npm run build`, bundles the widget HTML for the serverless functions, and uses `public` as its output directory. The build ensures `public/robots.txt` exists so the static output is non-empty; API routes and `/` remain handled by serverless functions.
2. Add these environment variables to the Vercel project (Production, and Preview if needed):
   - `BOT_TOKEN` — token from @BotFather
   - `WEBHOOK_URL` — the exact public endpoint, e.g. `https://<project>.vercel.app/api/webhook`
   - `WEBHOOK_SECRET` — a random 1–256 character string using only letters, digits, `_` or `-` (for example, generate one with `openssl rand -hex 32`)
   - Optional: `FEED_URL`, `MAX_OFFERS`, `SHARED_CACHE_TIME`
3. Deploy. Register the webhook once, passing the same secret in the request header:

   ```sh
   curl -X POST 'https://<project>.vercel.app/api/setup' \
     -H "x-telegram-bot-api-secret-token: $WEBHOOK_SECRET"
   ```

   `/api/setup` calls Telegram `setWebhook` with `widget_query` and `shared_widget_query` in `allowed_updates`. The webhook handler rejects requests with a missing or incorrect secret and acknowledges valid updates so Telegram does not replay them indefinitely.

4. Check `https://<project>.vercel.app/` for configuration and webhook status. Do not expose or commit your bot token or webhook secret.

If `BOT_TOKEN` is missing, the root URL shows a setup page explaining where to configure it. The page intentionally has no token input; add secrets only in Vercel Project Settings → Environment Variables, then redeploy.

For the `/resend` command to survive Vercel cold starts, set `SHARED_WIDGET_ID` after the first `/live` card has been sent. Without it, `/live` still works; its in-memory ID may simply be forgotten after a cold start.

## Configuration

See [`.env.example`](.env.example) for all settings. Local commands load `.env` and `.env.local`; Vercel reads project environment variables.

- `BOT_TOKEN` — required for real polling/webhook operation
- `WIDGET_PATH` — widget source, default `index.html`
- `MAX_OFFERS` — max offers per card, default 3
- `WIDGET_WIDTH` / `WIDGET_HEIGHT` — optional logical dimensions
- `FEED_URL`, `FEED_TIMEOUT_MS`, `FEED_CACHE_MS` — optional feed configuration
- `SHARED_CACHE_TIME` — shared widget client cache, 5–3600 seconds
- `SHARED_WIDGET_ID` — optional shared ID to persist `/resend` across cold starts
- `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_PATH`, `AUTO_SET_WEBHOOK` — webhook settings
- `PORT`, `LOG_LEVEL`, `LOG_FORMAT`, `TELEGRAM_API_ROOT` — runtime settings

## Widget limits and compatibility

The build and tests verify the limits enforced by the Bot API/widget profile:

- HTML: at most 32,768 UTF-8 bytes raw and 4,096 bytes after zlib level 9
- Each `chat_data` / `public_data` value: at most 1,024 UTF-8 bytes; no NUL
- Widget query data: 1–64 bytes; query answers must arrive within 15 seconds
- Bubble: at most 600 px high; content does not scroll, so the widget hides extra cards that would overflow
- No network in widget HTML; the Telegram client injects `window.TelegramWidget` (do not load the Mini App SDK or call `TelegramWidget.ready()`)

The widget is validated and bundled from `index.html` during the build. `src/generated/widget-html.mjs` is generated and ignored by Git.

## Build and tests

```sh
npm run build     # validate size and create the serverless HTML bundle
npm run check     # fail if index.html is invalid or the bundle is stale
npm test          # node:test suite with the mock Telegram API
```

The tests cover payload budgets, HTML validation, offer normalisation, fallback feeds, private-chat restrictions, widget-query handling, shared-state updates, webhook authentication, and no-op edit handling.
