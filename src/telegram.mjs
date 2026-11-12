/**
 * A dependency-free Telegram Bot API client (Bot API 10.4) with the widget
 * methods: sendWidget, sendSharedWidget, answerWidgetQuery,
 * editMessageWidgetData, editSharedWidgetData.
 */

export class TelegramError extends Error {
  constructor(description, { method, status, code, parameters } = {}) {
    super(`${method ? `${method}: ` : ''}${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.code = code;
    this.parameters = parameters;
    this.description = description;
  }

  get isFlood() {
    return this.status === 429 || /flood/i.test(this.description || '');
  }

  get retryAfter() {
    return Number(this.parameters?.retry_after) || 0;
  }
}

/** Removes undefined/null so omitted optional params stay omitted. */
export function cleanParams(params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTelegramClient({
  token,
  apiRoot = 'https://api.telegram.org',
  fetchImpl = globalThis.fetch,
  log = console,
  timeoutMs = 20_000,
  retries = 2,
} = {}) {
  if (!token) throw new Error('createTelegramClient: a bot token is required');

  async function call(method, params = {}, options = {}) {
    const body = JSON.stringify(cleanParams(params));
    const maxRetries = options.retries ?? retries;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${apiRoot}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (error?.name === 'AbortError') {
          if (attempt < maxRetries) { attempt += 1; await sleep(500 * attempt); continue; }
          throw new TelegramError(`timed out after ${options.timeoutMs ?? timeoutMs}ms`, { method, status: 0 });
        }
        if (attempt < maxRetries) { attempt += 1; await sleep(500 * attempt); continue; }
        throw new TelegramError(error?.message || 'network error', { method, status: 0 });
      }
      clearTimeout(timer);

      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* non-JSON error page */ }

      if (response.ok && payload?.ok) return payload.result;

      const description = payload?.description || `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
      const error = new TelegramError(description, {
        method,
        status: response.status,
        code: payload?.error_code,
        parameters: payload?.parameters,
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        const wait = error.retryAfter ? Math.min(error.retryAfter, 5) * 1000 : 500 * (attempt + 1);
        log.warn?.('telegram retry', { method, status: response.status, wait, attempt: attempt + 1 });
        attempt += 1;
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }

  return {
    call,

    // ── Core ──────────────────────────────────────────────────────────────
    getMe: () => call('getMe'),
    sendMessage: (params) => call('sendMessage', params),
    answerCallbackQuery: (params) => call('answerCallbackQuery', params),
    editMessageCaption: (params) => call('editMessageCaption', params),
    getUpdates: (params) => call('getUpdates', params, { timeoutMs: 60_000, retries: 0 }),
    setWebhook: (params) => call('setWebhook', params),
    deleteWebhook: (params) => call('deleteWebhook', params),
    getWebhookInfo: () => call('getWebhookInfo'),

    // ── Bot API 10.4 widgets ──────────────────────────────────────────────
    /** Send a message with an HTML widget. Private chats only in production. */
    sendWidget: (params) => call('sendWidget', params),
    /** Send an existing shared widget again, by its identifier. */
    sendSharedWidget: (params) => call('sendSharedWidget', params),
    /** Answer a widget_query / shared_widget_query within 15 seconds. */
    answerWidgetQuery: (params) => call('answerWidgetQuery', params, { timeoutMs: 5_000, retries: 0 }),
    /** Change chat_data / public_data of one widget message. */
    editMessageWidgetData: (params) => call('editMessageWidgetData', params),
    /** Change public_data of a shared widget everywhere (max 1/second). */
    editSharedWidgetData: (params) => call('editSharedWidgetData', params),
  };
}
