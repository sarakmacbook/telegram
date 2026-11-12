/**
 * Vercel bot-token management page. GET / is rewritten here by vercel.json.
 */

import { getStoredBotToken, inspectTokenSetup } from '../src/token-store.mjs';

function page({ ready, configured, storageUnavailable, missing }) {
  const disabled = ready ? '' : ' disabled';
  const status = storageUnavailable
    ? '<div class="notice error">The saved token could not be read. You can try replacing it; if Redis is unavailable, the save will fail.</div>'
    : configured
      ? '<div class="notice good">A bot token is configured. Its value is never shown here.</div>'
      : '<div class="notice">No bot token is configured yet.</div>';
  const setup = ready
    ? '<p class="muted">Your submission is encrypted before it is saved. A saved token takes precedence over <code>BOT_TOKEN</code> and <code>TELEGRAM_BOT_TOKEN</code>; no redeploy is needed.</p>'
    : `<section class="requirements"><strong>One-time setup required before the form can be used</strong><p>Attach a Vercel Redis/Upstash database, then add these server-only environment variables in Vercel:</p><ul>${missing.map((item) => `<li><code>${item}</code></li>`).join('')}</ul><p>Use random values of at least 32 characters for <code>BOT_TOKEN_STORE_KEY</code> and <code>BOT_TOKEN_SETUP_PASSWORD</code>. Generate each with <code>openssl rand -hex 32</code>. Redeploy after configuring them.</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Bot token settings</title>
  <style>
    :root{--bg:#10151b;--panel:#19212a;--line:#2a3642;--text:#e9f0f6;--muted:#a3b0bd;--accent:#68b7ff;--good:#72d5a0;--warn:#ffcb66;--bad:#ff8a8a}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 10% 0,#19324a 0,transparent 48%),var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}
    main{width:min(100%,700px);background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:clamp(24px,6vw,44px);box-shadow:0 24px 70px #0005}
    .brand{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.mark{width:34px;height:34px;border-radius:11px;background:#277fc2;display:grid;place-items:center;color:white;font-size:18px}
    h1{font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.035em;margin:26px 0 10px}p{color:var(--muted);margin:0 0 16px}.notice,.requirements{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:22px 0;color:var(--muted);background:#111820}.notice.good{color:var(--good)}.notice.error{color:var(--bad)}
    .requirements strong{color:var(--warn)}.requirements ul{padding-left:22px;color:var(--muted)}.requirements li{margin:4px 0}.muted{font-size:13px}.form{display:grid;gap:16px;margin-top:26px}.field{display:grid;gap:7px;font-weight:650}.field span{font-size:13px;color:var(--muted)}input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid var(--line);background:#10151b;color:var(--text);font:15px ui-monospace,monospace}input:focus{outline:2px solid var(--accent);outline-offset:2px}button{border:0;border-radius:10px;padding:13px 18px;background:var(--accent);color:#07111a;font:700 15px system-ui,sans-serif;cursor:pointer}button:disabled,input:disabled{opacity:.5;cursor:not-allowed}.foot{border-top:1px solid var(--line);padding-top:18px;margin-top:24px;font-size:13px}.foot a{color:var(--accent);text-decoration:none}.foot a:hover{text-decoration:underline}code{padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:#10151b;color:#b9dcff;font:12px ui-monospace,monospace;overflow-wrap:anywhere}
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark" aria-hidden="true">↗</span> OKX P2P Widget Bot</div>
    <h1>Bot token settings</h1>
    <p>Enter a Telegram bot token to set or replace the token used by this deployment.</p>
    ${status}
    ${setup}
    <form class="form" action="/api/token" method="post" autocomplete="off">
      <label class="field"><span>Telegram bot token</span><input name="botToken" type="password" inputmode="text" maxlength="512" autocomplete="new-password" required${disabled}></label>
      <label class="field"><span>Setup password</span><input name="setupPassword" type="password" maxlength="512" autocomplete="current-password" required${disabled}></label>
      <button type="submit"${disabled}>Save bot token</button>
    </form>
    <p class="foot">The token is encrypted at rest and never returned by the site. The setup password is required to change it. <a href="/api/status">View bot status</a></p>
  </main>
</body>
</html>`;
}

function setPageHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
}

export function createIndexHandler({ env = process.env, readToken = getStoredBotToken } = {}) {
  return async function handler(req, res) {
    setPageHeaders(res);
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      return res.status(405).send('Method not allowed\n');
    }

    const setup = inspectTokenSetup(env);
    const configuredFromEnv = [env.BOT_TOKEN, env.TELEGRAM_BOT_TOKEN]
      .some((value) => String(value ?? '').trim().length > 0);
    let configured = configuredFromEnv;
    let storageUnavailable = false;

    if (setup.storageConfigured) {
      try {
        configured = Boolean(await readToken({ env })) || configured;
      } catch {
        storageUnavailable = true;
      }
    }

    const ready = setup.ready && setup.storageConfigured;
    return res.status(200).send(page({
      ready,
      configured,
      storageUnavailable,
      missing: setup.missing,
    }));
  };
}

export default createIndexHandler();
