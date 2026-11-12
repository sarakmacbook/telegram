/**
 * Widget HTML loading, validation against the Telegram widget profile, and
 * packing of widget state into the 1024-byte chat_data / public_data budget.
 *
 * Limits (Bot API 10.4):
 *   html          1-32768 bytes, at most 4096 bytes after zlib level 9
 *   chat_data     0-1024 bytes        public_data  0-1024 bytes
 *   request data  1-64 bytes          answer data  0-1024 bytes
 *   bubble        200-600 px wide, content clipped at 600 px of height
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const WIDGET_LIMITS = Object.freeze({
  htmlBytes: 32768,
  htmlCompressedBytes: 4096,
  dataBytes: 1024,
  queryDataBytes: 64,
  answerBytes: 1024,
  bubbleMaxHeight: 600,
});

/** The id shape the widget's own buttons accept (see index.html). */
export const OFFER_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

export const byteLength = (value) => Buffer.byteLength(String(value ?? ''), 'utf8');

/** Exactly how the Telegram server measures the HTML budget. */
export function compressedSize(html) {
  return deflateSync(Buffer.from(String(html), 'utf8'), { level: 9 }).length;
}

/**
 * Static sanity check of widget HTML. Returns { rawBytes, compressedBytes,
 * errors, warnings } — errors are things Telegram refuses or that break the
 * widget, warnings are things the client silently removes.
 */
export function validateWidgetHtml(html) {
  const errors = [];
  const warnings = [];
  const rawBytes = byteLength(html);
  const compressedBytes = compressedSize(html);

  if (rawBytes < 1) errors.push('html is empty');
  if (rawBytes > WIDGET_LIMITS.htmlBytes) {
    errors.push(`html is ${rawBytes} bytes, over the ${WIDGET_LIMITS.htmlBytes}-byte limit`);
  }
  if (compressedBytes > WIDGET_LIMITS.htmlCompressedBytes) {
    errors.push(`html compresses to ${compressedBytes} bytes, over the ${WIDGET_LIMITS.htmlCompressedBytes}-byte zlib limit`);
  }
  if (html.includes('\u0000')) errors.push('html contains NUL (U+0000): INPUT_MEDIA_WIDGET_HTML_INVALID');

  // Widgets have no network at all: these are stripped by every client.
  if (/<script[^>]+src\s*=/i.test(html)) {
    warnings.push('external <script src> is removed in the widget sandbox (no network); TelegramWidget is injected by the client');
  }
  if (/<link\b/i.test(html)) warnings.push('<link> is removed in the widget sandbox');
  if (/<meta\b/i.test(html)) warnings.push('<meta> is removed in the widget sandbox (harmless)');
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/.test(html)) {
    warnings.push('network APIs are stubs inside a widget — route data through the bot instead');
  }
  if (/<(input|select|textarea|form|option|label|fieldset)\b/i.test(html)) {
    warnings.push('form controls are removed with their content by the widget profile');
  }
  if (/<(iframe|object|embed|audio|video|template|dialog)\b/i.test(html)) {
    warnings.push('iframe/object/embed/audio/video/template/dialog are removed by the widget profile');
  }
  if (/@font-face/.test(html)) warnings.push('@font-face is removed; only system font families work');
  if (/\d+vh\b/.test(html)) warnings.push('vh units are removed; use %, flex, grid, vw/vmin');
  if (/overflow\s*:\s*(auto|scroll)/.test(html)) warnings.push('overflow auto/scroll becomes hidden — nothing scrolls in a widget');
  if (/position\s*:\s*sticky/.test(html)) warnings.push('position: sticky becomes relative');
  if (/<img[^>]+src\s*=\s*["'](?!data:)/i.test(html)) warnings.push('images must be data: URLs or inline SVG');

  return { rawBytes, compressedBytes, errors, warnings };
}

/**
 * Loads the widget HTML: the bundled module produced by `npm run build` first
 * (that is what Vercel traces into the function), then the file on disk.
 */
let cached = null;

export async function loadWidgetHtml({ widgetPath = 'index.html', log } = {}, force = false) {
  if (cached && !force) return cached;

  try {
    const mod = await import('./generated/widget-html.mjs');
    if (typeof mod.widgetHtml === 'string' && mod.widgetHtml) {
      cached = { html: mod.widgetHtml, source: 'bundle', ...validateWidgetHtml(mod.widgetHtml) };
      log?.debug?.('widget html loaded from bundle', { bytes: cached.rawBytes, zlib: cached.compressedBytes });
      return cached;
    }
  } catch {
    /* not built yet — fall through to disk */
  }

  const candidates = [
    path.resolve(widgetPath),
    path.resolve(ROOT, widgetPath),
    path.resolve(process.cwd(), widgetPath),
    path.resolve('/var/task', widgetPath),
    path.resolve(HERE, widgetPath),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate)) {
      const html = await readFile(candidate, 'utf8');
      cached = { html, source: candidate, ...validateWidgetHtml(html) };
      log?.debug?.('widget html loaded from disk', { path: candidate, bytes: cached.rawBytes, zlib: cached.compressedBytes });
      return cached;
    }
  }

  throw new Error(
    `Widget HTML not found (${widgetPath}). Run \`npm run build\` or check WIDGET_PATH. Looked in: ${candidates.join(', ')}`,
  );
}

