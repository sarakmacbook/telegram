/**
 * Wires config + logging + Telegram client + widget HTML + feed + handlers
 * into one app object. Used by the CLI, the Vercel functions and the tests.
 */

import { loadConfig, loggerFromConfig } from './config.mjs';
import { createTelegramClient } from './telegram.mjs';
import { createFeed } from './feed.mjs';
import { loadWidgetHtml } from './widget.mjs';
import { createBot } from './handlers.mjs';

let memo = null;

function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'configured';
  }
}

/**
 * @param {object} options
 * @param {object} [options.env]      environment to read (defaults to process.env)
 * @param {object} [options.api]      pre-built Telegram client (a mock in tests/dev)
 * @param {object} [options.log]      pre-built logger
 * @param {boolean} [options.fresh]   bypass the memoised instance
 */
export async function createApp({ env = process.env, api, log, fresh = false } = {}) {
  const cfg = loadConfig(env);
  if (memo && !fresh && memo.key === cacheKey(cfg, api)) return memo.app;

  const logger = log ?? loggerFromConfig(cfg);
  for (const problem of cfg.problems) logger.warn('config', { problem });

  const telegram =
    api ??
    createTelegramClient({ token: cfg.token, apiRoot: cfg.apiRoot, log: logger });

  const widget = await loadWidgetHtml({ widgetPath: cfg.widgetPath, log: logger });
  for (const warning of widget.warnings) logger.warn('widget html', { warning });
  logger.info('widget html ready', {
    source: widget.source,
    rawBytes: widget.rawBytes,
    zlibBytes: widget.compressedBytes,
    limit: 4096,
  });

  const feed = createFeed({ cfg, log: logger });
  const bot = createBot({ cfg, api: telegram, log: logger, feed, widget });

  const app = { cfg, log: logger, api: telegram, widget, feed, bot };
  memo = { key: cacheKey(cfg, api), app };
  return app;
}

function cacheKey(cfg, api) {
  return `${cfg.token || 'mock'}|${cfg.apiRoot}|${cfg.widgetPath}|${api ? 'injected' : 'http'}`;
}

/** Small status object for health endpoints and the dev page. */
export async function describeApp(app) {
  const { cfg, widget, feed, bot } = app;
  const snapshot = feed.inspect();
  return {
    ok: true,
    bot: {
      configured: Boolean(cfg.token),
      apiRoot: cfg.apiRoot,
      webhookUrl: safeUrl(cfg.webhookUrl),
      webhookSecretSet: Boolean(cfg.webhookSecret),
    },
    widget: {
      source: widget.source,
      rawBytes: widget.rawBytes,
      compressedBytes: widget.compressedBytes,
      compressedLimit: 4096,
      errors: widget.errors,
      warnings: widget.warnings,
    },
    feed: {
      remote: feed.isRemote,
      url: safeUrl(cfg.feedUrl),
      source: snapshot.source,
      sample: snapshot.sample,
      offers: snapshot.offers.length,
      updated: snapshot.updated,
      lastError: snapshot.error,
      cacheAgeMs: snapshot.cacheAgeMs,
    },
    limits: {
      maxOffers: cfg.maxOffers,
      sharedCacheTime: cfg.sharedCacheTime,
      sharedWidgetId: bot.store.getSharedWidgetId() || cfg.sharedWidgetId || null,
    },
    problems: cfg.problems,
  };
}
