/**
 * Capture-time masking, shared by capture-media.mjs (the GitHub gallery) and
 * screenshots.mjs (the annotated in-app guide images). Values are replaced in
 * the browser DOM just before the shutter; nothing is written back.
 */
/**
 * Capture-only masking. Values are replaced in the DOM just before the
 * screenshot; nothing is written back. Credentials and tokens get an opaque
 * replacement, never a blur — a blurred token is still a token.
 */
export const MASKS = [
  // Enrollment one-liners and installer URLs embed a single-use claim token.
  { match: /\/install\/(win|linux|mac)\/[A-Za-z0-9_-]{8,}/g, to: '/install/$1/SAMPLE-ENROLLMENT-TOKEN' },
  { match: /\b[a-f0-9]{32,}\b/gi, to: 'SAMPLE-TOKEN-VALUE' },
  // Public API keys (0.29 shows them on Settings → API keys, prefix only).
  { match: /\brk_[A-Za-z0-9_-]{4,}/g, to: 'rk_SAMPLE' },
  // RustDesk IDs are synthetic here, but the gallery should still model the
  // habit of not publishing them.
  { match: /\b\d{9}\b/g, to: '•••••••••' },
  // Endpoint addresses are stored as real routable IPs ONLY so the dashboard
  // map can geolocate them (see prisma/_docs-demo-data.ts). The map renders
  // city names, not addresses, so masking the displayed value costs nothing —
  // and publishing a routable address next to a business name, even a
  // fictional one, is a habit worth not having. Private ranges and loopback
  // are left alone; they are meaningful and carry nothing.
  { match: /\b(?!10\.|192\.168\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.)((?:\d{1,3}\.){3}\d{1,3})\b/g,
    to: '198.51.100.24' },
  // The demo API reads the HOST's real TLS certificates and systemd units, so
  // pages like Security name the live deployment's domain. Replace any FQDN
  // that is not deliberately public. The allowlist keeps intentional branding
  // (mspreboot.com) and upstream references (github.com, rustdesk.com) intact.
  { match: /\b(?!(?:[a-z0-9-]+\.)*(?:mspreboot|github|rustdesk|example)\.(?:com|net|org)\b)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|local|uk|co)\b/gi,
    to: 'remote.example.com' },
];

export async function applyMasks(page) {
  await page.evaluate((masks) => {
    const rx = masks.map((m) => ({ re: new RegExp(m.source, m.flags), to: m.to }));
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) hits.push(n);
    for (const n of hits) {
      let t = n.nodeValue;
      for (const { re, to } of rx) t = t.replace(re, to);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    // Inputs holding a generated command/link.
    for (const el of document.querySelectorAll('input,textarea')) {
      let v = el.value; if (!v) continue;
      for (const { re, to } of rx) v = v.replace(re, to);
      if (v !== el.value) el.value = v;
    }
    // Anything the app itself flags as secret gets an opaque block.
    for (const el of document.querySelectorAll('[data-secret],[data-sensitive],canvas[aria-label*="QR" i]')) {
      el.style.filter = 'none';
      el.style.background = '#334155';
      el.style.color = 'transparent';
    }
  }, MASKS.map((m) => ({ source: m.match.source, flags: m.match.flags, to: m.to })));
}
