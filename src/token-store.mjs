import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

const TOKEN_NAMESPACE = 'okx-p2p-widget-bot';
const TOKEN_VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;

export class TokenStoreConfigurationError extends Error {
  constructor(message = 'Bot token storage is not configured') {
    super(message);
    this.name = 'TokenStoreConfigurationError';
  }
}

function value(env, ...keys) {
  for (const key of keys) {
    const found = String(env?.[key] ?? '').trim();
    if (found) return found;
  }
  return '';
}

/** Safe readiness details for the public setup page; never returns secret values. */
export function inspectTokenSetup(env = process.env) {
  const url = value(env, 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
  const token = value(env, 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
  const encryptionKey = value(env, 'BOT_TOKEN_STORE_KEY');
  const setupPassword = value(env, 'BOT_TOKEN_SETUP_PASSWORD');

  const storageMissing = [];
  if (!url) storageMissing.push('KV_REST_API_URL or UPSTASH_REDIS_REST_URL');
  if (!token) storageMissing.push('KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN');
  if (encryptionKey.length < MIN_SECRET_LENGTH) storageMissing.push('BOT_TOKEN_STORE_KEY (at least 32 characters)');

  const setupPasswordConfigured = setupPassword.length >= MIN_SECRET_LENGTH;
  return {
    storageConfigured: storageMissing.length === 0,
    setupPasswordConfigured,
    ready: storageMissing.length === 0 && setupPasswordConfigured,
    storageMissing,
    setupPasswordMissing: setupPasswordConfigured ? [] : ['BOT_TOKEN_SETUP_PASSWORD (at least 32 characters)'],
    missing: [
      ...storageMissing,
      ...(setupPasswordConfigured ? [] : ['BOT_TOKEN_SETUP_PASSWORD (at least 32 characters)']),
    ],
  };
}

function storageConfig(env) {
  const status = inspectTokenSetup(env);
  if (!status.storageConfigured) throw new TokenStoreConfigurationError();
  return {
    url: value(env, 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL'),
    token: value(env, 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'),
    encryptionKey: value(env, 'BOT_TOKEN_STORE_KEY'),
    redisKey: redisKeyFor(env),
  };
}

function redisKeyFor(env) {
  const namespace = value(env, 'BOT_TOKEN_STORE_NAMESPACE') || TOKEN_NAMESPACE;
  const stage = value(env, 'VERCEL_ENV') || 'development';
  const safe = (part) => part.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return `${TOKEN_NAMESPACE}:${safe(namespace)}:${safe(stage)}:bot-token`;
}

function encryptionKey(secret) {
  if (String(secret ?? '').length < MIN_SECRET_LENGTH) throw new TokenStoreConfigurationError();
  return createHash('sha256').update(String(secret), 'utf8').digest();
}

function encryptToken(token, secret, associatedData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [TOKEN_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptToken(payload, secret, associatedData) {
  try {
    const [version, ivText, tagText, ciphertextText, extra] = String(payload).split('.');
    if (version !== TOKEN_VERSION || !ivText || !tagText || !ciphertextText || extra !== undefined) throw new Error('bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Do not include ciphertext, key material, or crypto internals in errors.
    throw new Error('Stored bot token could not be decrypted; check BOT_TOKEN_STORE_KEY');
  }
}

function redisClient(config) {
  return new Redis({ url: config.url, token: config.token, automaticDeserialization: false });
}

/**
 * Creates an encrypted token-store adapter. Inject redisClient in tests; in
 * production it uses the Vercel/Upstash Redis REST credentials from env.
 */
export function createTokenStore({ env = process.env, client } = {}) {
  const config = storageConfig(env);
  const redis = client || redisClient(config);

  return {
    key: config.redisKey,
    async getToken() {
      const stored = await redis.get(config.redisKey);
      if (stored === null || stored === undefined || stored === '') return null;
      if (typeof stored !== 'string') throw new Error('Stored bot token has an invalid format');
      return decryptToken(stored, config.encryptionKey, config.redisKey);
    },
    async setToken(token) {
      await redis.set(config.redisKey, encryptToken(token, config.encryptionKey, config.redisKey));
    },
  };
}

export async function getStoredBotToken({ env = process.env, client } = {}) {
  const status = inspectTokenSetup(env);
  const hasStorageSettings = Boolean(
    value(env, 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL') ||
    value(env, 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN') ||
    value(env, 'BOT_TOKEN_STORE_KEY'),
  );
  if (!hasStorageSettings) return null;
  if (!status.storageConfigured) throw new TokenStoreConfigurationError();
  return createTokenStore({ env, client }).getToken();
}

/** Return a copy of env where a saved token takes precedence over Vercel env vars. */
export async function resolveTokenEnvironment(env = process.env, options = {}) {
  const storedToken = await getStoredBotToken({ env, ...options });
  return storedToken ? { ...env, BOT_TOKEN: storedToken } : env;
}

/** Constant-time comparison for the setup password. */
export function verifySetupPassword(candidate, expected) {
  const expectedValue = typeof expected === 'string' ? expected.trim() : '';
  if (typeof candidate !== 'string' || expectedValue.length < MIN_SECRET_LENGTH) return false;
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expectedValue, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}