/** Throws when the HTML cannot be sent as a widget. */
export function assertSendable(widget) {
  if (widget.errors?.length) throw new Error(`Widget HTML rejected: ${widget.errors.join('; ')}`);
  return widget;
}

// ── State packing ─────────────────────────────────────────────────────────

/** Normalises one offer from any source into the shape index.html renders. */
export function sanitizeOffer(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };
  const text = (value, fallback = '') => (value === undefined ? fallback : String(value).replace(/\s+/g, ' ').trim());

  const name = text(pick('name', 'merchant', 'merchantName', 'nickname', 'advName', 'userName', 'title'), 'Merchant');
  let id = text(pick('id', 'offerId', 'advNo', 'tradeId', 'offer_id'), '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  if (!id) id = `o${index + 1}-${Math.abs(hashCode(name)).toString(36).slice(0, 6)}`;
  if (!OFFER_ID_RE.test(id)) return null;

  const currency = text(pick('currency', 'ccy', 'fiat', 'cur'), 'USD').slice(0, 6).toUpperCase();
  const payments = pick('payment', 'payments', 'paymentMethod', 'method', 'paymentMethods');
  const payment = Array.isArray(payments) ? payments.map((p) => text(p)).filter(Boolean).join(', ') : text(payments);

  const min = pick('min', 'minAmount', 'availableMin');
  const max = pick('max', 'maxAmount', 'availableMax');
  let limit = text(pick('limit', 'limits', 'range', 'minMax'));
  if (!limit && min !== undefined && max !== undefined) limit = `${group(min)}–${group(max)} ${currency}`;

  return {
    id,
    name: name.slice(0, 32),
    verified: pick('verified', 'isVerified', 'kyc', 'checked') === true || pick('verified', 'isVerified') === 'true',
    orders: text(pick('orders', 'orderCount', 'trades', 'completedOrders', 'count')),
    completion: withPercent(text(pick('completion', 'completionRate', 'finishRate', 'successRate', 'percent'))),
    price: number(pick('price', 'unitPrice', 'avgPrice')),
    currency,
    limit: limit.slice(0, 28),
    payment: payment.slice(0, 32),
  };
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

function number(value) {
  if (value === undefined || value === null || value === '') return '';
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return text(value);
  return String(Math.round(parsed * 10000) / 10000);
}

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).replace(/\s+/g, ' ').trim();
}

