/**
 * An in-process stand-in for the Telegram Bot API. It keeps widget state the
 * way Telegram does, so the dev preview and the tests can exercise the exact
 * same handlers without a bot token.
 */

import { WIDGET_LIMITS, compressedSize, byteLength } from './widget.mjs';

class MockTelegramError extends Error {
  constructor(description, { method, status = 400 } = {}) {
    super(`${method ? `${method}: ` : ''}${description}`);
    this.name = 'TelegramError';
    this.description = description;
    this.method = method;
    this.status = status;
  }
}

export function createMockTelegram({ botName = 'okx_p2p_bot', firstName = 'You', userId = 111111111 } = {}) {
  const state = {
    messages: [],
    widgets: new Map(), // widget_id -> { publicData, cacheTime }
    answers: [],
    calls: [],
    webhook: { url: '', secret: '', allowedUpdates: [] },
    nextMessageId: 100,
  };

  const record = (method, params) => {
    state.calls.push({ method, params, at: Date.now() });
    return state.calls.length - 1;
  };

  const checkData = (method, name, value) => {
    if (value === undefined || value === null) return;
    const text = String(value);
    if (byteLength(text) > WIDGET_LIMITS.dataBytes) {
      throw new MockTelegramError(`${name} is ${byteLength(text)} bytes, over ${WIDGET_LIMITS.dataBytes}`, { method, status: 400 });
    }
    if (text.includes('\u0000')) throw new MockTelegramError(`${name} contains NUL`, { method, status: 400 });
  };

  function pushMessage(fields) {
    const message = { message_id: (state.nextMessageId += 1), date: Math.floor(Date.now() / 1000), chat: fields.chat, ...fields };
    state.messages.push(message);
    return message;
  }

  const findMessage = (chatId, messageId) =>
    state.messages.find((message) => message.chat?.id === chatId && message.message_id === messageId);

  const api = {
    mock: state,

    async getMe() {
      record('getMe', {});
      return { id: 999000111, is_bot: true, first_name: 'OKX P2P Widget', username: botName };
    },

    async sendMessage(params) {
      record('sendMessage', params);
      return pushMessage({ chat: { id: params.chat_id, type: 'private' }, text: params.text, reply_markup: params.reply_markup });
    },

    async answerCallbackQuery(params) {
      record('answerCallbackQuery', params);
      return true;
    },

    async sendWidget(params) {
      record('sendWidget', { ...params, html: `<${byteLength(params.html ?? '')} bytes>` });
      const html = String(params.html ?? '');
      if (!html) throw new MockTelegramError('html is empty', { method: 'sendWidget' });
      if (byteLength(html) > WIDGET_LIMITS.htmlBytes) throw new MockTelegramError('widget html is too large', { method: 'sendWidget' });
      if (compressedSize(html) > WIDGET_LIMITS.htmlCompressedBytes) {
        throw new MockTelegramError('widget html is too large after compression', { method: 'sendWidget' });
      }
      checkData('sendWidget', 'chat_data', params.chat_data);
      checkData('sendWidget', 'public_data', params.public_data);

      const widget = {
        html,
        width: params.width,
        height: params.height,
        public_data: params.public_data,
        chat_data: params.chat_data,
        can_send_queries: Boolean(params.allow_queries),
      };
      if (params.is_shared) {
        widget.id = String(7770000000000000000n + BigInt(state.widgets.size + 1));
        state.widgets.set(widget.id, { publicData: params.public_data ?? '', cacheTime: 30, lastEditAt: 0 });
      }
      return pushMessage({
        chat: { id: params.chat_id, type: 'private' },
        widget,
        caption: params.caption,
        reply_markup: params.reply_markup,
        has_protected_content: true,
      });
    },

    async sendSharedWidget(params) {
      record('sendSharedWidget', params);
      const shared = state.widgets.get(String(params.widget_id));
      if (!shared) throw new MockTelegramError('invalid widget identifier specified', { method: 'sendSharedWidget' });
      checkData('sendSharedWidget', 'chat_data', params.chat_data);
      return pushMessage({
        chat: { id: params.chat_id, type: 'private' },
        widget: { id: String(params.widget_id), public_data: shared.publicData, chat_data: params.chat_data, can_send_queries: true },
        caption: params.caption,
        has_protected_content: true,
      });
    },

    async answerWidgetQuery(params) {
      record('answerWidgetQuery', params);
      const data = params.data === undefined ? null : String(params.data);
      if (data && byteLength(data) > WIDGET_LIMITS.answerBytes) {
        throw new MockTelegramError('answer data is too large', { method: 'answerWidgetQuery' });
      }
      state.answers.push({ widget_query_id: params.widget_query_id, data, at: Date.now() });
      return true;
    },

    async editMessageWidgetData(params) {
      record('editMessageWidgetData', params);
      checkData('editMessageWidgetData', 'chat_data', params.chat_data);
      checkData('editMessageWidgetData', 'public_data', params.public_data);
      const message = findMessage(params.chat_id, params.message_id);
      if (!message?.widget) throw new MockTelegramError('message to edit not found', { method: 'editMessageWidgetData' });
      const before = JSON.stringify(message.widget);
      if (params.chat_data !== undefined) message.widget.chat_data = params.chat_data;
      if (params.public_data !== undefined) message.widget.public_data = params.public_data;
      if (before === JSON.stringify(message.widget)) throw new MockTelegramError('message is not modified', { method: 'editMessageWidgetData' });
      return true;
    },

    async editSharedWidgetData(params) {
      record('editSharedWidgetData', params);
      checkData('editSharedWidgetData', 'public_data', params.public_data);
      const shared = state.widgets.get(String(params.widget_id));
      if (!shared) throw new MockTelegramError('invalid widget identifier specified', { method: 'editSharedWidgetData' });
      if (params.cache_time !== undefined && (params.cache_time < 5 || params.cache_time > 3600)) {
        throw new MockTelegramError('invalid cache time specified', { method: 'editSharedWidgetData' });
      }
      if (shared.lastEditAt && Date.now() - shared.lastEditAt < 1000) {
        throw new MockTelegramError('FLOOD_WAIT: shared widgets may be edited once per second', { method: 'editSharedWidgetData', status: 429 });
      }
      if (shared.publicData === params.public_data) throw new MockTelegramError('message is not modified', { method: 'editSharedWidgetData' });
      shared.publicData = String(params.public_data ?? '');
      shared.lastEditAt = Date.now();
      if (params.cache_time !== undefined) shared.cacheTime = params.cache_time;
      // Every message showing a shared widget follows its shared state.
      for (const message of state.messages) {
        if (message.widget?.id === String(params.widget_id)) message.widget.public_data = shared.publicData;
      }
      return true;
    },

    async setWebhook(params) {
      record('setWebhook', params);
      state.webhook = { url: params.url, secret: params.secret_token ?? '', allowedUpdates: params.allowed_updates ?? [] };
      return true;
    },

    async deleteWebhook(params) {
      record('deleteWebhook', params ?? {});
      state.webhook = { url: '', secret: '', allowedUpdates: [] };
      return true;
    },

    async getWebhookInfo() {
      record('getWebhookInfo', {});
      return { url: state.webhook.url, has_custom_certificate: false, pending_update_count: 0 };
    },

    async getUpdates() {
      record('getUpdates', {});
      return [];
    },

    async call(method, params) {
      record(method, params);
      return true;
    },
  };

  return {
    api,
    state,
    userId,
    firstName,

    /** The last widget message the mock "sent". */
    lastWidgetMessage() {
      return [...state.messages].reverse().find((message) => message.widget) ?? null;
    },
    lastAnswer() {
      return state.answers.at(-1)?.data ?? null;
    },
    reset() {
      state.messages = [];
      state.widgets.clear();
      state.answers = [];
      state.calls = [];
      state.nextMessageId = 100;
    },

    /** Builds the update a real client would send when a button is tapped. */
    widgetQuery(data, { messageId, widgetId, inlineMessageId, from = userId } = {}) {
      const message = messageId ? findMessage(from, messageId) : this.lastWidgetMessage();
      const update = {
        update_id: 100000000 + state.answers.length + state.calls.length,
        widget_query: {
          id: `wq${Date.now()}${Math.floor(Math.random() * 1000)}`,
          from: { id: from, is_bot: false, first_name: firstName },
          chat_instance: '901234567890123456',
          type: 'data',
          data,
        },
      };
      if (inlineMessageId) {
        update.widget_query.inline_message_id = inlineMessageId;
        update.widget_query.chat_type = 'private';
      } else {
        update.widget_query.chat = { id: from, type: 'private', first_name: firstName };
        update.widget_query.message_id = message?.message_id ?? messageId;
      }
      const resolvedWidgetId = widgetId ?? message?.widget?.id;
      if (resolvedWidgetId) update.widget_query.widget_id = String(resolvedWidgetId);
      return update;
    },

    sharedWidgetQuery(data, { widgetId, from = userId } = {}) {
      const id = String(widgetId ?? [...state.widgets.keys()].at(-1) ?? '');
      return {
        update_id: 200000000 + state.calls.length,
        shared_widget_query: {
          id: `sq${Date.now()}`,
          from: { id: from, is_bot: false, first_name: firstName },
          type: 'data',
          data,
          widget_id: id,
        },
      };
    },

    messageUpdate(text, { chatId = userId, type = 'private' } = {}) {
      return {
        update_id: 300000000 + state.calls.length,
        message: {
          message_id: (state.nextMessageId += 1),
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type, first_name: firstName },
          from: { id: chatId, is_bot: false, first_name: firstName },
          text,
        },
      };
    },

    callbackUpdate(data, { messageId, chatId = userId } = {}) {
      const message = messageId ? findMessage(chatId, messageId) : this.lastWidgetMessage();
      return {
        update_id: 400000000 + state.calls.length,
        callback_query: {
          id: `cb${Date.now()}`,
          from: { id: chatId, is_bot: false, first_name: firstName },
          chat_instance: '901234567890123456',
          data,
          message: message ?? undefined,
        },
      };
    },
  };
}
