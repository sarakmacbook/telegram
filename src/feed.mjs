/**
 * Where the widget's offers come from.
 *
 * FEED_URL set      -> fetch that HTTPS endpoint and normalise it
 * FEED_URL unset    -> built-in sample feed (clearly labelled as sample data)
 * FEED_URL failing  -> last good result, otherwise the sample feed
 *
 * A widget has no network access of its own, so the bot is the only place that
 * can source offers. Point FEED_URL at your own backend and keep the sourcing,
 * verification and compliance of the data there.
 */

import { sanitizeOffer } from './widget.mjs';

const MERCHANTS = [
  'NorthGate', 'AtlasPay', 'Meridian FX', 'KoboTrade', 'SilverRoute', 'Hanuman Pay',
  'Delta Desk', 'Mekong OTC', 'Orion Book', 'Cardinal P2P', 'Sable Trade', 'Vertex Pay',
];
const PAYMENTS = ['Bank transfer', 'ABA Pay', 'Wing', 'ACLEDA', 'USDT wallet', 'Cash in person'];

/** Deterministic PRNG so a refresh changes prices but stays reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const between = (rand, min, max) => min + rand() * (max - min);

/** Generates plausible sample offers. Not real market data. */
export function sampleOffers({ count = 3, now = Date.now(), nonce = 0 } = {}) {
  const seed = Math.floor(now / 60_000) * 7919 + nonce * 104729;
  const rand = mulberry32(seed);
  const used = new Set();

  return Array.from({ length: count }, (_, i) => {
    let name = pick(rand, MERCHANTS);
    while (used.has(name) && used.size < MERCHANTS.length) name = pick(rand, MERCHANTS);
    used.add(name);
    const price = between(rand, 0.9955, 1.0045);
    const min = Math.round(between(rand, 50, 400) / 10) * 10;
    const max = Math.round(min + between(rand, 900, 9000));
    return {
      id: `s${(i + 1)}-${Math.floor(rand() * 1e6).toString(36)}`,
      name,
      verified: rand() > 0.35,
      orders: Math.round(between(rand, 240, 4800)).toLocaleString('en-US'),
      completion: `${(between(rand, 95.5, 99.9)).toFixed(1)}%`,
      price: price.toFixed(4),
      currency: 'USD',
      limit: `${min.toLocaleString('en-US')}–${max.toLocaleString('en-US')} USD`,
      payment: pick(rand, PAYMENTS),
    };
  });
}

/** Accepts an array or { offers | data | result: [...] } from FEED_URL. */
export function normalizeOffers(payload, { maxOffers = 10 } = {}) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.offers)
      ? payload.offers
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.result)
          ? payload.result
          : null;
  if (!list) throw new Error('expected an array or an object with "offers"');
  return list
    .slice(0, Math.max(maxOffers, 1) * 2)
    .map((raw, i) => sanitizeOffer(raw, i))
    .filter(Boolean);
}

export function utcStamp(date = new Date()) {
  return `Updated ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function createFeed({ cfg, log, fetchImpl = globalThis.fetch } = {}) {
  const cache = { offers: null, at: 0, source: 'none', updated: '', sample: true, error: null };
  let nonce = 0;

  const snapshot = (extra = {}) => ({
    offers: cache.offers || [],
    source: cache.source,
    updated: cache.updated,
    sample: cache.sample,
    error: cache.error,
    ...extra,
  });

  function useSample(reason) {
    cache.offers = sampleOffers({ count: Math.max(cfg?.maxOffers ?? 3, 3), nonce: (nonce += 1) });
    cache.source = 'sample';
    cache.sample = true;
    cache.updated = utcStamp();
    cache.error = reason || null;
    cache.at = Date.now();
    return snapshot();
  }

  async function fromUrl(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg?.feedTimeoutMs ?? 6000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const offers = normalizeOffers(payload, { maxOffers: cfg?.maxOffers ?? 3 });
      if (!offers.length) throw new Error('feed returned no usable offers');
      cache.offers = offers;
      cache.source = 'feed';
      cache.sample = false;
      cache.error = null;
      cache.updated = utcStamp();
      cache.at = Date.now();
      return snapshot();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get isRemote() {
      return Boolean(cfg?.feedUrl);
    },

    /** Current offers. `force` bypasses the cache (the widget's Refresh button). */
    async getOffers({ force = false } = {}) {
      const ttl = cfg?.feedCacheMs ?? 30_000;
      if (!force && cache.offers && Date.now() - cache.at < ttl) return snapshot();

      if (cfg?.feedUrl) {
        try {
          return await fromUrl(cfg.feedUrl);
        } catch (error) {
          const reason = error?.name === 'AbortError' ? 'feed timed out' : error?.message || 'feed error';
          log?.warn?.('offer feed unavailable, falling back', { reason, hadCache: Boolean(cache.offers) });
          if (cache.offers && cache.source === 'feed') {
            cache.updated = `${utcStamp()} · cached`;
            cache.error = reason;
            return snapshot({ stale: true });
          }
          return useSample(reason);
        }
      }

      return useSample(null);
    },

    /** For /feed and the dev page. */
    inspect() {
      return { ...snapshot(), cacheAgeMs: cache.at ? Date.now() - cache.at : null, nonce };
    },
  };
}
