/**
 * Vercel: deployment status. GET /api (rewritten from /).
 */

import { createApp, describeApp } from '../src/app.mjs';

let appPromise = null;
const getApp = () => (appPromise ??= createApp({ env: process.env }));

export default async function handler(req, res) {
  try {
    const app = await getApp();
    const description = await describeApp(app);
    const webhook = app.cfg.token
      ? await app.api.getWebhookInfo().catch((error) => ({ error: error.message }))
      : null;

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(
      JSON.stringify(
        {
          service: 'okx-p2p-widget-bot',
          botApi: '10.4 (widgets)',
          ...description,
          webhookInfo: webhook,
          next: {
            webhook: 'POST /api/webhook (Telegram only)',
            setup: 'POST /api/setup to register the webhook',
            local: 'npm run dev for the widget preview, npm start for polling',
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    res.status(500).send(JSON.stringify({ ok: false, error: error.message }));
  }
}
