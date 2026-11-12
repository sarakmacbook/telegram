/**
 * Bot logic: commands, inline buttons, and the widget request lifecycle.
 *
 *   widget button  ->  TelegramWidget.request(data)
 *                  ->  widget_query / shared_widget_query update
 *                  ->  answerWidgetQuery  (status text, within 15 s)
 *                  ->  editMessageWidgetData / editSharedWidgetData (new state)
 *                  ->  chatDataChanged / publicDataChanged fires in the widget
 *
 * The api object is injected, so the same code runs against Telegram, against
 * src/mock-telegram.mjs in the dev preview, and in tests.
 */

import {
  WIDGET_LIMITS,
  assertSendable,
  clip,
  packWidgetState,
  statusText,
} from './widget.mjs';

export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'widget_query', 'shared_widget_query'];

const WIDGETS_PRIVATE_ONLY =
  'Telegram currently delivers widgets in the private chat between a bot and a user only.\n' +
  'Open this bot in a private chat and send /widget to see the merchant card.';

const HELP = [
  'OKX P2P merchant widget — commands',
  '',
  '/widget  send the merchant card (state in chat_data)',
  '/live    send a live shared card (state in public_data, polled while on screen)',
  '/resend  send the shared card again by its widget id',
  '/refresh refresh the last card sent in this chat',
  '/feed    show where offers come from and how big the state is',
  '/id      show this chat id',
  '/help    this message',
  '',
  'Inside the card: Refresh asks the bot for new offers, and a merchant button',
  'asks for that merchant. Both arrive as a widget_query and are answered with',
  'answerWidgetQuery, then the card is repainted by editing its state.',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory bookkeeping. On serverless it resets on a cold start — that is fine
 *  because every write is derived from the update itself (chat/message/widget id). */
export function createStore({ sharedWidgetId = '' } = {}) {
  const revisions = new Map();
  const lastSharedEdit = new Map();
  const sharedEditQueue = new Map();
  const lastWidgetMessage = new Map();
  let counter = 0;
  let shared = sharedWidgetId || '';

  return {
    getSharedWidgetId: () => shared,
    setSharedWidgetId(id) { if (id) shared = String(id); },
    peekRevision: (key) => revisions.get(key) ?? 0,
    /**
     * Raised on every state write so a client poll can never apply older state.
     * One counter for the whole instance, floored at the current unix time in
     * milliseconds, so it strictly increases in-process and advances after a
     * serverless cold start empties this map.
     */
    nextRevision(key) {
      const next = Math.max(counter + 1, revisions.get(key) ?? 0, Date.now());
      counter = next;
      revisions.set(key, next);
      return next;
    },
    /** A shared widget's public data may be edited at most once per second. */
    msUntilSharedEdit(widgetId) {
      const last = lastSharedEdit.get(widgetId) ?? 0;
      return Math.max(0, 1000 - (Date.now() - last));
    },
    markSharedEdit(widgetId) { lastSharedEdit.set(widgetId, Date.now()); },
    /** Serialize same-process edits so concurrent queries cannot race the 1/s gate. */
    withSharedEdit(widgetId, operation) {
      const previous = sharedEditQueue.get(widgetId) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const wait = Math.max(0, 1000 - (Date.now() - (lastSharedEdit.get(widgetId) ?? 0)));
        if (wait > 0) await sleep(wait);
        lastSharedEdit.set(widgetId, Date.now());
        return operation();
      });
      sharedEditQueue.set(widgetId, task);
      return task.finally(() => {
        if (sharedEditQueue.get(widgetId) === task) sharedEditQueue.delete(widgetId);
      });
    },
    setLastWidgetMessage(chatId, messageId, widgetId) {
      if (chatId && messageId) lastWidgetMessage.set(chatId, { messageId, widgetId: widgetId || null });
    },
    getLastWidgetMessage: (chatId) => lastWidgetMessage.get(chatId)?.messageId,
    getLastWidgetId: (chatId) => lastWidgetMessage.get(chatId)?.widgetId ?? null,
  };
}

