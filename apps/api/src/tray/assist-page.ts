/**
 * The /assist chat page (0.36): what the tray's small window shows. Served by
 * the API itself — not the technician app — so it carries none of the
 * console's code, holds no portal session, and can have a CSP with nothing
 * inline (tray-policy.ts ASSIST_CSP): one document, one script and one
 * stylesheet, all from /assist, talking only to /assist/api.
 *
 * Every message is put on the page with textContent. Nothing is parsed as
 * HTML or markdown and nothing becomes a link: a URL in a message is text.
 * Relative URLs throughout, so the page works both behind the web app's
 * /assist rewrite and at the API's own /api/v1/assist.
 */

export const ASSIST_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Support chat</title>
<link rel="stylesheet" href="assist.css">
<script src="assist.js" defer></script>
</head>
<body>
<header id="head">
  <div id="brand">Support chat</div>
  <div id="with"></div>
</header>
<div id="trust" role="note">Your IT provider will never ask for your password. Links in this chat are never opened.</div>
<div id="recording" role="status"></div>
<div id="paused" role="alert" hidden></div>
<main id="log" aria-live="polite" aria-label="Messages"></main>
<section id="start" hidden>
  <p id="start-intro">Nobody from support is in a chat with you yet. Write what you need help with to start one.</p>
  <textarea id="start-text" rows="4" maxlength="2000" aria-label="What do you need help with?"></textarea>
  <button id="start-send" type="button">Start chat</button>
</section>
<footer id="compose" hidden>
  <textarea id="text" rows="2" maxlength="2000" aria-label="Your message" placeholder="Write a message. Enter sends, Shift+Enter adds a line."></textarea>
  <div id="row">
    <span id="note"></span>
    <button id="end" type="button">End chat</button>
    <button id="send" type="button">Send</button>
  </div>
