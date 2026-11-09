/**
 * Pure functions: turning a ticket (+ optional endpoint snapshot) into
 * labelled, untrusted segments, and turning model outputs into a staff-only
 * result. No I/O here, so every rule is unit-tested in isolation
 * (scripts/unit-integration.mjs).
 *
 * The posture throughout: ticket text, device-reported values and model
 * output are attacker-influenced. They are bounded, labelled and checked;
 * they never become an instruction, a URL to fetch, or an action.
 */
import type { AnalysisOutput, AnalysisResult, JobRequest } from './contract';
import { AnalysisOutput as AnalysisOutputSchema } from './contract';

export interface Segment {
  ref: string;
  kind: 'ticket_subject' | 'ticket_body' | 'ticket_comment' | 'ticket_attachment' | 'endpoint_inventory' | 'endpoint_heartbeat';
  author_role?: 'customer' | 'staff' | 'system' | 'rem0te';
  text: string;
}
export interface EvidenceItem { ref: string; kind: string; summary: string; observed_at: string | null }

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Strip control and bidi-override characters; clamp. */
export function clean(s: string, max: number): string {
  return s.replace(CTRL, '').slice(0, max);
}

export function ticketRef(t: JobRequest['ticket'], part: string) {
  return `ticket:${t.id}@${t.revision}#${part}`;
}

export function ticketSegments(t: JobRequest['ticket']): Segment[] {
  const out: Segment[] = [
    { ref: ticketRef(t, 'subject'), kind: 'ticket_subject', text: clean(t.subject, 512) },
    { ref: ticketRef(t, 'body'), kind: 'ticket_body', text: clean(t.body, 20000) },
  ];
  for (const c of t.comments) out.push({ ref: ticketRef(t, `comment:${c.id}`), kind: 'ticket_comment', author_role: c.author_role, text: clean(c.body, 8000) });
  for (const a of t.attachments_text) out.push({ ref: ticketRef(t, `attachment:${a.id}`), kind: 'ticket_attachment', text: clean(`${a.name}\n${a.excerpt}`, 8300) });
  return out;
}

/** Device-reported strings reach the model only through this charset. */
export function inert(s: string | null | undefined, max = 128): string {
  return (s ?? '').replace(/[^A-Za-z0-9 ._()\-/:,+]/g, '').slice(0, max);
}

export interface EndpointSnapshot {
  id: string;
  name: string;
  platform: string | null;
  agentVersion: string | null;
  isOnline: boolean;
  lastSeenAt: Date | null;
  inventory: null | {
    collectedAt: Date | null; osCaption: string | null; osBuild: string | null;
    lastBootAt: Date | null; uptimeSeconds: number | null;
    memoryTotalMb: number | null; memoryFreeMb: number | null;
    systemDiskTotalMb: number | null; systemDiskFreeMb: number | null; liveSampledAt: Date | null;
    pendingUpdateCount: number | null; rebootRequired: boolean | null; updatesCheckedAt: Date | null;
  };
}

/**
 * Deterministic, rem0te-observed evidence about one endpoint. Deliberately
 * excludes IP and MAC addresses, serial numbers, the logged-on user, domain
 * and network details: none is needed to triage a ticket and each is
 * personal or reconnaissance data.
 */
