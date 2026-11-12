/**
 * Vercel status/setup page. GET / is rewritten here by vercel.json.
 */

import { createApp, describeApp } from '../src/app.mjs';

const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Finish bot setup</title>
  <style>
    :root{color-scheme:light dark;--bg:#10151b;--panel:#19212a;--line:#2a3642;--text:#e9f0f6;--muted:#9aa8b5;--accent:#68b7ff;--warning:#ffcb66}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 10% 0,#19324a 0,transparent 48%),var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;padding:24px}
    main{width:min(100%,680px);background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:clamp(24px,6vw,44px);box-shadow:0 24px 70px #0005}
    .brand{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    .mark{width:34px;height:34px;border-radius:11px;background:#277fc2;display:grid;place-items:center;color:white;font-size:18px}
    .status{display:inline-flex;align-items:center;gap:8px;margin-top:30px;padding:5px 10px;border-radius:999px;background:#4c3b1b;color:var(--warning);font-size:12px;font-weight:700}
    .dot{width:7px;height:7px;border-radius:50%;background:currentColor}h1{font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.035em;margin:16px 0 12px}
    p{color:var(--muted);margin:0 0 18px}.steps{display:grid;gap:12px;padding:0;list-style:none;counter-reset:step;margin:26px 0}
    .steps li{counter-increment:step;display:grid;grid-template-columns:30px 1fr;gap:12px;align-items:start;color:var(--muted)}
    .steps li:before{content:counter(step);display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:9px;color:var(--accent);font-size:12px;font-weight:800}
    strong{color:var(--text)}code{padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:#10151b;color:#b9dcff;font:13px ui-monospace,monospace;overflow-wrap:anywhere}
    .note{border-top:1px solid var(--line);padding-top:18px;font-size:13px}.link{display:inline-block;margin-top:6px;color:var(--accent);font-weight:700;text-decoration:none}.link:hover{text-decoration:underline}
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark" aria-hidden="true">↗</span> OKX P2P Widget Bot</div>
    <div class="status"><span class="dot"></span> Setup required</div>
    <h1>Connect your Telegram bot</h1>
    <p>This deployment is running, but it cannot start the bot because the required <code>BOT_TOKEN</code> environment variable is missing. No token is requested or stored on this page.</p>
    <ol class="steps">
      <li>Open this project in the <strong>Vercel Dashboard</strong>, then go to <strong>Settings → Environment Variables</strong>.</li>
      <li>Add <code>BOT_TOKEN</code> using the token from <strong>@BotFather</strong>. Select the environments you deploy to.</li>
      <li>For webhook mode, also set <code>WEBHOOK_URL</code> to <code>https://your-project.vercel.app/api/webhook</code> and add a private <code>WEBHOOK_SECRET</code>.</li>
      <li>Redeploy. This page will then show the bot and webhook status.</li>
    </ol>
    <p class="note">Keep the bot token secret. Enter it only in Vercel’s environment-variable settings, never in this public page or a chat.</p>
    <a class="link" href="https://vercel.com/dashboard" rel="noreferrer">Open Vercel Dashboard ↗</a>
  </main>
</body>
</html>`;

let appPromise = null;
const getApp = () => (appPromise ??= createApp({ env: process.env }));

function hasBotToken(env = process.env) {
  return [env.BOT_TOKEN, env.TELEGRAM_BOT_TOKEN].some((value) => String(value ?? '').trim().length > 0);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-robots-tag', 'noindex, nofollow');

  // Avoid constructing the Telegram client without a token. Show a safe,
  // actionable setup page instead of leaking the thrown exception as JSON.
  if (!hasBotToken()) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return res.status(200).send(SETUP_HTML);
  }

  try {
    const app = await getApp();
    const description = await describeApp(app);
    const webhook = app.cfg.token
      ? await app.api.getWebhookInfo().catch((error) => ({ error: error.message }))
      : null;

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.status(200).send(
      JSON.stringify(
        {
          service: 'okx-p2p-widget-bot',
          botApi: '10.4 (widgets)',
          ...description,
          webhookInfo: webhook,
          next: {
            webhook: 'POST /api/webhook (Telegram only)',
            setup: 'POST /api/setup to register the webhook',
            local: 'npm run dev for the widget preview, npm start for polling',
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.status(500).send(JSON.stringify({ ok: false, error: error.message }));
  }
}