/** Thousands separators, the way the widget's own example state formats them. */
function group(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(parsed)) return text(value);
  return parsed.toLocaleString('en-US');
}

function withPercent(value) {
  if (!value) return '';
  if (value.includes('%')) return value.slice(0, 8);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return value.slice(0, 8);
  return `${Math.round(parsed * 10) / 10}%`;
}

/**
 * Field sets from richest to leanest. The widget falls back to "—" for any
 * field that is missing, so dropping fields degrades gracefully.
 */
const FIELD_LADDER = [
  ['id', 'name', 'verified', 'orders', 'completion', 'price', 'currency', 'limit', 'payment'],
  ['id', 'name', 'verified', 'orders', 'completion', 'price', 'currency', 'limit'],
  ['id', 'name', 'verified', 'completion', 'price', 'currency', 'limit'],
  ['id', 'name', 'verified', 'price', 'currency', 'limit'],
  ['id', 'name', 'price', 'currency'],
];

const encodeState = (updated, revision, offers, fields) =>
  JSON.stringify({
    updated,
    r: revision,
    offers: offers.map((offer) => {
      const out = {};
      for (const field of fields) {
        const value = offer[field];
        if (field === 'verified') { if (value === true) out.verified = true; continue; }
        if (value === undefined || value === null || value === '') continue;
        out[field] = value;
      }
      return out;
    }),
  });

/**
 * Serialises widget state so that it fits the 1024-byte budget: drops offers,
 * then optional fields, until it fits. Returns { json, bytes, offers, dropped }.
 */
export function packWidgetState({ offers, updated = '', r = 0, maxOffers = 3, limit = WIDGET_LIMITS.dataBytes }) {
  const clean = (offers || []).map((offer, i) => (offer.id && offer.name ? offer : sanitizeOffer(offer, i))).filter(Boolean);
  const wanted = Math.max(1, maxOffers);
  const slice = clean.slice(0, wanted);

  for (let count = slice.length; count >= 1; count -= 1) {
    for (const fields of FIELD_LADDER) {
      const json = encodeState(String(updated).slice(0, 40), r, slice.slice(0, count), fields);
      const bytes = byteLength(json);
      if (bytes <= limit) {
        return { json, bytes, offers: count, dropped: Math.max(0, clean.length - count), fields: fields.length };
      }
    }
  }

  // Last resort: a single offer with the leanest shape, truncated hard.
  const first = slice[0] || { id: 'none', name: 'No offers', price: '', currency: 'USD' };
  const json = JSON.stringify({ updated: '', r, offers: [{ id: String(first.id).slice(0, 24), name: String(first.name).slice(0, 16), price: String(first.price ?? '').slice(0, 10), currency: String(first.currency ?? 'USD').slice(0, 3) }] });
  if (byteLength(json) > limit) throw new Error(`Cannot fit any widget state into ${limit} bytes`);
  return { json, bytes: byteLength(json), offers: 1, dropped: Math.max(0, clean.length - 1), fields: 4 };
}

/** Builds the short status text returned by answerWidgetQuery (max 1024 bytes). */
export function statusText({ offers, updated, sample, dropped = 0, limit = WIDGET_LIMITS.answerBytes }) {
  const noun = offers === 1 ? 'merchant' : 'merchants';
  const base = `${sample ? 'Sample feed' : 'Offers'} · ${offers} ${noun} · ${updated}`;
  const suffix = dropped > 0 ? ` · ${dropped} not shown` : '';
  return clip(`${base}${suffix}`, limit);
}

export function clip(value, limit) {
  const str = String(value ?? '');
  if (byteLength(str) <= limit) return str;
  if (limit < 4) return '';
  const ellipsis = '…'; // 3 bytes of UTF-8, and it has to fit inside the limit too
  let out = str;
  while (byteLength(out) + byteLength(ellipsis) > limit) out = out.slice(0, -1);
  return `${out}${ellipsis}`;
}
