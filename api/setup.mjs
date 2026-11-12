/**
 * Vercel: register the webhook with Telegram, including widget_query and
 * shared_widget_query in allowed_updates.
 *
 *   curl -X POST https://<project>.vercel.app/api/setup \
 *        -H "x-telegram-bot-api-secret-token: $WEBHOOK_SECRET"
 *
 * When WEBHOOK_SECRET is set the same value must be sent in that header, so
 * nobody else can point your bot at a different URL.
 */

import { createApp } from '../src/app.mjs';
import { resolveTokenEnvironment } from '../src/token-store.mjs';
import { ensureWebhook } from '../src/webhook.mjs';

const hasBotToken = (env) => [env.BOT_TOKEN, env.TELEGRAM_BOT_TOKEN]
  .some((value) => String(value ?? '').trim().length > 0);

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  if ((req.method || '').toUpperCase() !== 'POST') {
    return res.status(405).send(JSON.stringify({ ok: false, error: 'use POST' }));
  }
  const expectedSecret = String(process.env.WEBHOOK_SECRET || '').trim();
  if (!expectedSecret) {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'WEBHOOK_SECRET must be configured before setup' }));
  }
  if (req.headers?.['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    return res.status(403).send(JSON.stringify({ ok: false, error: 'wrong x-telegram-bot-api-secret-token' }));
  }

  let env;
  try {
    env = await resolveTokenEnvironment(process.env);
  } catch {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'bot token storage is unavailable or misconfigured' }));
  }
  if (!hasBotToken(env)) {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'BOT_TOKEN must be configured in Vercel or saved from the settings page before webhook setup' }));
  }

  const app = await createApp({ env });

  try {
    const info = await ensureWebhook(app, { dropPendingUpdates: (req.query?.drop || '') === '1' });
    return res.status(200).send(JSON.stringify({ ok: true, webhookInfo: info }));
  } catch (error) {
    return res.status(400).send(JSON.stringify({ ok: false, error: error.message }));
  }
}