export function endpointEvidence(ep: EndpointSnapshot, now: Date): { segments: Segment[]; evidence: EvidenceItem[] } {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const ageMin = (d: Date | null) => (d ? Math.round((now.getTime() - d.getTime()) / 60000) : null);
  const hbRef = `endpoint:${ep.id}#heartbeat@${iso(ep.lastSeenAt) ?? 'never'}`;
  const hb = [
    `name=${inert(ep.name)}`,
    `platform=${inert(ep.platform)}`,
    `agent_version=${inert(ep.agentVersion)}`,
    `online=${ep.isOnline}`,
    `last_heartbeat=${iso(ep.lastSeenAt) ?? 'never'}`,
    `heartbeat_age_minutes=${ageMin(ep.lastSeenAt) ?? 'n/a'}`,
  ].join('\n');
  const segments: Segment[] = [{ ref: hbRef, kind: 'endpoint_heartbeat', author_role: 'rem0te', text: hb }];
  const evidence: EvidenceItem[] = [{
    ref: hbRef, kind: 'endpoint_heartbeat', observed_at: iso(ep.lastSeenAt),
    summary: `${ep.isOnline ? 'Online' : 'Offline'}; last heartbeat ${ep.lastSeenAt ? `${ageMin(ep.lastSeenAt)} min ago` : 'never'}; agent ${inert(ep.agentVersion, 32) || 'unknown'}`,
  }];
  const inv = ep.inventory;
  if (inv) {
    const invRef = `endpoint:${ep.id}#inventory@${iso(inv.collectedAt) ?? 'never'}`;
    const lines = [
      `inventory_collected_at=${iso(inv.collectedAt) ?? 'never'}`,
      `inventory_age_minutes=${ageMin(inv.collectedAt) ?? 'n/a'}`,
      `os=${inert(inv.osCaption)} build=${inert(inv.osBuild, 32)}`,
      `last_boot=${iso(inv.lastBootAt) ?? 'unknown'} uptime_seconds=${inv.uptimeSeconds ?? 'unknown'}`,
      `memory_free_mb=${inv.memoryFreeMb ?? '?'} of ${inv.memoryTotalMb ?? '?'}`,
      `system_disk_free_mb=${inv.systemDiskFreeMb ?? '?'} of ${inv.systemDiskTotalMb ?? '?'} (sampled ${iso(inv.liveSampledAt) ?? 'never'})`,
      `pending_updates=${inv.pendingUpdateCount ?? 'unknown'} reboot_required=${inv.rebootRequired ?? 'unknown'} (checked ${iso(inv.updatesCheckedAt) ?? 'never'})`,
    ].join('\n');
    segments.push({ ref: invRef, kind: 'endpoint_inventory', author_role: 'rem0te', text: lines });
    evidence.push({
      ref: invRef, kind: 'endpoint_inventory', observed_at: iso(inv.collectedAt),
      summary: `Inventory ${inv.collectedAt ? `${ageMin(inv.collectedAt)} min old` : 'never collected'}; ${inv.pendingUpdateCount ?? '?'} pending updates; reboot required: ${inv.rebootRequired ?? 'unknown'}`,
    });
  }
  return { segments, evidence };
}

// ── Prompt-injection and dangerous-suggestion flags ─────────────────────────

const INJECTION_PATTERNS: [string, RegExp][] = [
  ['ignore_instructions', /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|rules|prompt)/i],
  ['role_override', /\b(you are now|act as|pretend to be|developer mode|jailbreak)\b/i],
  ['fake_delimiter', /<\/?\s*(system|assistant|instructions?)\s*>|\bBEGIN (SYSTEM|INSTRUCTIONS)\b|^\s*#{2,}\s*system/im],
  ['approval_bait', /\b(approve|auto-?approve|execute|run)\b.{0,40}\b(fix|action|script|command)s?\b.{0,20}\b(now|immediately|without)\b/i],
  ['exfiltration_bait', /\b(send|post|upload|exfiltrate)\b.{0,40}\b(password|credential|token|secret|key)s?\b/i],
];

export function injectionFlags(segments: Segment[]): { ref: string; pattern: string }[] {
  const out: { ref: string; pattern: string }[] = [];
  for (const s of segments) for (const [name, re] of INJECTION_PATTERNS) if (re.test(s.text)) out.push({ ref: s.ref, pattern: name });
  return out;
}

/**
 * Categories that are never proposed as a change, whatever a model says.
 * Next steps are text for a human in every case (executable: false); this
 * marks the ones a reviewer should treat as a red flag.
 */
