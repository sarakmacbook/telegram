import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTokenStore,
  inspectTokenSetup,
  resolveTokenEnvironment,
  verifySetupPassword,
} from '../src/token-store.mjs';
import { createTokenHandler } from '../api/token.mjs';

const setupKey = 's'.repeat(64);
const encryptionKey = 'e'.repeat(64);
const tokenEnv = {
  KV_REST_API_URL: 'https://redis.example.test',
  KV_REST_API_TOKEN: 'redis-test-credential',
  BOT_TOKEN_STORE_KEY: encryptionKey,
  BOT_TOKEN_SETUP_PASSWORD: setupKey,
  VERCEL_ENV: 'preview',
  BOT_TOKEN: 'old-environment-token',
  TELEGRAM_BOT_TOKEN: 'legacy-environment-token',
};

function makeRedis() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return 'OK'; },
  };
}

function makeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
}

test('token setup reports readiness without exposing secret values', () => {
  const status = inspectTokenSetup(tokenEnv);
  assert.equal(status.storageConfigured, true);
  assert.equal(status.setupPasswordConfigured, true);
  assert.equal(status.ready, true);
  assert.doesNotMatch(JSON.stringify(status), /redis-test-credential|ssssssss|eeeeeeee/);
  assert.deepEqual(inspectTokenSetup({}).missing, [
    'KV_REST_API_URL or UPSTASH_REDIS_REST_URL',
    'KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN',
    'BOT_TOKEN_STORE_KEY (at least 32 characters)',
    'BOT_TOKEN_SETUP_PASSWORD (at least 32 characters)',
  ]);
});

test('bot tokens are encrypted at rest and decrypt across requests', async () => {
  const redis = makeRedis();
  const store = createTokenStore({ env: tokenEnv, client: redis });
  const token = '123456789:telegram-bot-secret-value';

  await store.setToken(token);
  const ciphertext = redis.values.get(store.key);
  assert.match(ciphertext, /^v1\./);
  assert.notEqual(ciphertext, token);
  assert.equal(ciphertext.includes(token), false);
  assert.equal(await store.getToken(), token);

  const resolved = await resolveTokenEnvironment(tokenEnv, { client: redis });
  assert.equal(resolved.BOT_TOKEN, token);
  assert.equal(resolved.TELEGRAM_BOT_TOKEN, tokenEnv.TELEGRAM_BOT_TOKEN);
});

test('a saved token replaces the active override, and tampering fails closed', async () => {
  const redis = makeRedis();
  const store = createTokenStore({ env: tokenEnv, client: redis });
  await store.setToken('first-token-value');
  await store.setToken('replacement-token-value');
  assert.equal(await store.getToken(), 'replacement-token-value');

  redis.values.set(store.key, `${redis.values.get(store.key)}tampered`);
  await assert.rejects(store.getToken(), /could not be decrypted/);
});

test('setup password comparison accepts only the configured secret', () => {
  assert.equal(verifySetupPassword(setupKey, setupKey), true);
  assert.equal(verifySetupPassword('wrong-password', setupKey), false);
  assert.equal(verifySetupPassword(setupKey, 'short'), false);
});

test('token form requires same-origin admin authentication and saves without echoing secrets', async () => {
  const redis = makeRedis();
  const handler = createTokenHandler({
    env: tokenEnv,
    createStore: (options) => createTokenStore({ ...options, client: redis }),
  });
  const token = '987654321:replacement-bot-token';
  const form = { botToken: token, setupPassword: setupKey };
  const headers = {
    origin: 'https://bot.example.test',
    host: 'bot.example.test',
    'content-type': 'application/x-www-form-urlencoded',
  };

  const denied = makeResponse();
  await handler({ method: 'POST', headers, body: { ...form, setupPassword: 'wrong' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(redis.values.size, 0);

  const crossOrigin = makeResponse();
  await handler({
    method: 'POST',
    headers: { ...headers, origin: 'https://attacker.example' },
    body: form,
  }, crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(redis.values.size, 0);

  const saved = makeResponse();
  await handler({ method: 'POST', headers, body: new URLSearchParams(form).toString() }, saved);
  assert.equal(saved.statusCode, 200);
  assert.match(saved.body, /Bot token saved/);
  assert.doesNotMatch(saved.body, new RegExp(token));
  assert.doesNotMatch(saved.body, new RegExp(setupKey));

  const resolved = await resolveTokenEnvironment(tokenEnv, { client: redis });
  assert.equal(resolved.BOT_TOKEN, token);
});

test('token form refuses setup when persistent storage prerequisites are absent', async () => {
  let storeWasCalled = false;
  const handler = createTokenHandler({
    env: {},
    createStore: () => { storeWasCalled = true; throw new Error('should not run'); },
  });
  const res = makeResponse();
  await handler({ method: 'POST', headers: {}, body: { botToken: 'test-token', setupPassword: 'test' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(storeWasCalled, false);
});
