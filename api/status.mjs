/** JSON status endpoint; the public root serves the token settings UI. */

import { createApp, describeApp } from '../src/app.mjs';
import { resolveTokenEnvironment } from '../src/token-store.mjs';

function hasBotToken(env) {
  return [env.BOT_TOKEN, env.TELEGRAM_BOT_TOKEN].some((value) => String(value ?? '').trim().length > 0);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).send(JSON.stringify({ ok: false, error: 'use GET' }));
  }

  let env;
  try {
    env = await resolveTokenEnvironment(process.env);
  } catch {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'bot token storage is unavailable or misconfigured' }));
  }
  if (!hasBotToken(env)) {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'no bot token is configured; open / to configure one' }));
  }

  try {
    const app = await createApp({ env });
    const description = await describeApp(app);
    const webhook = await app.api.getWebhookInfo().catch((error) => ({ error: error.message }));
    return res.status(200).send(JSON.stringify({
      service: 'okx-p2p-widget-bot',
      botApi: '10.4 (widgets)',
      ...description,
      webhookInfo: webhook,
      next: {
        settings: 'GET /',
        webhook: 'POST /api/webhook (Telegram only)',
        setup: 'POST /api/setup to register the webhook',
        local: 'npm run dev for the widget preview, npm start for polling',
      },
    }, null, 2));
  } catch {
    return res.status(500).send(JSON.stringify({ ok: false, error: 'status could not be generated' }));
  }
}