const BLOCKED: [string, RegExp][] = [
  ['credential_extraction', /\b(mimikatz|sekurlsa|lsass|ntds\.dit|procdump)\b|\bdump\b.{0,20}\b(credential|hash|sam)/i],
  ['disable_defenses', /\b(disable|turn off|stop|uninstall)\b.{0,30}\b(defender|antivirus|av|edr|firewall|tamper|real-?time|smartscreen|uac)\b|Set-MpPreference\s+-Disable/i],
  ['remove_backups', /\b(vssadmin|wbadmin)\b.{0,20}\bdelete\b|shadowcopy\s+delete|\bdelete\b.{0,30}\b(backups?|shadow cop(y|ies)|restore points?)\b/i],
  ['admin_grant', /\bnet\s+localgroup\s+administrators\b|Add-LocalGroupMember.{0,40}Administrators|\b(grant|add|make)\b.{0,30}\b(local |domain )?admin(istrator)?s?\b/i],
  ['disk_wipe', /\bformat\s+[a-z]:|\bdiskpart\b|\bclean all\b|\bcipher\s+\/w\b|\bClear-Disk\b|\bwipe\b/i],
  ['arbitrary_command', /\b(iex|invoke-expression|invoke-webrequest|downloadstring|start-process|bash -c|cmd(\.exe)? \/c|reg (add|delete)|sc(\.exe)? (config|delete)|curl |wget )\b/i],
];
export function blockedCategory(text: string): string | null {
  for (const [name, re] of BLOCKED) if (re.test(text)) return name;
  return null;
}

const URL_RE = /\bhttps?:\/\/([A-Za-z0-9.-]+)/gi;
export function linkHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(URL_RE)) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

// ── Output parsing and aggregation ──────────────────────────────────────────

export interface ParsedRun {
  model_profile: string;
  resolved_model: string | null;
  ok: boolean;
  output: AnalysisOutput | null;
  dropped_unknown_fields: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  error?: { code: string; message: string };
}

function countUnknown(raw: unknown, known: string[]): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  return Object.keys(raw).filter((k) => !known.includes(k)).length;
}

