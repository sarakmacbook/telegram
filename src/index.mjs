#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   node src/index.mjs poll           long polling (local, VPS, containers)
 *   node src/index.mjs webhook        serve the webhook locally (needs a tunnel)
 *   node src/index.mjs dev            widget preview + mock Telegram, no token
 *   node src/index.mjs set-webhook    register WEBHOOK_URL with Telegram
 *   node src/index.mjs unset-webhook  remove the webhook (enables polling again)
 *   node src/index.mjs check          validate index.html against widget limits
 */

import { existsSync } from 'node:fs';
import { createApp, describeApp } from './app.mjs';
import { ALLOWED_UPDATES } from './handlers.mjs';
import { createHttpServer, ensureWebhook } from './webhook.mjs';
import { createMockTelegram } from './mock-telegram.mjs';
import { createDevRoutes } from './dev.mjs';
import { loadWidgetHtml } from './widget.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDotEnv() {
  for (const file of ['.env', '.env.local']) {
    try {
      if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
    } catch (error) {
      console.warn(`could not load ${file}: ${error.message}`);
    }
  }
}

async function commandPoll(app) {
  const { api, log } = app;
  const me = await api.getMe();
  log.info('bot connected', { id: me.id, username: me.username, first_name: me.first_name });

  const info = await api.getWebhookInfo().catch(() => null);
  if (info?.url) {
    log.warn('a webhook is registered, so getUpdates will answer 409', {
      url: info.url,
      fix: 'run `npm run unset-webhook` or deploy and use webhook mode instead',
    });
  }

  let offset = 0;
  let running = true;
  const stop = (signal) => {
    if (!running) return;
    running = false;
    log.info('stopping', { signal });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  log.info('polling for updates', { allowed_updates: ALLOWED_UPDATES.join(',') });
  while (running) {
    const inFlight = [];
    try {
      const updates = await api.getUpdates({ offset: offset || undefined, timeout: 30, allowed_updates: ALLOWED_UPDATES });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        // Handled concurrently so a slow feed fetch cannot delay a widget query
        // past its 15-second answer window.
        inFlight.push(app.bot.handleUpdate(update));
      }
      if (inFlight.length) log.debug('batch handled', { count: inFlight.length, offset });
    } catch (error) {
      if (error.status === 409) {
        log.error('conflict: another poller or a webhook is using this bot', { description: error.description });
        await sleep(5000);
      } else {
        log.error('getUpdates failed', { error: error.message });
        await sleep(3000);
      }
    } finally {
      await Promise.allSettled(inFlight);
    }
  }
}

async function commandWebhook(app) {
  const { cfg, log } = app;
  if (cfg.autoSetWebhook && cfg.webhookUrl) {
    await ensureWebhook(app).catch((error) => log.error('could not set the webhook', { error: error.message }));
  } else if (!cfg.webhookUrl) {
    log.warn('WEBHOOK_URL is not set — serving the endpoint, but Telegram does not know about it');
  }
  const server = createHttpServer({ app });
  server.on('listening', () => {
    log.info('webhook server listening', {
      port: cfg.port,
      endpoints: `POST http://0.0.0.0:${cfg.port}/webhook and /api/webhook`,
      secret: cfg.webhookSecret ? 'required' : 'not configured',
    });
  });
  const close = () => server.close(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

async function commandDev() {
  const mock = createMockTelegram();
  const app = await createApp({ api: mock.api, env: { ...process.env, BOT_TOKEN: process.env.BOT_TOKEN || 'mock-token' } });
  const route = createDevRoutes({ app, mock });
  const server = createHttpServer({ app, route, webhookPath: '/webhook' });

  // Give the preview something to show straight away.
  await app.bot.handleUpdate(mock.messageUpdate('/widget'));

  server.on('listening', () => {
    const { log, cfg } = app;
    log.info('dev preview listening', {
      url: `http://localhost:${cfg.port}`,
      webhook: `POST http://localhost:${cfg.port}/webhook`,
      note: 'mock Telegram — no token needed',
    });
  });
}

async function commandSetWebhook(app, { drop = false } = {}) {
  const info = await ensureWebhook(app, { dropPendingUpdates: drop });
  app.log.info('setWebhook ok', { url: info?.url, pending: info?.pending_update_count });
}

async function commandUnsetWebhook(app) {
  await app.api.deleteWebhook({ drop_pending_updates: false });
  app.log.info('webhook removed — polling will work again');
}

async function commandCheck(cfg, log) {
  const widget = await loadWidgetHtml({ widgetPath: cfg.widgetPath, log }, true);
  const budget = 4096;
  const used = widget.compressedBytes;
  process.stdout.write(
    [
      `widget html   ${widget.source}`,
      `raw           ${widget.rawBytes} / 32768 bytes`,
      `zlib level 9  ${used} / ${budget} bytes  (${Math.round((used / budget) * 100)}% of the budget)`,
      `state budget  1024 bytes for chat_data and public_data each`,
      `offers        up to ${cfg.maxOffers} per card (MAX_OFFERS)`,
      '',
    ].join('\n'),
  );
  for (const warning of widget.warnings) process.stdout.write(`warn  ${warning}\n`);
  for (const error of widget.errors) process.stdout.write(`error ${error}\n`);
  if (widget.errors.length) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(widget.warnings.length ? '\nsendable, with warnings\n' : '\nsendable\n');
}

async function main() {
  loadDotEnv();
  const command = (process.argv[2] || 'poll').toLowerCase();
  const { loadConfig, loggerFromConfig } = await import('./config.mjs');
  const cfg = loadConfig();
  const log = loggerFromConfig(cfg);

  if (command === 'check') return commandCheck(cfg, log);
  if (command === 'dev') return commandDev();

  if (!cfg.token && command !== 'help') {
    log.error('BOT_TOKEN is missing', {
      help: 'copy .env.example to .env, or set BOT_TOKEN in the environment / Vercel dashboard',
    });
    process.exitCode = 1;
    return;
  }

  const app = await createApp({ env: process.env });
  switch (command) {
    case 'poll':
    case 'start':
      return commandPoll(app);
    case 'webhook':
    case 'serve':
      return commandWebhook(app);
    case 'set-webhook':
    case 'setwebhook':
      return commandSetWebhook(app, { drop: process.argv.includes('--drop-pending') });
    case 'unset-webhook':
    case 'deletewebhook':
      return commandUnsetWebhook(app);
    case 'info':
      process.stdout.write(`${JSON.stringify(await describeApp(app), null, 2)}\n`);
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(
        [
          'usage: node src/index.mjs <command>',
          '',
          '  poll           long polling (default)',
          '  webhook        serve the webhook endpoint locally',
          '  dev            widget preview + mock Telegram (no token needed)',
          '  set-webhook    register WEBHOOK_URL, with the widget update types',
          '  unset-webhook  remove the webhook',
          '  check          validate the widget html against Telegram limits',
          '  info           print the resolved configuration',
          '',
        ].join('\n'),
      );
      return;
    default:
      log.error('unknown command', { command, help: 'node src/index.mjs help' });
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack || error?.message || error}\n`);
  process.exitCode = 1;
});
