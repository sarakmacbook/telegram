/**
 * Vercel serverless entry point: Telegram posts Updates here.
 * Set WEBHOOK_URL to https://<your-project>.vercel.app/api/webhook
 */

import { createApp } from '../src/app.mjs';
import { resolveTokenEnvironment } from '../src/token-store.mjs';
import { handleTelegramWebhook } from '../src/webhook.mjs';

const MAX_BODY_BYTES = 1_000_000;
const hasBotToken = (env) => [env.BOT_TOKEN, env.TELEGRAM_BOT_TOKEN]
  .some((value) => String(value ?? '').trim().length > 0);

async function requestBody(req, res) {
  // Vercel may provide an already-parsed body. Preserve raw strings, and
  // serialise parsed JSON objects back into the format the common handler uses.
  if (req.body !== undefined && req.body !== null) {
    const body = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      res.status(413).send('Request body too large\n');
      return null;
    }
    return body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.status(413).send('Request body too large\n');
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.status(405).send('POST an Update to /api/webhook');
  }
  const expectedSecret = String(process.env.WEBHOOK_SECRET || '').trim();
  if (!expectedSecret) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.status(503).send(JSON.stringify({ ok: false, error: 'WEBHOOK_SECRET must be configured' }));
  }
  if (req.headers?.['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.status(403).send('Forbidden');
  }

  let env;
  try {
    env = await resolveTokenEnvironment(process.env);
  } catch {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.status(503).send(JSON.stringify({ ok: false, error: 'bot token storage is unavailable or misconfigured' }));
  }
  if (!hasBotToken(env)) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.status(503).send(JSON.stringify({ ok: false, error: 'BOT_TOKEN must be configured in Vercel or saved from the settings page before webhook processing' }));
  }

  const app = await createApp({ env });

  // Check the body after authenticating to avoid spending Redis/API work on
  // unauthenticated public webhook requests.
  const body = await requestBody(req, res);
  if (body === null) return;

  const result = await handleTelegramWebhook(
    { method: req.method, url: req.url, headers: req.headers, body },
    app,
  );

  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.send(result.body);
}
