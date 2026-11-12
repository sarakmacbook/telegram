/** Save or replace the encrypted bot-token override. */

import { createTokenStore, inspectTokenSetup, verifySetupPassword } from '../src/token-store.mjs';

const MAX_BODY_BYTES = 4096;
const MAX_TOKEN_LENGTH = 512;

function setHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
}

function responsePage(title, message, link = '/') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#10151b;color:#e9f0f6;font:16px/1.6 system-ui,sans-serif}main{width:min(100%,560px);padding:32px;border:1px solid #2a3642;border-radius:18px;background:#19212a}p{color:#a3b0bd}a{color:#68b7ff}</style></head><body><main><h1>${title}</h1><p>${message}</p><a href="${link}">Return to token settings</a></main></body></html>`;
}

function response(res, status, title, message) {
  return res.status(status).send(responsePage(title, message));
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const encoded = JSON.stringify(req.body);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) throw new RangeError('body too large');
      return req.body;
    }
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new RangeError('body too large');
    return text;
  }

  if (!req?.[Symbol.asyncIterator]) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseFields(body, contentType = '') {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = String(body ?? '');
  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function validToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(token);
}

export function createTokenHandler({ env = process.env, createStore = (options) => createTokenStore(options) } = {}) {
  return async function handler(req, res) {
    setHeaders(res);
    if ((req.method || '').toUpperCase() !== 'POST') {
      return response(res, 405, 'Use the token form', 'Submit the form from the bot settings page.');
    }
    if (!sameOrigin(req)) {
      return response(res, 403, 'Request rejected', 'Submit this change from the bot settings page.');
    }

    const setup = inspectTokenSetup(env);
    if (!setup.ready) {
      return response(res, 503, 'Setup is not ready', 'Configure the Redis store, encryption key, and setup password in Vercel before saving a token.');
    }

    let fields;
    try {
      fields = parseFields(await readBody(req), String(req.headers?.['content-type'] || '').toLowerCase());
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      return response(res, status, status === 413 ? 'Request too large' : 'Invalid form', 'The token could not be saved. Return to the settings page and try again.');
    }

    const password = typeof fields.setupPassword === 'string' ? fields.setupPassword : '';
    if (!verifySetupPassword(password, String(env.BOT_TOKEN_SETUP_PASSWORD ?? ''))) {
      return response(res, 403, 'Setup password not accepted', 'The bot token was not changed. Check the setup password and try again.');
    }

    const token = typeof fields.botToken === 'string' ? fields.botToken.trim() : '';
    if (!validToken(token)) {
      return response(res, 400, 'Invalid bot token', 'The token must be non-empty, contain no spaces, and be at most 512 characters.');
    }

    try {
      const store = createStore({ env });
      await store.setToken(token);
      return response(res, 200, 'Bot token saved', 'The encrypted token will be used for future bot requests and takes precedence over the Vercel BOT_TOKEN environment variable. The token value is never returned.');
    } catch {
      return response(res, 503, 'Could not save token', 'The token store could not confirm the save. Check the Redis connection and try again; the token value was not included in this response.');
    }
  };
}

export default createTokenHandler();
