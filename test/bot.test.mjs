import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, createLogger } from '../src/config.mjs';
import { createBot, createStore, ALLOWED_UPDATES } from '../src/handlers.mjs';
import { createMockTelegram } from '../src/mock-telegram.mjs';
import { createFeed } from '../src/feed.mjs';
import { loadWidgetHtml, WIDGET_LIMITS } from '../src/widget.mjs';
import { handleTelegramWebhook } from '../src/webhook.mjs';

const log = createLogger({ level: 'silent' });

async function makeBot({ env = {}, fetchImpl } = {}) {
  const cfg = loadConfig({ BOT_TOKEN: 'test-token', MAX_OFFERS: '3', ...env });
  const mock = createMockTelegram();
  const widget = await loadWidgetHtml({ widgetPath: cfg.widgetPath }, true);
  const feed = createFeed({ cfg, log, fetchImpl });
  const bot = createBot({ cfg, api: mock.api, log, feed, widget });
  return { cfg, mock, bot, feed, widget };
}

const calls = (mock, method) => mock.state.calls.filter((call) => call.method === method);
const lastWidget = (mock) => mock.lastWidgetMessage();

test('allowed_updates includes the widget query types', () => {
  assert.deepEqual(ALLOWED_UPDATES, ['message', 'edited_message', 'callback_query', 'widget_query', 'shared_widget_query']);
});

test('feed timeout is capped to leave room for the widget-query answer deadline', () => {
  const cfg = loadConfig({ FEED_TIMEOUT_MS: '15000' });
  assert.equal(cfg.feedTimeoutMs, 8000);
});

test('/start greets and sends the widget with sendWidget', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/start'));

  const sent = calls(mock, 'sendWidget');
  assert.equal(sent.length, 1);
  const params = sent[0].params;
  assert.equal(params.chat_id, mock.userId);
  assert.equal(params.allow_queries, true);
  assert.equal(params.is_shared, undefined);
  assert.ok(Buffer.byteLength(params.chat_data) <= WIDGET_LIMITS.dataBytes);
  assert.deepEqual(JSON.parse(params.chat_data).offers.length, 3);
  assert.ok(params.reply_markup.inline_keyboard.length > 0);
  assert.match(params.caption, /Sample data/);

  // The html travels inline in the message the mock stored.
  const sentHtml = lastWidget(mock).widget.html;
  assert.ok(sentHtml.includes('TelegramWidget'), 'the widget html is sent inline');
  assert.ok(sentHtml.includes('sendWidget') === false, 'the widget does not call the Bot API itself');
});

test('widgets are refused outside a private chat', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget', { chatId: -100123, type: 'supergroup' }));
  assert.equal(calls(mock, 'sendWidget').length, 0);
  const messages = calls(mock, 'sendMessage');
  assert.match(messages.at(-1).params.text, /private chat/);
});

test('message is not modified is treated as a harmless unchanged state', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  const message = lastWidget(mock);
  const result = await bot.writeState(
    { chatId: mock.userId, messageId: message.message_id },
    message.widget.chat_data,
  );
  assert.equal(result, 'unchanged');
});

test('a widget Refresh tap is answered and the state is rewritten', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  const message = lastWidget(mock);
  const firstState = JSON.parse(message.widget.chat_data);

  await bot.handleUpdate(mock.widgetQuery('refresh', { messageId: message.message_id }));

  const answers = calls(mock, 'answerWidgetQuery');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].params.widget_query_id, mock.state.answers[0].widget_query_id);
  assert.match(answers[0].params.data, /3 merchants/);
  assert.ok(Buffer.byteLength(answers[0].params.data) <= WIDGET_LIMITS.answerBytes);

  const edits = calls(mock, 'editMessageWidgetData');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].params.chat_id, mock.userId);
  assert.equal(edits[0].params.message_id, message.message_id);

  const nextState = JSON.parse(lastWidget(mock).widget.chat_data);
  assert.ok(nextState.r > firstState.r, 'the revision must go up on every edit');
  assert.equal(nextState.offers.length, 3);
  assert.equal(calls(mock, 'editSharedWidgetData').length, 0);
});

test('a merchant tap answers with that merchant and does not rewrite state', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  const message = lastWidget(mock);
  const offer = JSON.parse(message.widget.chat_data).offers[1];

  await bot.handleUpdate(mock.widgetQuery(`offer:${offer.id}`, { messageId: message.message_id }));

  const answer = mock.lastAnswer();
  assert.ok(answer.includes(offer.name), `answer should mention ${offer.name}: ${answer}`);
  assert.match(answer, /per USDT/);
  assert.equal(calls(mock, 'editMessageWidgetData').length, 0);
});

test('an unknown tap is answered, not dropped', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  await bot.handleUpdate(mock.widgetQuery('launch-missiles', { messageId: lastWidget(mock).message_id }));
  assert.match(mock.lastAnswer(), /Unknown request/);
});