</footer>
<div id="gone" hidden></div>
</body>
</html>
`;

export const ASSIST_CSS = `:root { --accent: #3B82F6; --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --me: #eef2ff; --them: #f3f4f6; --warn-bg: #fef3c7; --warn-fg: #78350f; }
@media (prefers-color-scheme: dark) { :root { --bg: #111827; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; --me: #1e293b; --them: #1f2937; --warn-bg: #451a03; --warn-fg: #fde68a; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; font: 14px/1.4 "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
#head { padding: 10px 12px; background: var(--accent); color: #fff; }
#brand { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
#with { font-size: 12px; opacity: .9; overflow-wrap: anywhere; }
#trust, #recording, #paused { padding: 6px 12px; font-size: 12px; border-bottom: 1px solid var(--line); }
#trust { color: var(--muted); }
#recording.off, #paused { background: var(--warn-bg); color: var(--warn-fg); }
#log { flex: 1; overflow-y: auto; padding: 10px 12px; }
.msg { margin: 0 0 10px; max-width: 92%; }
.msg.user { margin-left: auto; }
.msg .meta { font-size: 11px; color: var(--muted); }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 9px; border-radius: 8px; background: var(--them); }
.msg.user .body { background: var(--me); }
.msg .state { font-size: 11px; color: var(--muted); text-align: right; }
.empty { color: var(--muted); font-size: 13px; }
#start, #compose { border-top: 1px solid var(--line); padding: 8px 12px; }
textarea { width: 100%; resize: none; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
#row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
#note { flex: 1; font-size: 12px; color: var(--muted); }
button { font: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; background: var(--bg); color: inherit; cursor: pointer; }
#send, #start-send { background: var(--accent); color: #fff; border-color: transparent; }
button:disabled { opacity: .5; cursor: default; }
#gone { padding: 24px 16px; text-align: center; color: var(--muted); }
`;

export const ASSIST_JS = `'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = null, busy = false, ended = false, confirmEnd = false;
  var reportedShown = {}, reportedRead = {};
  // Not recorded: messages leave the server once both sides have them, so what
  // this window has drawn is kept here (and lost when it closes, as it says).
  var kept = {}, order = [], pending = {};
  var POLL_MS = 3000;

  function rid() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function api(method, path, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { 'x-assist': '1' } };
    if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch('api/' + path, opt).then(function (r) {
      return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, body: j }; });
    });
  }
  function errText(r, fallback) {
    var b = r && r.body; var m = b && (b.message && (b.message.message || b.message)) ;
    return typeof m === 'string' ? m : fallback;
  }
  function gone(text) {
    $('log').hidden = true; $('compose').hidden = true; $('start').hidden = true;
    var g = $('gone'); g.hidden = false; g.textContent = text;
  }
  function time(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function header(s) {
    if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
    var c = s.conversation;
    $('brand').textContent = 'Support chat - ' + s.businessName;
    document.title = 'Support chat - ' + s.businessName;
    $('with').textContent = c ? (c.startedBy === 'end_user' && c.technicianName === 'Waiting for a technician' ? 'Waiting for a technician to answer' : 'With ' + c.technicianName + ' of ' + s.providerName) : s.providerName;
    $('trust').textContent = s.businessName + ' and ' + s.providerName + ' will never ask for your password. Links in this chat are never opened.';
    var recorded = c ? c.recorded : s.recordNew;
    var rec = $('recording');
    rec.className = recorded ? 'on' : 'off';
    rec.textContent = recorded
      ? 'This chat is recorded: your IT provider keeps the transcript (up to ' + s.retentionDays + ' days).'
      : 'This chat is not recorded: each message is deleted from the server once both of you have it, and anything left is deleted when the chat ends. Closing this window loses what is on screen.';
    var p = $('paused');
    if (s.contained) { p.hidden = false; p.textContent = s.contained; } else { p.hidden = true; }
  }

  function draw(s) {
    var c = s.conversation;
    var seen = {};
    (s.messages || []).forEach(function (m) {
      seen[m.id] = true;
      if (!kept[m.id]) { order.push(m.id); }
      kept[m.id] = m;
    });
    // Our own sends still in flight, by client id.
    var log = $('log');
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = '';
    if (!order.length && !Object.keys(pending).length) {
      var e = document.createElement('p'); e.className = 'empty';
      e.textContent = c && c.status === 'OPEN' ? 'No messages yet.' : 'No messages.';
      log.appendChild(e);
    }
    order.forEach(function (id) {
      var m = kept[id];
      var row = document.createElement('div'); row.className = 'msg ' + (m.from === 'user' ? 'user' : 'tech');
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = (m.from === 'user' ? 'You' : m.name) + ' · ' + time(m.at);
      var body = document.createElement('div'); body.className = 'body'; body.textContent = m.text;
      row.appendChild(meta); row.appendChild(body);
      if (m.from === 'user') {
        var st = document.createElement('div'); st.className = 'state';
        st.textContent = m.receivedBySupport || (!seen[id] && c && !c.recorded) ? 'Received by support' : 'Sent';
        row.appendChild(st);
      }
      log.appendChild(row);
    });
    Object.keys(pending).forEach(function (cid) {
      var p = pending[cid];
      var row = document.createElement('div'); row.className = 'msg user';
      var body = document.createElement('div'); body.className = 'body'; body.textContent = p.text;
      var st = document.createElement('div'); st.className = 'state'; st.textContent = p.failed ? ('Not sent: ' + p.failed) : 'Sending...';
      row.appendChild(body); row.appendChild(st); log.appendChild(row);
    });
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function receipts(s) {
    if (!s.conversation || document.visibilityState !== 'visible') return;
    var shown = [], read = [];
    var front = document.hasFocus();
    (s.messages || []).forEach(function (m) {
      if (m.from !== 'technician') return;
      if (!reportedShown[m.id]) { shown.push(m.id); }
      if (front && !reportedRead[m.id]) { read.push(m.id); }
    });
    if (!shown.length && !read.length) return;
    api('POST', 'receipts', { shown: shown, read: read }).then(function (r) {
      if (r.status !== 200) return;
      shown.forEach(function (id) { reportedShown[id] = true; });
      read.forEach(function (id) { reportedRead[id] = true; });
    });
  }

  function apply(s) {
    state = s;
    header(s);
    var c = s.conversation;
    if (!c) {
      $('start').hidden = false; $('compose').hidden = true; $('log').hidden = true;
      $('start-send').disabled = !!s.contained || !s.canStart;
      if (!s.canStart && s.startBlocked) $('start-intro').textContent = s.startBlocked;
      return;
    }
    $('start').hidden = true; $('log').hidden = false;
    ended = c.status !== 'OPEN';
    $('compose').hidden = false;
    $('text').disabled = ended; $('send').disabled = ended; $('end').disabled = ended;
    $('note').textContent = ended ? (c.endedReason === 'end_user' ? 'You ended this chat.' : 'This chat has ended.') : '';
    draw(s);
    receipts(s);
  }

  function refresh() {
    return api('GET', 'state').then(function (r) {
      if (r.status === 401) { gone('This chat window has expired. Open the chat again from the tray icon.'); return false; }
      if (r.status !== 200 || !r.body || !r.body.data) { $('note').textContent = 'Cannot reach your IT provider right now. Retrying...'; return true; }
      apply(r.body.data);
      return !ended;
    }).catch(function () { $('note').textContent = 'Cannot reach your IT provider right now. Retrying...'; return true; });
  }
  function loop() { refresh().then(function (more) { if (more !== false) setTimeout(loop, POLL_MS); }); }

  function send() {
    var t = $('text').value;
    if (!t.trim() || busy || ended) return;
    var cid = rid();
    pending[cid] = { text: t };
    $('text').value = '';
    if (state) draw(state);
    api('POST', 'messages', { clientId: cid, text: t }).then(function (r) {
      if (r.status === 200 || r.status === 201) {
        var d = r.body.data;
        delete pending[cid];
        if (!kept[d.id]) { order.push(d.id); kept[d.id] = { id: d.id, from: 'user', name: 'You', text: t, at: d.at }; }
      } else {
        pending[cid].failed = errText(r, 'it could not be delivered.');
      }
      if (state) draw(state);
    });
  }

  function start() {
    var t = $('start-text').value;
    if (!t.trim() || busy) return;
    busy = true; $('start-send').disabled = true;
    api('POST', 'start', { clientId: rid(), text: t }).then(function (r) {
      busy = false;
      if (r.status === 200 || r.status === 201) { $('start-text').value = ''; refresh(); return; }
      $('start-send').disabled = false;
      $('start-intro').textContent = errText(r, 'The chat could not be started.');
    });
  }

  function end() {
    if (ended) return;
    if (!confirmEnd) { confirmEnd = true; $('end').textContent = 'Yes, end it'; setTimeout(function () { confirmEnd = false; $('end').textContent = 'End chat'; }, 4000); return; }
    api('POST', 'end', {}).then(function () { refresh(); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('send').addEventListener('click', send);
    $('start-send').addEventListener('click', start);
    $('end').addEventListener('click', end);
    $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    document.addEventListener('visibilitychange', function () { if (state) receipts(state); });
    window.addEventListener('focus', function () { if (state) receipts(state); });
    loop();
  });
})();
`;

/** Shown when /assist/open is given a code that is unknown, used or expired. No script, nothing to retry. */
export const ASSIST_EXPIRED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Support chat</title><link rel="stylesheet" href="assist.css"></head>
<body><div id="gone">This chat link has already been used or has expired. Open the chat again from the tray icon.</div></body></html>
`;
