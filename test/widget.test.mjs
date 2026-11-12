import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  WIDGET_LIMITS,
  compressedSize,
  loadWidgetHtml,
  packWidgetState,
  sanitizeOffer,
  statusText,
  validateWidgetHtml,
  clip,
} from '../src/widget.mjs';
import { sampleOffers, normalizeOffers } from '../src/feed.mjs';

test('Vercel output directory contains a non-empty crawl policy asset', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const robots = await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.equal(config.outputDirectory, 'public');
  assert.equal(robots, 'User-agent: *\nDisallow: /\n');
});

test('widget uses the injected TelegramWidget API, not the Mini App script or ready()', async () => {
  const widget = await loadWidgetHtml({ widgetPath: 'index.html' }, true);
  assert.equal(widget.html.toLowerCase().includes('<script src='), false);
  assert.equal(widget.html.includes('TelegramWidget.ready('), false);
  assert.equal(widget.html.includes('window.TelegramWidget'), true);
  assert.equal(widget.html.includes('W.request'), true);
  assert.match(widget.html, /watchPublicData/);
});

test('index.html is sendable as a widget', async () => {
  const widget = await loadWidgetHtml({ widgetPath: 'index.html' }, true);
  assert.ok(widget.html.length > 1000, 'widget html should not be empty');
  assert.equal(widget.errors.length, 0, widget.errors.join('; '));
  assert.ok(widget.rawBytes <= WIDGET_LIMITS.htmlBytes);
  assert.ok(widget.compressedBytes <= WIDGET_LIMITS.htmlCompressedBytes,
    `zlib-9 ${widget.compressedBytes} must stay under ${WIDGET_LIMITS.htmlCompressedBytes}`);
  assert.ok(compressedSize(widget.html) === widget.compressedBytes);
});

test('the widget html flags out-of-profile features as warnings, not errors', () => {
  const report = validateWidgetHtml('<html><head><script src="https://x/y.js"></script></head><body><input><div style="height:10vh">hi</div></body></html>');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((w) => /external <script/.test(w)));
  assert.ok(report.warnings.some((w) => /form controls/.test(w)));
  assert.ok(report.warnings.some((w) => /vh units/.test(w)));
});

test('oversized html is an error', () => {
  // Repetitive markup compresses away, so use incompressible content to break
  // the 4096-byte zlib budget while staying under the 32768-byte raw budget.
  let noise = '';
  let seed = 12345;
  while (noise.length < 20000) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise += seed.toString(36);
  }
  const report = validateWidgetHtml(`<!doctype html><body><div>${noise}</div></body>`);
  assert.ok(report.rawBytes <= WIDGET_LIMITS.htmlBytes, `raw ${report.rawBytes}`);
  assert.ok(report.compressedBytes > WIDGET_LIMITS.htmlCompressedBytes, `zlib ${report.compressedBytes}`);
  assert.ok(report.errors.some((e) => /zlib/.test(e)));

  assert.ok(validateWidgetHtml('x'.repeat(40000)).errors.some((e) => /32768/.test(e)));
  assert.ok(validateWidgetHtml('').errors.length > 0);
  assert.ok(validateWidgetHtml('<div>a\u0000b</div>').errors.some((e) => /NUL/.test(e)));
});

test('widget state always fits the 1024-byte budget', () => {
  const offers = sampleOffers({ count: 10 });
  const packed = packWidgetState({ offers, updated: 'Updated 12:00 UTC', r: 7, maxOffers: 3 });
  assert.ok(packed.bytes <= WIDGET_LIMITS.dataBytes, `${packed.bytes} bytes`);
  assert.equal(packed.offers, 3);
  assert.equal(packed.dropped, 7);

  const parsed = JSON.parse(packed.json);
  assert.equal(parsed.r, 7);
  assert.equal(parsed.updated, 'Updated 12:00 UTC');
  assert.equal(parsed.offers.length, 3);
  for (const offer of parsed.offers) {
    assert.match(offer.id, /^[A-Za-z0-9_-]{1,48}$/);
    assert.ok(offer.price);
  }
});

test('packing sheds offers and then fields until it fits', () => {
  const wide = Array.from({ length: 3 }, (_, i) => ({
    id: `offer-${i}`,
    name: `A very long merchant name that keeps going ${i}`,
    verified: true,
    orders: '1,234,567',
    completion: '99.9%',
    price: '0.9987',
    currency: 'USD',
    limit: '10,000–999,999 USD',
    payment: 'Bank transfer, ACLEDA, Wing, ABA Pay, Cash in person',
  }));
  const tight = packWidgetState({ offers: wide, updated: 'x'.repeat(40), r: 1, maxOffers: 3, limit: 420 });
  assert.ok(tight.bytes <= 420);
  assert.ok(tight.fields < 9, 'should have dropped optional fields');

  const impossible = packWidgetState({ offers: wide, r: 1, maxOffers: 3, limit: 200 });
  assert.equal(impossible.offers, 1);
  assert.ok(impossible.bytes <= 200);
});

test('offers are normalised and given a usable id', () => {
  const offer = sanitizeOffer({
    merchant: '  Atlas   Pay ',
    isVerified: 'true',
    orderCount: 1240,
    completionRate: '99.2',
    unitPrice: '1.0012',
    ccy: 'usd',
    min: 100,
    max: 2000,
    payments: ['Bank transfer', 'Wing'],
  });
  assert.match(offer.id, /^[A-Za-z0-9_-]{1,48}$/);
  assert.equal(offer.name, 'Atlas Pay');
  assert.equal(offer.verified, true);
  assert.equal(offer.completion, '99.2%');
  assert.equal(offer.price, '1.0012');
  assert.equal(offer.currency, 'USD');
  assert.equal(offer.limit, '100–2,000 USD');
  assert.equal(offer.payment, 'Bank transfer, Wing');

  assert.equal(sanitizeOffer(null), null);
  assert.equal(sanitizeOffer({ name: 'x', id: 'has spaces!!' })?.id.match(/^[A-Za-z0-9_-]+$/) !== null, true);
});

test('normalizeOffers accepts the usual shapes', () => {
  const raw = [{ name: 'A', price: 1 }, { name: 'B', price: 2 }];
  assert.equal(normalizeOffers(raw).length, 2);
  assert.equal(normalizeOffers({ offers: raw }).length, 2);
  assert.equal(normalizeOffers({ data: raw }).length, 2);
  assert.equal(normalizeOffers({ result: raw }).length, 2);
  assert.throws(() => normalizeOffers({ nope: true }));
});

test('answer text is clipped to the answer budget', () => {
  const long = 'x'.repeat(2000);
  assert.ok(Buffer.byteLength(clip(long, WIDGET_LIMITS.answerBytes)) <= WIDGET_LIMITS.answerBytes);
  assert.equal(statusText({ offers: 3, updated: 'Updated 09:00 UTC', sample: true, dropped: 2 }),
    'Sample feed · 3 merchants · Updated 09:00 UTC · 2 not shown');
});