test('a wallet query type is declined politely', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  const update = mock.widgetQuery('pay:1', { messageId: lastWidget(mock).message_id });
  update.widget_query.type = 'sent_transaction';
  await bot.handleUpdate(update);
  assert.match(mock.lastAnswer(), /wallet/);

  const nestedType = mock.widgetQuery('pay:2', { messageId: lastWidget(mock).message_id });
  nestedType.widget_query.type = { type: 'sign_data' };
  await bot.handleUpdate(nestedType);
  assert.match(mock.lastAnswer(), /wallet/);
});

test('/live creates a shared widget, sets cache_time, and updates public_data', async () => {
  const { mock, bot, cfg } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/live'));

  const sent = calls(mock, 'sendWidget')[0].params;
  assert.equal(sent.is_shared, true);
  assert.equal(sent.chat_data, undefined, 'chat_data would shadow the shared state');
  assert.ok(Buffer.byteLength(sent.public_data) <= WIDGET_LIMITS.dataBytes);

  const widgetId = lastWidget(mock).widget.id;
  assert.ok(widgetId, 'Telegram returns the shared widget id');
  assert.equal(bot.store.getSharedWidgetId(), widgetId);

  const sharedEdits = calls(mock, 'editSharedWidgetData');
  assert.equal(sharedEdits.length, 1);
  assert.equal(sharedEdits[0].params.widget_id, widgetId);
  assert.equal(sharedEdits[0].params.cache_time, cfg.sharedCacheTime);

  // A refresh from the shared widget edits the shared object, not the message.
  await bot.handleUpdate(mock.widgetQuery('refresh', { messageId: lastWidget(mock).message_id }));
  assert.equal(calls(mock, 'editSharedWidgetData').length, 2);
  assert.equal(calls(mock, 'editMessageWidgetData').length, 0);
  const state = JSON.parse(lastWidget(mock).widget.public_data);
  assert.ok(state.r >= 2);
});

test('concurrent shared refreshes are serialized at one edit per second', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/live'));
  const messageId = lastWidget(mock).message_id;
  const before = calls(mock, 'editSharedWidgetData').length;

  await Promise.all([
    bot.handleUpdate(mock.widgetQuery('refresh', { messageId })),
    bot.handleUpdate(mock.widgetQuery('refresh', { messageId })),
  ]);

  const edits = calls(mock, 'editSharedWidgetData').slice(before);
  assert.equal(edits.length, 2);
  assert.ok(edits[1].at - edits[0].at >= 950, `${edits[1].at - edits[0].at}ms between shared edits`);
  assert.equal(calls(mock, 'answerWidgetQuery').length, 2);
});

test('/resend sends the shared widget again by id', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/live'));
  const widgetId = bot.store.getSharedWidgetId();

  await bot.handleUpdate(mock.messageUpdate('/resend'));
  const resend = calls(mock, 'sendSharedWidget');
  assert.equal(resend.length, 1);
  assert.equal(resend[0].params.widget_id, widgetId);
  assert.equal(resend[0].params.chat_data, undefined, 'keep the shared state authoritative');
});

test('/resend without a shared widget explains what to do', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/resend'));
  assert.equal(calls(mock, 'sendSharedWidget').length, 0);
  assert.match(calls(mock, 'sendMessage').at(-1).params.text, /\/live/);
});

test('a forward of a shared widget arrives as shared_widget_query', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/live'));
  const widgetId = bot.store.getSharedWidgetId();

  await bot.handleUpdate(mock.sharedWidgetQuery('refresh', { widgetId }));
  const edits = calls(mock, 'editSharedWidgetData');
  assert.equal(edits.at(-1).params.widget_id, widgetId);
  assert.match(mock.lastAnswer(), /merchants/);
});

test('the inline button under the card refreshes the same message', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  const message = lastWidget(mock);
  const before = JSON.parse(message.widget.chat_data).r;

  await bot.handleUpdate(mock.callbackUpdate('w:refresh', { messageId: message.message_id }));
  const after = JSON.parse(lastWidget(mock).widget.chat_data).r;
  assert.ok(after > before);
  assert.equal(calls(mock, 'answerCallbackQuery').at(-1).params.text, 'Offers updated (3)');
});

test('/refresh updates the last card, /feed reports the source, /id reports ids', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/widget'));
  await bot.handleUpdate(mock.messageUpdate('/refresh'));
  assert.equal(calls(mock, 'editMessageWidgetData').length, 1);

  await bot.handleUpdate(mock.messageUpdate('/feed'));
  assert.match(calls(mock, 'sendMessage').at(-1).params.text, /Feed source: built-in sample data/);

  await bot.handleUpdate(mock.messageUpdate('/id'));
  assert.match(calls(mock, 'sendMessage').at(-1).params.text, /chat id: 111111111/);
});

test('/refresh also updates the last card when it was shared', async () => {
  const { mock, bot } = await makeBot();
  await bot.handleUpdate(mock.messageUpdate('/live'));
  const widgetId = bot.store.getSharedWidgetId();
  const oldRevision = JSON.parse(lastWidget(mock).widget.public_data).r;

  await bot.handleUpdate(mock.messageUpdate('/refresh'));

  assert.equal(calls(mock, 'editMessageWidgetData').length, 0);
  assert.equal(calls(mock, 'editSharedWidgetData').length, 2);
  assert.equal(calls(mock, 'editSharedWidgetData').at(-1).params.widget_id, widgetId);
  assert.ok(JSON.parse(lastWidget(mock).widget.public_data).r > oldRevision);
});

