/**
 * A loopback SMTP sink for the e2e suites (0.34 e2e-email, 0.35 e2e-ui).
 *
 * Enough of RFC 5321 for one client: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA,
 * RSET, NOOP, QUIT. It never offers STARTTLS, so a client that requires it
 * must give up before MAIL. Messages are parsed (RFC 2047 subjects,
 * multipart, base64 / quoted-printable) and kept in memory.
 *
 *   const { sink, server, mailTo, waitMail } = createSmtpSink();
 *   await new Promise((r) => server.listen(port, '127.0.0.1', r));
 */
import net from 'node:net';

function decodeWords(s) {
  // Whitespace between two encoded words is not part of the text (RFC 2047 §6.2).
  return s.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc, t) => (enc.toLowerCase() === 'b' ? Buffer.from(t, 'base64').toString('utf8') : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')));
}
function parsePart(raw) {
  const i = raw.indexOf('\r\n\r\n');
  const head = (i < 0 ? raw : raw.slice(0, i)).replace(/\r\n[ \t]+/g, ' ');
  const body = i < 0 ? '' : raw.slice(i + 4);
  const headers = {};
  for (const l of head.split('\r\n')) { const c = l.indexOf(':'); if (c > 0) headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim(); }
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const ct = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')).map((p) => parsePart(p.replace(/^\r\n/, '')));
    return { headers, parts };
  }
  let text = body;
  if (cte === 'base64') text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (cte === 'quoted-printable') text = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  return { headers, text: text.replace(/\r\n/g, '\n') };
}
function parseMessage(data) {
  const m = parsePart(data);
  const leaves = m.parts ? m.parts : [m];
  const textPart = leaves.find((p) => /text\/plain/i.test(p.headers['content-type'] ?? 'text/plain') && !/attachment/i.test(p.headers['content-disposition'] ?? ''));
  const attachments = leaves.filter((p) => /attachment/i.test(p.headers['content-disposition'] ?? '')).map((p) => ({ filename: /filename="?([^";]+)"?/i.exec(p.headers['content-disposition'])?.[1], type: p.headers['content-type'], content: p.text }));
  return { subject: decodeWords(m.headers.subject ?? ''), headers: m.headers, text: textPart?.text ?? '', attachments, raw: data };
}
export function createSmtpSink() {
  const sink = { messages: [], sessions: 0, auths: [] };
  const server = net.createServer((sock) => {
    sink.sessions++;
    let buf = '', inData = false, data = '', env = { from: null, to: [], auth: null }, authStep = null, authUser = null;
    const say = (l) => sock.write(`${l}\r\n`);
    say('220 sink.test ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          const body = data.replace(/\r\n\.\./g, '\r\n.');
          sink.messages.push({ from: env.from, to: [...env.to], auth: env.auth, ...parseMessage(Buffer.from(body, 'latin1').toString('utf8')), at: Date.now() });
          env = { from: null, to: [], auth: env.auth }; data = '';
          say('250 2.0.0 queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (authStep === 'user') { authUser = Buffer.from(line, 'base64').toString(); authStep = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (authStep === 'pass') { env.auth = { user: authUser, pass: Buffer.from(line, 'base64').toString() }; sink.auths.push(env.auth); authStep = null; say('235 2.7.0 ok'); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { say('250-sink.test'); say('250-AUTH PLAIN LOGIN'); say('250-8BITMIME'); say('250 SMTPUTF8'); }
        else if (cmd === 'HELO') say('250 sink.test');
        else if (cmd === 'AUTH') {
          const [, mech, arg] = line.split(' ');
          if (/^plain$/i.test(mech)) {
            const done = (b64) => { const [, u, p] = Buffer.from(b64, 'base64').toString().split('\u0000'); env.auth = { user: u, pass: p }; sink.auths.push(env.auth); say('235 2.7.0 ok'); };
            if (arg) done(arg); else { authStep = 'plain'; say('334 '); }
          } else if (/^login$/i.test(mech)) { authStep = 'user'; say('334 VXNlcm5hbWU6'); }
          else say('504 unsupported');
        } else if (authStep === 'plain') { authStep = null; const [, u, p] = Buffer.from(line, 'base64').toString().split('\u0000'); env.auth = { user: u, pass: p }; sink.auths.push(env.auth); say('235 2.7.0 ok'); }
        else if (cmd === 'MAIL') { env.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; say('250 ok'); }
        else if (cmd === 'RCPT') { env.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); say('250 ok'); }
        else if (cmd === 'DATA') { inData = true; say('354 go ahead'); }
        else if (cmd === 'RSET') { env = { from: null, to: [], auth: env.auth }; say('250 ok'); }
        else if (cmd === 'NOOP') say('250 ok');
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); return; }
        else if (cmd === 'STAR') say('454 TLS not available');
        else say('502 not implemented');
      }
    });
    sock.on('error', () => undefined);
  });
  const mailTo = (addr) => sink.messages.filter((m) => m.to.includes(addr));
  async function waitMail(pred, ms = 20_000) {
    const t = Date.now();
    while (Date.now() - t < ms) { const m = sink.messages.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 200)); }
    return null;
  }
  return { sink, server, mailTo, waitMail };
}
