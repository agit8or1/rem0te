// The console's terminology (0.87.1, UX_ROADMAP.md P1-1; docs/UI_DESIGN_SYSTEM.md
// "Words"): a person reads "customer" and "device", never "business",
// "computer" or "endpoint". Codes, routes, DTO fields, Prisma models, audit
// action names and the ClientSt0r contract keep their names; only visible
// text moved.
//
// Pure: no imports. Used by scripts/check-terminology.mjs.

/** The old words, as whole words. */
export const OLD_TERM = /\b(Business(?:es)?|business(?:es)?|Computers?|computers?|Endpoints?|endpoints?)\b/g;

/**
 * Phrases that keep an old word on purpose, everywhere. Each one is a name
 * that is not ours to change, or a different sense of the word.
 */
export const KEEP_PHRASES = [
  // Role names: stored in the database (User.role BUSINESS_OWNER /
  // BUSINESS_USER), named in SSO group mappings, the audit log, the API and
  // every security document. Renaming them is a separate owner decision.
  { re: /\bBusiness (Owner|User)s?\b/g, why: 'role name' },
  { re: /\bbusiness (owner|user)s?\b/g, why: 'role name' },
  // Other people's names for things.
  { re: /\bApple Business Manager\b/g, why: "Apple's product name" },
  { re: /\b[Cc]omputer [Nn]ames?\b/g, why: "Windows' and RustDesk's term for the host name" },
  { re: /\bComputer (Management|Configuration)\b/g, why: 'Windows console and Group Policy node names' },
  { re: /\bDomain Computers\b/g, why: 'Active Directory group name' },
  // An evidence statement repeated word for word by the API catalog, the
  // approval signer's page, the docs and check-security-invariants.mjs: a
  // physical Windows machine, not a record in Rem0te.
  { re: /\breal Windows computers?\b/g, why: 'evidence statement (§15, §37, §61)' },
  // The technician's own workstation, where RustDesk opens: not a device
  // Rem0te manages.
  { re: /\byour own computer\b/g, why: "the technician's own machine" },
  { re: /\bSet up this computer for Connect\b/g, why: "the Downloads page's command, run on the technician's own machine" },
  // Idioms.
  { re: /\bbusiness (hours|days?)\b/g, why: 'idiom' },
  { re: /\b[Ll]ine-of-business\b/g, why: "Microsoft's app type (Intune)" },
  // A URL, not a device.
  { re: /\b(Authorization|authorization|Token|token|userinfo|logout|JWKS|completions|API|webhook|HTTP|discovery|end_session|introspection|revocation) endpoints?\b/g, why: 'an HTTP endpoint' },
  { re: /\bendpoints? URLs?\b/g, why: 'an HTTP endpoint' },
];

/** The old words left in a text once the kept phrases are taken out, with their offsets. */
export function oldTerms(text) {
  let t = text;
  for (const { re } of KEEP_PHRASES) t = t.replace(re, (m) => ' '.repeat(m.length));
  const out = [];
  for (const m of t.matchAll(OLD_TERM)) {
    const prev = t[m.index - 1];
    const next = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
    // Inside an identifier, a path, a capability id (computers:view) or a file name: code, not prose.
    if (prev && /[A-Za-z0-9_./:]/.test(prev)) continue;
    if (/^([_A-Za-z0-9]|:[a-z]|\/|\.[a-z])/.test(next)) continue;
    out.push({ word: m[0], index: m.index });
  }
  return out;
}

/**
 * Menu paths that no longer exist (0.87 moved these pages; NAVIGATION_MIGRATION.md).
 * A sentence that tells someone where to go must use the menu they see.
 */
export const STALE_PATHS = [
  { re: /Settings → Security(?! pages)\b/, now: 'Security → …' },
  { re: /Settings → Single sign-on/, now: 'Security → Single sign-on' },
  { re: /Settings → Audit log/, now: 'Security → Audit log' },
  { re: /Settings → Monitoring(?! &)/, now: 'Monitoring → Monitoring policies' },
  { re: /Settings → (Client updates|Client rollouts)/, now: 'Patching → …' },
  { re: /Settings → (Warranty|Backups|API keys|Email|AI\b|PSA|System status|Mobile devices|Updates)/, now: 'Administration → …' },
  { re: /Admin → (Security|SSO)\b/, now: 'Security → …' },
  { re: /Remote Support → /, now: 'Remote support → …' },
  { re: /Devices → (Managed sessions|Remote access readiness)/, now: 'Remote support → …' },
  { re: /Alerts → False positives/, now: 'Monitoring → False positives & rules' },
];