test('a remote feed is used when FEED_URL answers, and the sample feed takes over when it fails', async () => {
  const remote = [
    { id: 'adv-1', name: 'Real Merchant', price: '1.0021', currency: 'USD', limit: '50–5,000 USD', payment: 'ABA Pay', verified: true, orders: '900', completion: '99%' },
    { id: 'adv-2', name: 'Second Merchant', price: '0.9988', currency: 'USD' },
  ];
  const ok = await makeBot({ env: { FEED_URL: 'https://example.com/offers' }, fetchImpl: async () => ({ ok: true, json: async () => ({ offers: remote }) }) });
  await ok.bot.handleUpdate(ok.mock.messageUpdate('/widget'));
  const sent = JSON.parse(calls(ok.mock, 'sendWidget')[0].params.chat_data);
  assert.equal(sent.offers[0].id, 'adv-1');
  assert.equal(sent.offers[0].name, 'Real Merchant');
  assert.match(calls(ok.mock, 'sendWidget')[0].params.caption, /Live feed/);

  const broken = await makeBot({ env: { FEED_URL: 'https://example.com/offers' }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await broken.bot.handleUpdate(broken.mock.messageUpdate('/widget'));
  const fallback = JSON.parse(calls(broken.mock, 'sendWidget')[0].params.chat_data);
  assert.equal(fallback.offers.length, 3);
  assert.match(calls(broken.mock, 'sendWidget')[0].params.caption, /Sample data/);
});

test('the webhook handler checks the secret and acknowledges updates', async () => {
  const { mock, bot, cfg } = await makeBot({ env: { WEBHOOK_SECRET: 's3cret-token', WEBHOOK_URL: 'https://x.vercel.app/api/webhook' } });
  const app = { cfg, log, bot };
  const update = JSON.stringify(mock.messageUpdate('/widget'));

  const forbidden = await handleTelegramWebhook(
    { method: 'POST', url: '/api/webhook', headers: {}, body: update },
    app,
  );
  assert.equal(forbidden.status, 403);
  assert.equal(calls(mock, 'sendWidget').length, 0);

  const accepted = await handleTelegramWebhook(
    { method: 'POST', url: '/api/webhook', headers: { 'x-telegram-bot-api-secret-token': 's3cret-token' }, body: update },
    app,
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), { ok: true });
  assert.equal(calls(mock, 'sendWidget').length, 1);

  const wrongMethod = await handleTelegramWebhook({ method: 'GET', url: '/', headers: {}, body: '' }, app);
  assert.equal(wrongMethod.status, 405);

  const badJson = await handleTelegramWebhook(
    { method: 'POST', url: '/api/webhook', headers: { 'x-telegram-bot-api-secret-token': 's3cret-token' }, body: '{' },
    app,
  );
  assert.equal(badJson.status, 400);

  // A handler that throws must still be acknowledged so Telegram stops retrying.
  const failing = { cfg, log, bot: { handleUpdate: async () => { throw new Error('boom'); } } };
  const stillOk = await handleTelegramWebhook(
    { method: 'POST', url: '/api/webhook', headers: { 'x-telegram-bot-api-secret-token': 's3cret-token' }, body: update },
    failing,
  );
  assert.equal(stillOk.status, 200);
});

test('the Vercel webhook accepts a parsed JSON request body', async () => {
  const saved = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };
  process.env.BOT_TOKEN = 'vercel-test-token';
  process.env.WEBHOOK_SECRET = 'vercel-secret';
  process.env.LOG_LEVEL = 'silent';

  try {
    const { default: handler } = await import('../api/webhook.mjs');
    const req = {
      method: 'POST',
      url: '/api/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'vercel-secret' },
      body: { update_id: 987654 },
    };
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; return this; },
    };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the store bumps revisions and throttles shared-widget edits', async () => {
  const store = createStore({ sharedWidgetId: 'w1' });
  assert.equal(store.getSharedWidgetId(), 'w1');
  assert.equal(store.peekRevision('k'), 0);

  const first = store.nextRevision('k');
  const second = store.nextRevision('k');
  assert.ok(second > first, 'revisions must strictly increase for one widget');
  assert.ok(first >= Math.floor(Date.now() / 1000) - 5, 'revisions survive a cold start');
  assert.ok(store.nextRevision('other') >= first, 'revisions never go backwards across keys');

  assert.equal(store.msUntilSharedEdit('w1'), 0);
  store.markSharedEdit('w1');
  assert.ok(store.msUntilSharedEdit('w1') > 900, 'a shared widget may be edited once per second');

  store.setLastWidgetMessage(42, 99, 'shared-id');
  assert.equal(store.getLastWidgetMessage(42), 99);
  assert.equal(store.getLastWidgetId(42), 'shared-id');
});
