/**
 * Local widget preview: renders index.html in a bubble against a mock Telegram
 * client, so you can tap its buttons and watch the real handler code answer
 * widget queries and edit widget state — no bot token, no Telegram account.
 *
 *   npm run dev   ->  http://localhost:3000
 */

import { createMockTelegram } from './mock-telegram.mjs';
import { describeApp } from './app.mjs';

/** Stands in for window.TelegramWidget inside the preview frame. */
const SHIM = `<script>
(function(){
  var listeners={}, pending={}, seq=0, state={chatData:null, publicData:null};
  function fire(type){ (listeners[type]||[]).forEach(function(fn){ try{ fn({type:type}); }catch(e){ console.error(e); } }); }
  function post(msg){ parent.postMessage(msg, '*'); }
  var api = {
    profile: 1,
    isProfileAtLeast: function(n){ return typeof n === 'number' && n <= 1; },
    colorScheme: 'light',
    themeParams: {},
    isActive: true, isPreview: false, isForward: false, chatType: 'private',
    viewer: { id: 111111111, first_name: 'You' },
    get chatData(){ return state.chatData; },
    get publicData(){ return state.publicData; },
    onEvent: function(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    offEvent: function(type, fn){ listeners[type] = (listeners[type]||[]).filter(function(f){ return f !== fn; }); },
    watchPublicData: function(){ post({ t: 'watch' }); },
    unwatchPublicData: function(){ post({ t: 'unwatch' }); },
    copyText: function(v){ post({ t: 'copy', v: String(v) }); },
    openLink: function(u){ post({ t: 'open', u: String(u) }); },
    request: function(data){
      var id = ++seq;
      return new Promise(function(resolve, reject){
        pending[id] = { resolve: resolve, reject: reject };
        post({ t: 'request', id: id, data: String(data) });
        setTimeout(function(){ if(pending[id]){ delete pending[id]; var e=new Error('TIMEOUT'); e.code='TIMEOUT'; reject(e); } }, 15000);
      });
    },
    _init: function(d){ state.chatData = d.chatData || null; state.publicData = d.publicData || null; },
    _answer: function(d){
      var p = pending[d.id]; delete pending[d.id];
      var chatChanged = d.chatData !== undefined && d.chatData !== state.chatData;
      var publicChanged = d.publicData !== undefined && d.publicData !== state.publicData;
      if (d.chatData !== undefined) state.chatData = d.chatData || null;
      if (d.publicData !== undefined) state.publicData = d.publicData || null;
      if (!p) return;
      if (d.ok) p.resolve({ result: d.result === undefined ? null : d.result });
      else { var err = new Error(d.result || 'FAILED'); err.code = d.result || 'FAILED'; p.reject(err); }
      if (chatChanged) fire('chatDataChanged');
      if (publicChanged) fire('publicDataChanged');
    }
  };
  window.addEventListener('message', function(event){
    var d = event.data;
    if (!d || d.target !== 'widget') return;
    if (d.type === 'init') api._init(d);
    if (d.type === 'answer') api._answer(d);
  });
  window.TelegramWidget = api;
  post({ t: 'ready' });
})();
</script>`;

