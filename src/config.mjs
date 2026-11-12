/**
 * Configuration + logging.
 *
 * Every value comes from the environment so the same code runs locally
 * (long polling) and on Vercel (serverless webhook).
 */

const DEFAULT_API_ROOT = 'https://api.telegram.org';

function str(env, key, fallback = '') {
  const value = env[key];
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
}

function int(env, key, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(env, key, '');
  if (raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(env, key, fallback) {
  const raw = str(env, key, '');
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** Reads and validates the environment. Never throws: problems are reported. */
export function loadConfig(env = process.env) {
  const cfg = {
    token: str(env, 'BOT_TOKEN') || str(env, 'TELEGRAM_BOT_TOKEN'),
    apiRoot: str(env, 'TELEGRAM_API_ROOT', DEFAULT_API_ROOT).replace(/\/+$/, ''),

    widgetPath: str(env, 'WIDGET_PATH', 'index.html'),
    maxOffers: int(env, 'MAX_OFFERS', 3, { min: 1, max: 10 }),
    widgetWidth: env.WIDGET_WIDTH ? int(env, 'WIDGET_WIDTH', 0, { min: 200, max: 600 }) : undefined,
    widgetHeight: env.WIDGET_HEIGHT ? int(env, 'WIDGET_HEIGHT', 0, { min: 50, max: 600 }) : undefined,

    feedUrl: str(env, 'FEED_URL'),
    // Bound feed waits so widget queries can be answered before their 15-second expiry.
    feedTimeoutMs: int(env, 'FEED_TIMEOUT_MS', 6000, { min: 500, max: 8000 }),
    feedCacheMs: int(env, 'FEED_CACHE_MS', 30000, { min: 0, max: 3_600_000 }),

    sharedCacheTime: int(env, 'SHARED_CACHE_TIME', 15, { min: 5, max: 3600 }),
    sharedWidgetId: str(env, 'SHARED_WIDGET_ID'),

    webhookUrl: str(env, 'WEBHOOK_URL'),
    webhookSecret: str(env, 'WEBHOOK_SECRET'),
    webhookPath: str(env, 'WEBHOOK_PATH', '/api/webhook'),
    autoSetWebhook: bool(env, 'AUTO_SET_WEBHOOK', true),

    port: int(env, 'PORT', 3000, { min: 1, max: 65535 }),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    logFormat: str(env, 'LOG_FORMAT', 'pretty'),
  };

  const problems = [];
  if (!cfg.token) problems.push('BOT_TOKEN is not set — get one from @BotFather');
  if (cfg.feedUrl && !/^https:\/\//i.test(cfg.feedUrl)) problems.push('FEED_URL must be an https:// URL');
  if (cfg.webhookUrl && !/^https:\/\//i.test(cfg.webhookUrl)) problems.push('WEBHOOK_URL must be an https:// URL');
  if (cfg.webhookUrl && !cfg.webhookSecret) problems.push('WEBHOOK_URL is set but WEBHOOK_SECRET is empty');
  cfg.problems = problems;
  return cfg;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Small structured logger: pretty lines locally, JSON on Vercel. */
export function createLogger({ level = 'info', format = 'pretty', scope = 'bot' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name, message, fields) => {
    if ((LEVELS[name] ?? 20) < threshold) return;
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: name, scope, message, ...fields })}\n`);
      return;
    }
    const extra = fields && Object.keys(fields).length
      ? ` ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}`
      : '';
    const line = `${new Date().toISOString().slice(11, 19)} ${name.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`;
    (name === 'error' || name === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childScope) => createLogger({ level, format, scope: `${scope}:${childScope}` }),
  };
}

export function loggerFromConfig(cfg) {
  return createLogger({ level: cfg.logLevel, format: cfg.logFormat });
}
