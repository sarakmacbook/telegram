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
import { ensureWebhook } from '../src/webhook.mjs';

let appPromise = null;
const getApp = () => (appPromise ??= createApp({ env: process.env }));
const hasBotToken = () => [process.env.BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN]
  .some((value) => String(value ?? '').trim().length > 0);

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  if ((req.method || '').toUpperCase() !== 'POST') {
    return res.status(405).send(JSON.stringify({ ok: false, error: 'use POST' }));
  }
  if (!hasBotToken()) {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'BOT_TOKEN must be configured in Vercel Environment Variables before webhook setup' }));
  }

  const app = await getApp();
  if (!app.cfg.webhookSecret) {
    return res.status(503).send(JSON.stringify({ ok: false, error: 'WEBHOOK_SECRET must be configured before setup' }));
  }
  if (req.headers['x-telegram-bot-api-secret-token'] !== app.cfg.webhookSecret) {
    return res.status(403).send(JSON.stringify({ ok: false, error: 'wrong x-telegram-bot-api-secret-token' }));
  }

  try {
    const info = await ensureWebhook(app, { dropPendingUpdates: (req.query?.drop || '') === '1' });
    return res.status(200).send(JSON.stringify({ ok: true, webhookInfo: info }));
  } catch (error) {
    return res.status(400).send(JSON.stringify({ ok: false, error: error.message }));
  }
}