/** Mirrors what a Telegram client does: no external resources, no network. */
function toPreviewHtml(html) {
  const stripped = [];
  let out = String(html).replace(/<script[^>]+src\s*=[^>]*>\s*<\/script>/gi, (match) => {
    stripped.push(match);
    return '';
  });
  out = out.replace(/<link\b[^>]*>/gi, (match) => {
    stripped.push(match);
    return '';
  });
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1>${SHIM}`);
  else out = `${SHIM}${out}`;
  return { html: out, stripped };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Widget dev console · sendWidget</title>
<style>
:root{color-scheme:light dark;--bg:#0f1419;--panel:#171d24;--line:#253039;--text:#e6edf3;--hint:#8b98a5;--accent:#2ea6ff;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:-.01em}
header p{margin:0;color:var(--hint);font-size:12px}
main{display:grid;grid-template-columns:minmax(320px,1fr) minmax(360px,420px);gap:18px;padding:18px 22px 40px;align-items:start}
@media(max-width:900px){main{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.panel h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--hint);margin:0 0 10px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
button{background:#202a33;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font:600 12px inherit;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#04121f}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px;margin:0 0 12px}
.kv dt{color:var(--hint)}
.kv dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all}
.badge{display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:700;background:#202a33;color:var(--hint)}
.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.err{color:var(--err)}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 10px;max-height:260px}
.log{max-height:320px;overflow:auto;font:11px/1.6 ui-monospace,Menlo,monospace}
.log div{border-bottom:1px solid #1c242c;padding:4px 0;word-break:break-word}
.log .m{color:var(--accent);font-weight:700}
.log .t{color:var(--hint)}
.phone{background:#0b0f14;border:1px solid var(--line);border-radius:18px;padding:12px}
.bubble{background:#202a33;border-radius:14px;padding:8px 10px 10px;position:relative}
.bubble .time{position:absolute;right:10px;bottom:6px;font-size:10px;color:var(--hint)}
iframe{width:100%;height:600px;border:0;display:block;background:transparent}
.note{color:var(--hint);font-size:11px;margin:8px 0 0}
code{background:#0b0f14;border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:11px}
</style>
</head>
<body>
<header>
  <h1>Widget dev console</h1>
  <p>index.html rendered in a bubble against a mock Telegram client — the same handler code runs as in production.</p>
</header>
<main>
  <section>
    <div class="panel">
      <h2>Bot</h2>
      <dl class="kv" id="info"></dl>
      <div class="row">
        <button data-cmd="/start">/start</button>
        <button data-cmd="/widget" class="primary">/widget</button>
        <button data-cmd="/live">/live</button>
        <button data-cmd="/resend">/resend</button>
        <button data-cmd="/refresh">/refresh</button>
        <button data-cmd="/feed">/feed</button>
        <button data-cmd="/help">/help</button>
      </div>
      <div class="row">
        <button data-cb="w:refresh">inline: refresh</button>
        <button data-cb="w:live">inline: live</button>
        <button data-cb="w:new">inline: new</button>
        <button id="reset">reset mock</button>
      </div>
      <p class="note">A command sends a new widget message; the frame reloads with the state Telegram would push into it.</p>
    </div>

    <div class="panel" style="margin-top:18px">
      <h2>Widget state <span class="badge" id="state-kind">—</span></h2>
      <pre id="state">no widget sent yet</pre>
    </div>

    <div class="panel" style="margin-top:18px">
      <h2>Bot API calls</h2>
      <div class="log" id="log"></div>
    </div>
  </section>

  <section>
    <div class="panel">
      <h2>Bubble preview <span class="badge">600 px max height</span></h2>
      <div class="phone"><div class="bubble">
        <iframe id="frame" title="widget preview" src="/widget.html"></iframe>
        <span class="time">now</span>
      </div></div>
      <p class="note" id="caption">caption</p>
      <p class="note" id="stripped"></p>
    </div>
  </section>
</main>

<script>
var frame = document.getElementById('frame');
var state = { chatData: null, publicData: null };

function post(msg){ frame.contentWindow.postMessage(Object.assign({ target: 'widget' }, msg), '*'); }

async function api(path, body){
  var res = await fetch(path, body ? { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : undefined);
  return res.json();
}

async function refresh(){
  var snap = await api('/api/state');
  state.chatData = snap.chatData; state.publicData = snap.publicData;
  document.getElementById('state').textContent = JSON.stringify(JSON.parse((snap.chatData || snap.publicData) || 'null'), null, 2);
  document.getElementById('state-kind').textContent = snap.chatData ? 'chat_data' : (snap.publicData ? 'public_data' : 'empty');
  document.getElementById('caption').textContent = snap.caption || 'no caption';
  document.getElementById('info').innerHTML = Object.entries(snap.app || {}).map(function(e){
    return '<dt>' + e[0] + '</dt><dd>' + String(e[1]) + '</dd>';
  }).join('');
  var log = document.getElementById('log');
  log.innerHTML = (snap.calls || []).slice(-60).reverse().map(function(c){
    return '<div><span class="m">' + c.method + '</span> <span class="t">' + escapeHtml(c.params) + '</span></div>';
  }).join('');
  post({ type: 'init', chatData: state.chatData, publicData: state.publicData });
}

function escapeHtml(value){
  return String(value).replace(/[&<>]/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]; });
}

window.addEventListener('message', async function(event){
  var msg = event.data;
  if (!msg || !msg.t) return;
  if (msg.t === 'ready') { post({ type: 'init', chatData: state.chatData, publicData: state.publicData }); return; }
  if (msg.t === 'copy' || msg.t === 'open') { flash(msg.t + ': ' + (msg.v || msg.u)); return; }
  if (msg.t !== 'request') return;
  var answer = await api('/api/tap', { data: msg.data });
  flash((answer.ok ? '→ ' : '✕ ') + (answer.result || ''));
  post({ type: 'answer', id: msg.id, ok: answer.ok, result: answer.result, chatData: answer.chatData, publicData: answer.publicData });
  refresh();
});

function flash(message){
  var note = document.getElementById('stripped');
  note.textContent = 'answerWidgetQuery ' + message;
  setTimeout(function(){ if (note.textContent.startsWith('answerWidgetQuery')) note.textContent = ''; }, 6000);
}

document.querySelectorAll('[data-cmd]').forEach(function(btn){
  btn.addEventListener('click', async function(){
    await api('/api/command', { text: btn.dataset.cmd });
    frame.src = '/widget.html?ts=' + Date.now();
    setTimeout(refresh, 120);
  });
});
document.querySelectorAll('[data-cb]').forEach(function(btn){
  btn.addEventListener('click', async function(){ await api('/api/callback', { data: btn.dataset.cb }); refresh(); });
});
document.getElementById('reset').addEventListener('click', async function(){ await api('/api/reset', {}); frame.src = '/widget.html?ts=' + Date.now(); setTimeout(refresh, 120); });

fetch('/api/preview-info').then(function(r){ return r.json(); }).then(function(d){
  document.getElementById('stripped').textContent = d.stripped.length
    ? 'Removed by the widget profile (no network in a widget): ' + d.stripped.length + ' external tag(s).'
    : 'Nothing removed by the widget profile.';
});
refresh();
</script>
</body>
</html>`;

/** Routes for the dev server. `app` must be built with the mock Telegram client. */
export function createDevRoutes({ app, mock }) {
  const preview = toPreviewHtml(app.widget.html);

  const sendJson = (send, payload, status = 200) =>
    send({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) });

  const widgetSnapshot = () => {
    const message = mock.lastWidgetMessage();
    return {
      chatData: message?.widget?.chat_data ?? null,
      publicData: message?.widget?.public_data ?? null,
      widgetId: message?.widget?.id ?? null,
      caption: message?.caption ?? null,
      messageId: message?.message_id ?? null,
      answer: mock.lastAnswer(),
      calls: mock.state.calls.slice(-80).map((call) => ({
        method: call.method,
        params: JSON.stringify(call.params).slice(0, 400),
      })),
    };
  };

  return async function route({ req, url, send }) {
    if (url.pathname === '/') {
      send({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: PAGE });
      return true;
    }

    if (url.pathname === '/widget.html') {
      send({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: preview.html });
      return true;
    }

    if (url.pathname === '/api/preview-info') {
      sendJson(send, { stripped: preview.stripped.length, tags: preview.stripped });
      return true;
    }

    if (url.pathname === '/api/state') {
      const description = await describeApp(app);
      sendJson(send, {
        ...widgetSnapshot(),
        app: {
          feed: description.feed.sample ? `sample (${description.feed.offers} offers)` : description.feed.url,
          offers: description.feed.offers,
          updated: description.feed.updated,
          html: `${description.widget.rawBytes} B / ${description.widget.compressedBytes} B zlib`,
          maxOffers: description.limits.maxOffers,
          sharedWidget: description.limits.sharedWidgetId || '—',
          sharedCacheTime: `${description.limits.sharedCacheTime}s`,
        },
      });
      return true;
    }

    if (url.pathname === '/api/tap' && req.method === 'POST') {
      const { data } = JSON.parse(await readJson(req));
      const before = mock.state.answers.length;
      await app.bot.handleUpdate(mock.widgetQuery(String(data ?? 'refresh')));
      const answered = mock.state.answers.length > before;
      const snapshot = widgetSnapshot();
      sendJson(send, {
        ok: answered,
        result: answered ? mock.lastAnswer() : 'NOT_ANSWERED',
        chatData: snapshot.chatData,
        publicData: snapshot.publicData,
      });
      return true;
    }

    if (url.pathname === '/api/command' && req.method === 'POST') {
      const { text } = JSON.parse(await readJson(req));
      await app.bot.handleUpdate(mock.messageUpdate(String(text ?? '/widget')));
      sendJson(send, { ok: true, ...widgetSnapshot() });
      return true;
    }

    if (url.pathname === '/api/callback' && req.method === 'POST') {
      const { data } = JSON.parse(await readJson(req));
      await app.bot.handleUpdate(mock.callbackUpdate(String(data ?? 'w:refresh')));
      sendJson(send, { ok: true, ...widgetSnapshot() });
      return true;
    }

    if (url.pathname === '/api/reset') {
      mock.reset();
      sendJson(send, { ok: true });
      return true;
    }

    return false;
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
    req.on('error', reject);
  });
}

export { createMockTelegram };
