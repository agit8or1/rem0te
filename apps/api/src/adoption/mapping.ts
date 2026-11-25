import { BlockList, isIP } from 'net';
import { z } from 'zod';

/**
 * Assignment rules (0.57, check-security-invariants §70): the pure part.
 *
 * A rule names one business (and optionally a site) for unassigned computers
 * that match ONE explicitly configured fact:
 *
 *   deployment_key   — the computer enrolled with that deployment key
 *   domain           — the AD / DNS domain its inventory reports
 *   cidr             — the address the server saw its requests come from
 *   hostname_prefix  — the start of its hostname
 *
 * There is deliberately no rule on who is signed in to the computer, on a user
 * name or on an e-mail address: those say who is sitting at a machine, not
 * whose machine it is, and a contractor's laptop would be "suggested" into the
 * contractor's employer. `PoolFacts` does not carry them, so no rule can read
 * them.
 *
 * A match is a SUGGESTION, shown with the rule that made it. Nothing here
 * writes, and nothing applies a suggestion by itself: a Platform Admin accepts
 * it (AdoptionService.adopt, fresh sign-in, audited with the rule's id). The
 * only automatic placement is a deployment key made with mode "active", whose
 * business comes from the key itself.
 */
export const MAPPING_KINDS = ['deployment_key', 'domain', 'cidr', 'hostname_prefix'] as const;
export type MappingKind = (typeof MAPPING_KINDS)[number];

/** The only facts a rule may read. No user, no e-mail. */
export interface PoolFacts {
  deploymentKeyId: string | null;
  domain: string | null;
  sourceIp: string | null;
  hostname: string | null;
}

export interface MappingRow {
  id: string;
  customerId: string;
  siteId: string | null;
  kind: string;
  value: string;
  deploymentKeyId: string | null;
  priority: number;
  createdAt: Date;
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const validDomain = (v: string) => v.length <= 253 && v.split('.').every((l) => LABEL_RE.test(l));
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Every computer outside a domain reports this; a rule on it would match them all.
const NOT_A_DOMAIN = new Set(['workgroup', 'localdomain', 'local']);

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is the IPv4 address. */
export function normaliseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return isIP(v) ? v.toLowerCase() : null;
}

/** "a.b.c.d/n" or "x::/n", normalised; a bare address is one host. Too wide a range is refused. */
export function parseCidr(raw: string): { addr: string; prefix: number; family: 'ipv4' | 'ipv6'; text: string } | null {
  const parts = raw.trim().toLowerCase().split('/');
  if (parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]))) return null;
  const addr = normaliseIp(parts[0]);
  if (!addr) return null;
  const family = isIP(addr) === 4 ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  const min = family === 'ipv4' ? 8 : 32;
  const prefix = parts.length === 1 ? max : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < min || prefix > max) return null;
  return { addr, prefix, family, text: `${addr}/${prefix}` };
}

export function cidrContains(cidr: string, ip: string | null): boolean {
  const c = parseCidr(cidr);
  const a = normaliseIp(ip);
  if (!c || !a) return false;
  const fam = isIP(a) === 4 ? 'ipv4' : 'ipv6';
  if (fam !== c.family) return false;
  const bl = new BlockList();
  try { bl.addSubnet(c.addr, c.prefix, c.family); } catch { return false; }
  return bl.check(a, fam);
}

/** A rule's value, normalised for its kind, or a reason it is refused. */
export function normaliseValue(kind: MappingKind, raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const v = raw.trim().toLowerCase().replace(/\.$/, '');
  switch (kind) {
    case 'domain':
      if (!validDomain(v)) return { ok: false, message: 'A domain is letters, digits, hyphens and dots, as the device reports it (contoso.local or CONTOSO).' };
      if (NOT_A_DOMAIN.has(v)) return { ok: false, message: `"${v}" is what devices outside a domain report; a rule on it would match all of them.` };
      return { ok: true, value: v };
    case 'hostname_prefix':
      if (!PREFIX_RE.test(v)) return { ok: false, message: 'A hostname prefix is at least two letters, digits or hyphens (e.g. ACME-).' };
      return { ok: true, value: v };
    case 'cidr': {
      const c = parseCidr(v);
      if (!c) return { ok: false, message: 'An address range is an IPv4 address with a /8 to /32 prefix, or IPv6 with /32 to /128 (e.g. 203.0.113.0/24).' };
      return { ok: true, value: c.text };
    }
    case 'deployment_key':
      if (!/^[a-z0-9]{20,40}$/.test(v)) return { ok: false, message: 'A deployment-key rule names the key by its id.' };
      return { ok: true, value: v };
  }
}

