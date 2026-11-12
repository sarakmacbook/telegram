/**
 * Webhook transport: one framework-agnostic request handler (used by the
 * Vercel function and by the local server) plus webhook registration helpers.
 */

import http from 'node:http';
import { ALLOWED_UPDATES } from './handlers.mjs';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

const json = (status, payload, extraHeaders = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  body: JSON.stringify(payload),
});

const text = (status, body, extraHeaders = {}) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  body,
});

/**
 * @param {{method:string, url:string, headers:object, body?:string}} request
 * @param {object} app  from src/app.mjs
 */
export async function handleTelegramWebhook(request, app) {
  const { cfg, log } = app;
  const method = (request.method || 'GET').toUpperCase();
  const path = (request.url || '/').split('?')[0];

  if (method !== 'POST') return text(405, `POST an Update to ${cfg.webhookPath || '/api/webhook'}\n`);

  if (cfg.webhookSecret) {
    const provided = String(request.headers?.[SECRET_HEADER] ?? '');
    if (provided !== cfg.webhookSecret) {
      log.warn('webhook secret mismatch', { path });
      return text(403, 'Forbidden\n');
    }
  }

  let update;
  try {
    update = JSON.parse(request.body || '');
  } catch (error) {
    log.warn('webhook body is not JSON', { error: error.message });
    return json(400, { ok: false, error: 'invalid JSON body' });
  }

  try {
    await app.bot.handleUpdate(update);
  } catch (error) {
    // Acknowledge anyway: Telegram retries non-2xx forever and the update would
    // be replayed on every retry. The error is already in the logs.
    log.error('webhook update failed', { error: error.message, updateId: update?.update_id });
  }
  return json(200, { ok: true });
}

/** Registers the webhook with Telegram, including the widget update types. */
export async function ensureWebhook(app, { dropPendingUpdates = false } = {}) {
  const { cfg, api, log } = app;
  if (!cfg.webhookUrl) throw new Error('WEBHOOK_URL is not set — e.g. https://<project>.vercel.app/api/webhook');
  if (cfg.webhookSecret && !SECRET_RE.test(cfg.webhookSecret)) {
    throw new Error('WEBHOOK_SECRET must be 1-256 characters from A-Z a-z 0-9 - _');
  }

  await api.setWebhook({
    url: cfg.webhookUrl,
    secret_token: cfg.webhookSecret || undefined,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: 40,
    drop_pending_updates: dropPendingUpdates,
  });

  const info = await api.getWebhookInfo();
  log.info('webhook registered', {
    url: info?.url,
    allowedUpdates: ALLOWED_UPDATES.join(','),
    pending: info?.pending_update_count,
    lastError: info?.last_error_message || null,
  });
  return info;
}

export function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Local HTTP server (webhook mode and dev mode). `route` may handle a request
 * first and return true; anything left over goes to the webhook handler.
 */
export function createHttpServer({ app, route, webhookPath = '/webhook', host = '0.0.0.0' }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = ({ status = 200, headers = {}, body = '' }) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    try {
      if (route && (await route({ req, res, url, send }))) return;

      if (url.pathname === webhookPath || url.pathname === '/api/webhook' || url.pathname === app.cfg.webhookPath) {
        const body = req.method === 'POST' ? await readBody(req) : '';
        const result = await handleTelegramWebhook(
          { method: req.method, url: req.url, headers: req.headers, body },
          app,
        );
        return send(result);
      }

      if (url.pathname === '/health') {
        return send(json(200, { ok: true, service: 'okx-p2p-widget-bot' }));
      }

      return send(text(404, 'Not found\n'));
    } catch (error) {
      app.log.error('http request failed', { path: url.pathname, error: error.message });
      if (!res.headersSent) send(json(500, { ok: false, error: error.message }));
      else res.end();
    }
  });

  server.listen(app.cfg.port, host);
  return server;
}
