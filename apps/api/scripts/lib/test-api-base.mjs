// The API a behavioural suite talks to. There is no default: until 0.59 a
// dozen suites fell back to http://127.0.0.1:3001 — production on this host —
// so a suite run by hand with only DATABASE_URL set wrote its fixtures to the
// scratch database and then signed in against the live API. run-e2e.sh always
// sets API_BASE to its own scratch API; anyone else must too.
const REFUSED_PORTS = new Set(['3000', '3001', '3201', '3202', '443', '4000', '4001']);

export function testApiBase() {
  const raw = process.env.API_BASE;
  if (!raw) {
    console.error('Set API_BASE to a scratch API (run-e2e.sh does). There is no default: the old one was production.');
    process.exit(2);
  }
  let u;
  try { u = new URL(raw); } catch { console.error(`API_BASE is not a URL: ${raw}`); process.exit(2); }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (u.protocol !== 'http:' || REFUSED_PORTS.has(port) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    console.error(`Refusing API_BASE ${raw}: a suite runs only against a loopback scratch API over http, never ports ${[...REFUSED_PORTS].join('/')}.`);
    process.exit(2);
  }
  return raw.replace(/\/$/, '');
}