/** Parse a model's raw output. Never throws; a bad output is a failed run. */
export function parseModelOutput(raw: unknown): { output: AnalysisOutput | null; dropped: number; error?: string } {
  const r = AnalysisOutputSchema.safeParse(raw);
  if (!r.success) return { output: null, dropped: 0, error: 'Output did not match analysis-output.v1' };
  const o = r.data;
  const output: AnalysisOutput = {
    category: clean(o.category, 64).toLowerCase(),
    summary: clean(o.summary, 1500),
    facts: o.facts.map((f) => ({ statement: clean(f.statement, 600), evidence_refs: f.evidence_refs })),
    hypotheses: o.hypotheses.map((h) => ({ statement: clean(h.statement, 600), confidence: h.confidence, evidence_refs: h.evidence_refs })),
    draft_reply: clean(o.draft_reply, 6000),
    next_steps: o.next_steps.map((s) => clean(s, 400)),
  };
  const dropped = countUnknown(raw, ['category', 'summary', 'facts', 'hypotheses', 'draft_reply', 'next_steps']);
  return { output, dropped };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function tokens(s: string) { return new Set(norm(s).split(' ').filter((w) => w.length > 2)); }
export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
const CONF_RANK = { high: 3, medium: 2, low: 1 } as const;

export function aggregate(params: {
  runs: ParsedRun[];
  knownRefs: Set<string>;
  evidence: EvidenceItem[];
  flags: { ref: string; pattern: string }[];
  observedFacts: { statement: string; evidence_refs: string[] }[];
}): AnalysisResult {
  const { runs, knownRefs } = params;
  const ok = runs.filter((r) => r.ok && r.output);
  const facts = new Map<string, AnalysisResult['facts'][number]>();
  const hyps = new Map<string, AnalysisResult['hypotheses'][number]>();
  const unsupported: AnalysisResult['unsupported_claims'] = [];
  const steps = new Map<string, AnalysisResult['next_steps'][number]>();

  for (const f of params.observedFacts) {
    facts.set(`obs:${norm(f.statement)}`, { statement: f.statement, evidence_refs: f.evidence_refs, model_profiles: [], source: 'rem0te_observed' });
  }
  for (const r of ok) {
    const o = r.output!;
    for (const f of o.facts) {
      const refs = f.evidence_refs.filter((x) => knownRefs.has(x));
      if (refs.length === 0) {
        unsupported.push({ statement: f.statement, evidence_refs: f.evidence_refs.slice(0, 10), model_profiles: [r.model_profile], reason: 'no_resolvable_evidence' });
        continue;
      }
      const k = norm(f.statement);
      const cur = facts.get(k);
      if (cur) { cur.model_profiles = [...new Set([...cur.model_profiles, r.model_profile])]; cur.evidence_refs = [...new Set([...cur.evidence_refs, ...refs])]; }
      else facts.set(k, { statement: f.statement, evidence_refs: refs, model_profiles: [r.model_profile], source: 'model_cited' });
    }
    for (const h of o.hypotheses) {
      const refs = h.evidence_refs.filter((x) => knownRefs.has(x));
      const k = norm(h.statement);
      const cur = hyps.get(k);
      if (cur) {
        cur.model_profiles = [...new Set([...cur.model_profiles, r.model_profile])];
        cur.evidence_refs = [...new Set([...cur.evidence_refs, ...refs])];
        if (CONF_RANK[h.confidence] < CONF_RANK[cur.confidence]) cur.confidence = h.confidence; // report the most cautious
      } else hyps.set(k, { statement: h.statement, confidence: h.confidence, evidence_refs: refs, model_profiles: [r.model_profile] });
    }
    for (const s of o.next_steps) {
      const k = norm(s);
      const cur = steps.get(k);
      if (cur) cur.model_profiles = [...new Set([...cur.model_profiles, r.model_profile])];
      else steps.set(k, { text: s, model_profiles: [r.model_profile], executable: false, requires_human_approval: true, blocked_category: blockedCategory(s) });
    }
  }

  // Disagreements: differing categories, and top hypotheses that do not overlap.
  const disagreements: AnalysisResult['disagreements'] = [];
  if (ok.length > 1) {
    const cats = new Map<string, string[]>();
    for (const r of ok) cats.set(r.output!.category, [...(cats.get(r.output!.category) ?? []), r.model_profile]);
    if (cats.size > 1) {
      disagreements.push({ kind: 'category', detail: [...cats.entries()].map(([c, p]) => `${p.join('+')}: ${c}`).join('; '), model_profiles: ok.map((r) => r.model_profile) });
    }
    const tops = ok.map((r) => ({ p: r.model_profile, h: [...r.output!.hypotheses].sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence])[0] }));
    for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) {
      const a = tops[i], b = tops[j];
      if (!a.h || !b.h) continue;
      if (jaccard(a.h.statement, b.h.statement) < 0.3) {
        disagreements.push({ kind: 'hypothesis', detail: `${a.p}: "${a.h.statement.slice(0, 200)}" vs ${b.p}: "${b.h.statement.slice(0, 200)}"`, model_profiles: [a.p, b.p] });
      }
    }
  }

  return {
    visibility: 'staff_only',
    facts: [...facts.values()],
    hypotheses: [...hyps.values()].sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]),
    unsupported_claims: unsupported,
    draft_replies: ok.filter((r) => r.output!.draft_reply).map((r) => ({
      model_profile: r.model_profile, text: r.output!.draft_reply, visibility: 'staff_only' as const,
      requires_human_review: true as const, link_hosts: linkHosts(r.output!.draft_reply),
    })),
    next_steps: [...steps.values()],
    per_model: runs.map((r) => ({
      model_profile: r.model_profile, resolved_model: r.resolved_model,
      status: r.ok ? 'succeeded' as const : 'failed' as const,
      category: r.output?.category ?? null, summary: r.output?.summary ?? null,
      dropped_unknown_fields: r.dropped_unknown_fields, usage: r.usage,
    })),
    disagreements,
    evidence: params.evidence,
    untrusted_input_flags: params.flags,
    partial_failures: runs.filter((r) => !r.ok).map((r) => ({ model_profile: r.model_profile, code: r.error?.code ?? 'FAILED', message: r.error?.message ?? 'failed' })),
  };
}