const id = z.string().regex(/^[a-z0-9]{20,40}$/, 'an id');
export const MappingCreate = z.object({
  businessId: id,
  siteId: id.nullish(),
  kind: z.enum(MAPPING_KINDS),
  value: z.string().min(1).max(253),
  priority: z.number().int().min(0).max(1000).default(100),
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  note: z.string().trim().max(200).regex(/^[^\x00-\x1f\x7f<>]*$/, 'printable text without < or >').nullish(),
}).strict();
export type MappingCreateInput = z.infer<typeof MappingCreate>;

export function mappingMatches(m: Pick<MappingRow, 'kind' | 'value' | 'deploymentKeyId'>, f: PoolFacts): boolean {
  switch (m.kind) {
    case 'deployment_key': return !!f.deploymentKeyId && m.deploymentKeyId === f.deploymentKeyId;
    case 'domain': return !!f.domain && f.domain.trim().toLowerCase().replace(/\.$/, '') === m.value;
    case 'hostname_prefix': return !!f.hostname && f.hostname.trim().toLowerCase().startsWith(m.value);
    case 'cidr': return cidrContains(m.value, f.sourceIp);
    default: return false;
  }
}

// Identity before location: the key the computer was installed with, then its
// domain, then its name, then where it connected from.
const RANK: Record<string, number> = { deployment_key: 0, key_binding: 1, domain: 2, hostname_prefix: 3, cidr: 4 };
function specificity(m: { kind: string; value: string }): number {
  if (m.kind === 'cidr') return parseCidr(m.value)?.prefix ?? 0;
  if (m.kind === 'hostname_prefix') return m.value.length;
  return 0;
}

export interface Match {
  source: MappingKind | 'key_binding';
  mappingId: string | null;
  customerId: string;
  siteId: string | null;
  value: string;
}

export interface Suggestion {
  /** The first match, or null. Not applied: shown with its rule. */
  suggestion: Match | null;
  matches: Match[];
  /** Matches name more than one business: shown, never one-click accepted. */
  conflict: boolean;
}

/**
 * Every rule that matches, best first, and whether they disagree. `binding`
 * is the deployment key the computer enrolled with, if any: a key in review
 * mode suggests its own business and site even with no rule naming it.
 */
export function suggest(f: PoolFacts, rules: MappingRow[], binding?: { keyId: string; customerId: string; siteId: string | null } | null): Suggestion {
  const hits: (Match & { rank: number; priority: number; spec: number; at: number })[] = [];
  for (const r of rules) {
    if (!mappingMatches(r, f)) continue;
    hits.push({ source: r.kind as MappingKind, mappingId: r.id, customerId: r.customerId, siteId: r.siteId, value: r.value,
      rank: RANK[r.kind] ?? 9, priority: r.priority, spec: specificity(r), at: r.createdAt.getTime() });
  }
  if (binding && f.deploymentKeyId === binding.keyId) {
    hits.push({ source: 'key_binding', mappingId: null, customerId: binding.customerId, siteId: binding.siteId, value: binding.keyId,
      rank: RANK.key_binding, priority: 0, spec: 0, at: 0 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.priority - b.priority || b.spec - a.spec || a.at - b.at);
  const matches: Match[] = hits.map(({ source, mappingId, customerId, siteId, value }) => ({ source, mappingId, customerId, siteId, value }));
  return { suggestion: matches[0] ?? null, matches, conflict: new Set(matches.map((m) => m.customerId)).size > 1 };
}