export function createBot({ cfg, api, log, feed, widget }) {
  const store = createStore({ sharedWidgetId: cfg.sharedWidgetId });
  const logger = log.child ? log.child('handlers') : log;
  const byteLengthOf = (value) => Buffer.byteLength(String(value), 'utf8');

  const widgetKeyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh offers', callback_data: 'w:refresh' },
        { text: '📈 Live card', callback_data: 'w:live' },
      ],
      [{ text: '❓ Help', callback_data: 'w:help' }],
    ],
  };

  const startKeyboard = {
    inline_keyboard: [
      [
        { text: '🪪 Merchant card', callback_data: 'w:new' },
        { text: '📈 Live shared card', callback_data: 'w:live' },
      ],
    ],
  };

  // ── state packing ───────────────────────────────────────────────────────
  function stateKey({ widgetId, chatId, messageId, inlineMessageId }) {
    if (widgetId) return `shared:${widgetId}`;
    if (inlineMessageId) return `inline:${inlineMessageId}`;
    return `chat:${chatId}:${messageId ?? 'new'}`;
  }

  async function buildState(target, snap) {
    return packWidgetState({
      offers: snap.offers,
      updated: snap.updated,
      r: store.nextRevision(stateKey(target)),
      maxOffers: cfg.maxOffers,
    });
  }

  /** Writes state to wherever this widget lives: shared object, message, or inline message. */
  async function writeState(target, json) {
    try {
      if (target.widgetId) {
        await store.withSharedEdit(target.widgetId, () => api.editSharedWidgetData({
          widget_id: target.widgetId,
          public_data: json,
          cache_time: cfg.sharedCacheTime,
        }));
        return 'shared';
      }
      if (target.inlineMessageId) {
        await api.editMessageWidgetData({ inline_message_id: target.inlineMessageId, chat_data: json });
        return 'inline';
      }
      if (target.chatId && target.messageId) {
        await api.editMessageWidgetData({ chat_id: target.chatId, message_id: target.messageId, chat_data: json });
        return 'message';
      }
      logger.warn('nowhere to write widget state', { target });
      return null;
    } catch (error) {
      if (/not modified/i.test(error.message || '')) {
        logger.debug('widget state unchanged', { target });
        return 'unchanged';
      }
      logger.error('could not write widget state', { target: JSON.stringify(target), error: error.message });
      return null;
    }
  }

  function captionFor(snap, packed, shared) {
    const source = snap.sample ? `Sample data (${snap.error ? snap.error : 'no FEED_URL configured'})` : 'Live feed';
    const hidden = packed.dropped > 0 ? ` · ${packed.dropped} more not shown` : '';
    const what = shared
      ? 'Live card: its state is shared by every message that shows it.'
      : 'Tap Refresh in the card for new offers, or a merchant for details.';
    return clip(`${source} · ${packed.offers} merchants · ${snap.updated}${hidden}\n${what}`, 1024);
  }

  // ── sending ─────────────────────────────────────────────────────────────
  async function sendWidgetTo(chat, { shared = false, force = true } = {}) {
    if (!chat) throw new Error('sendWidgetTo: no chat');
    if (chat.type !== 'private') {
      await api.sendMessage({ chat_id: chat.id, text: WIDGETS_PRIVATE_ONLY });
      return null;
    }
    assertSendable(widget);
    const snap = await feed.getOffers({ force });
    const packed = await buildState({ chatId: chat.id }, snap);

    const params = {
      chat_id: chat.id,
      html: widget.html,
      allow_queries: true,
      caption: captionFor(snap, packed, shared),
      width: cfg.widgetWidth,
      height: cfg.widgetHeight,
    };

    let message;
    if (shared) {
      // A shared widget has one state (public_data) for the original, every
      // forward and every later sendSharedWidget. It gets no chat_data: chat
      // data would shadow the shared state the widget polls for.
      params.is_shared = true;
      params.public_data = packed.json;
      message = await api.sendWidget(params);
      const widgetId = message?.widget?.id;
      if (widgetId) {
        store.setSharedWidgetId(widgetId);
        // cache_time (the client refresh period) can only be set through
        // editSharedWidgetData. Build the state once more so the revision — and
        // therefore the payload — actually changes: an identical edit is refused
        // as "message is not modified" and would leave cache_time unset.
        const fresh = await buildState({ chatId: chat.id }, snap);
        await writeState({ widgetId }, fresh.json);
      } else {
        logger.warn('sendWidget did not return a shared widget id', { messageId: message?.message_id });
      }
    } else {
      params.chat_data = packed.json;
      params.reply_markup = widgetKeyboard;
      message = await api.sendWidget(params);
    }

    store.setLastWidgetMessage(chat.id, message?.message_id, shared ? message?.widget?.id : null);
    logger.info(shared ? 'shared widget sent' : 'widget sent', {
      chat: chat.id,
      message: message?.message_id,
      widget: message?.widget?.id,
      stateBytes: packed.bytes,
      offers: packed.offers,
      sample: snap.sample,
      htmlBytes: widget.rawBytes,
      htmlZlib: widget.compressedBytes,
    });
    return message;
  }

  async function sendSharedAgain(chat) {
    const widgetId = store.getSharedWidgetId();
    if (!widgetId) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'No shared widget id yet. Send /live first (or set SHARED_WIDGET_ID) and I can send it again by id.',
      });
      return null;
    }
    if (chat.type !== 'private') {
      await api.sendMessage({ chat_id: chat.id, text: WIDGETS_PRIVATE_ONLY });
      return null;
    }
    // Refresh the shared state first, then send: the message carries whatever
    // public_data the shared widget has at that moment.
    const snap = await feed.getOffers({ force: true });
    const packed = await buildState({ widgetId }, snap);
    await writeState({ widgetId }, packed.json);

    const message = await api.sendSharedWidget({
      chat_id: chat.id,
      widget_id: widgetId,
      caption: clip(`Shared card · ${packed.offers} merchants · ${snap.updated}`, 1024),
    });
    store.setLastWidgetMessage(chat.id, message?.message_id, widgetId);
    logger.info('shared widget resent', { chat: chat.id, widget: widgetId, message: message?.message_id });
    return message;
  }

  // ── widget queries ──────────────────────────────────────────────────────
  async function answerQuery(queryId, data) {
    try {
      await api.answerWidgetQuery({ widget_query_id: queryId, data: clip(data, WIDGET_LIMITS.answerBytes) });
      return true;
    } catch (error) {
      // The query id is only valid for 15 seconds; a late answer is refused.
      logger.error('answerWidgetQuery failed', { queryId, error: error.message });
      return false;
    }
  }

  async function handleRefresh(query, target, startedAt) {
    let snap;
    try {
      snap = await feed.getOffers({ force: true });
    } catch (error) {
      logger.error('feed failed during refresh', { error: error.message });
      return answerQuery(query.id, 'Could not load offers right now. Please try again.');
    }

    const packed = await buildState(target, snap);
    // Answer first: the widget resolves its request and shows the status, then
    // the state edit arrives as chatDataChanged / publicDataChanged.
    await answerQuery(query.id, statusText({
      offers: packed.offers,
      updated: snap.updated,
      sample: snap.sample,
      dropped: packed.dropped,
    }));

    if (Date.now() - startedAt > 12_000) {
      logger.warn('skipping state edit, the query is about to expire', { elapsedMs: Date.now() - startedAt });
      return;
    }
    const where = await writeState(target, packed.json);
    logger.info('widget refreshed', {
      query: query.id,
      where,
      offers: packed.offers,
      stateBytes: packed.bytes,
      revision: JSON.parse(packed.json).r,
    });
  }

  async function handleOfferDetails(query, offerId) {
    let snap = null;
    try {
      snap = await feed.getOffers();
    } catch (error) {
      logger.warn('feed failed during offer lookup', { error: error.message });
    }
    const offer = snap?.offers?.find((candidate) => candidate.id === offerId);
    if (!offer) {
      return answerQuery(query.id, `Offer ${clip(offerId, 24)} is not in the current list — tap Refresh.`);
    }
    const parts = [
      `${offer.name}${offer.verified ? ' ✓ verified' : ''}`,
      offer.price ? `${offer.price} ${offer.currency} per USDT` : 'price unavailable',
      offer.limit ? `limit ${offer.limit}` : 'limits unavailable',
      offer.payment || 'payment method unavailable',
      offer.orders && offer.completion ? `${offer.orders} orders · ${offer.completion} completion` : '',
    ].filter(Boolean);
    return answerQuery(query.id, clip(parts.join(' · '), WIDGET_LIMITS.answerBytes));
  }

  async function onWidgetQuery(query, isSharedQuery) {
    const startedAt = Date.now();
    const data = String(query.data ?? '');
    const queryType = typeof query.type === 'string' ? query.type : query.type?.type ?? 'data';
    const target = {
      widgetId: query.widget_id,
      chatId: query.chat?.id,
      messageId: query.message_id,
      inlineMessageId: query.inline_message_id,
    };

    logger.info(isSharedQuery ? 'shared widget query' : 'widget query', {
      id: query.id,
      data,
      type: queryType,
      from: query.from?.id,
      chat: target.chatId,
      message: target.messageId,
      inline: target.inlineMessageId,
      widget: target.widgetId,
    });

    // sign_data / sent_transaction come from a TON wallet; this widget sends plain data only.
    if (queryType !== 'data') {
      return answerQuery(query.id, 'This card does not use wallet requests.');
    }
    if (!data) return answerQuery(query.id, 'Empty request.');
    if (byteLengthOf(data) > WIDGET_LIMITS.queryDataBytes) {
      logger.warn('oversized widget query data', { bytes: byteLengthOf(data) });
    }

    const separator = data.indexOf(':');
    const verb = (separator === -1 ? data : data.slice(0, separator)).trim().toLowerCase();
    const argument = separator === -1 ? '' : data.slice(separator + 1).trim();

    if (verb === 'refresh' || verb === 'reload') return handleRefresh(query, target, startedAt);
    if ((verb === 'offer' || verb === 'o') && argument) return handleOfferDetails(query, argument);
    return answerQuery(query.id, `Unknown request "${clip(verb, 32)}". Try Refresh.`);
  }

  // ── callback queries (inline buttons under the card) ────────────────────
  async function onCallbackQuery(callback) {
    const data = String(callback.data ?? '');
    const chat = callback.message?.chat;
    const messageId = callback.message?.message_id;
    const messageWidget = callback.message?.widget;
    const target = {
      widgetId: messageWidget?.id,
      chatId: chat?.id,
      messageId,
      inlineMessageId: callback.inline_message_id,
    };

    logger.info('callback query', { id: callback.id, data, chat: chat?.id, message: messageId, widget: messageWidget?.id });

    try {
      if (data === 'w:new') {
        await sendWidgetTo(chat, { shared: false });
        return api.answerCallbackQuery({ callback_query_id: callback.id, text: 'New card sent' });
      }
      if (data === 'w:live') {
        await sendWidgetTo(chat, { shared: true });
        return api.answerCallbackQuery({ callback_query_id: callback.id, text: 'Live card sent' });
      }
      if (data === 'w:help') {
        if (chat) await api.sendMessage({ chat_id: chat.id, text: HELP });
        return api.answerCallbackQuery({ callback_query_id: callback.id });
      }
      if (data === 'w:refresh') {
        if (!messageWidget && !target.inlineMessageId) {
          await sendWidgetTo(chat, { shared: false });
          return api.answerCallbackQuery({ callback_query_id: callback.id, text: 'New card sent' });
        }
        const snap = await feed.getOffers({ force: true });
        const packed = await buildState(target, snap);
        const where = await writeState(target, packed.json);
        return api.answerCallbackQuery({
          callback_query_id: callback.id,
          text: where ? `Offers updated (${packed.offers})` : 'Could not update the card',
        });
      }
      return api.answerCallbackQuery({ callback_query_id: callback.id, text: 'Unknown action' });
    } catch (error) {
      logger.error('callback failed', { data, error: error.message });
      try {
        await api.answerCallbackQuery({ callback_query_id: callback.id, text: 'That did not work' });
      } catch { /* the callback may already have expired */ }
      return undefined;
    }
  }

  // ── messages / commands ─────────────────────────────────────────────────
  async function onMessage(message) {
    const chat = message.chat;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!chat || !text) return;

    if (!text.startsWith('/')) {
      if (chat.type === 'private') {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'Send /widget for the merchant card, or /help for the command list.',
        });
      }
      return;
    }

    const [head, ...rest] = text.split(/\s+/);
    const command = head.replace(/^\//, '').split('@')[0].toLowerCase();
    const args = rest.join(' ');
    logger.info('command', { command, chat: chat.id, type: chat.type });

    try {
      switch (command) {
        case 'start': {
          const name = message.from?.first_name || 'there';
          await api.sendMessage({
            chat_id: chat.id,
            text:
              `Hi ${name} 👋\n\nThis bot sends the OKX P2P merchant card as a Telegram HTML widget ` +
              `(Bot API 10.4 sendWidget). The card reads its offers from the state the bot writes and ` +
              `asks the bot for new ones with its own buttons.\n\n` +
              `Widget: ${widget.rawBytes} B html / ${widget.compressedBytes} B after zlib (limit 4096). ` +
              `Feed: ${feed.isRemote ? 'configured HTTPS feed' : 'built-in sample data'}.`,
            reply_markup: startKeyboard,
          });
          await sendWidgetTo(chat, { shared: false });
          return;
        }
        case 'help':
          return api.sendMessage({ chat_id: chat.id, text: HELP });

        case 'widget':
        case 'offers':
        case 'p2p':
          await sendWidgetTo(chat, { shared: false });
          return;

        case 'live':
        case 'shared':
          await sendWidgetTo(chat, { shared: true });
          return;

        case 'resend':
          await sendSharedAgain(chat);
          return;

        case 'refresh': {
          const messageId = store.getLastWidgetMessage(chat.id);
          if (!messageId) {
            await sendWidgetTo(chat, { shared: false });
            return;
          }
          const widgetId = store.getLastWidgetId(chat.id);
          const target = widgetId ? { widgetId } : { chatId: chat.id, messageId };
          const snap = await feed.getOffers({ force: true });
          const packed = await buildState(target, snap);
          const where = await writeState(target, packed.json);
          await api.sendMessage({
            chat_id: chat.id,
            text: where
              ? `Updated the card (message ${messageId}) with ${packed.offers} merchants · ${snap.updated}`
              : 'Could not update that card, sending a new one.',
          });
          if (!where) await sendWidgetTo(chat, { shared: false });
          return;
        }

        case 'feed': {
          const snap = await feed.getOffers({ force: true });
          const packed = packWidgetState({ offers: snap.offers, updated: snap.updated, r: 0, maxOffers: cfg.maxOffers });
          return api.sendMessage({
            chat_id: chat.id,
            text: [
              `Feed source: ${snap.sample ? 'built-in sample data' : 'configured HTTPS feed'}`,
              snap.error ? `Last error: ${snap.error}` : '',
              `Offers: ${snap.offers.length} available, ${packed.offers} sent, ${packed.dropped} dropped`,
              `State: ${packed.bytes}/1024 bytes (${packed.fields} fields per offer)`,
              `Updated: ${snap.updated}`,
              '',
              packed.json,
            ].filter(Boolean).join('\n'),
          });
        }

        case 'id':
          return api.sendMessage({ chat_id: chat.id, text: `chat id: ${chat.id}\nuser id: ${message.from?.id ?? 'unknown'}` });

        default:
          if (chat.type === 'private') {
            await api.sendMessage({ chat_id: chat.id, text: `Unknown command /${command}. Send /help.` });
          }
      }
    } catch (error) {
      logger.error('command failed', { command, error: error.message, description: error.description });
      await api.sendMessage({
        chat_id: chat.id,
        text: widgetFailureText(error),
      }).catch(() => {});
    }
  }

  function widgetFailureText(error) {
    const description = String(error?.description || error?.message || '');
    if (/too large/i.test(description)) {
      return `The widget HTML is too large for Telegram: ${description}`;
    }
    if (/not allowed|unsupported|INPUT_MEDIA_WIDGET/i.test(description)) {
      return `Telegram refused the widget: ${description}\n\nWidgets need an up-to-date Telegram client and, in production, a private chat.`;
    }
    return `Something went wrong: ${description}`;
  }

  // ── dispatch ────────────────────────────────────────────────────────────
  async function handleUpdate(update) {
    if (!update || typeof update !== 'object') return;
    try {
      if (update.widget_query) return await onWidgetQuery(update.widget_query, false);
      if (update.shared_widget_query) return await onWidgetQuery(update.shared_widget_query, true);
      if (update.callback_query) return await onCallbackQuery(update.callback_query);
      const message = update.message || update.edited_message;
      if (message) return await onMessage(message);
      logger.debug('ignored update', { keys: Object.keys(update).filter((key) => key !== 'update_id').join(',') });
    } catch (error) {
      logger.error('unhandled update error', { error: error.message, update: update.update_id });
    }
  }

  return {
    cfg,
    api,
    feed,
    widget,
    store,
    log: logger,
    handleUpdate,
    sendWidgetTo,
    sendSharedAgain,
    writeState,
    HELP,
    ALLOWED_UPDATES,
  };
}
