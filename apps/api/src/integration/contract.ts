/**
 * Contract ticket-rmm-v1 — the runtime schemas.
 *
 * These zod schemas are the single source of truth. The JSON Schemas under
 * docs/contracts/ticket-rmm-v1/schemas/ are GENERATED from them by
 * scripts/gen-integration-contracts.mjs, and `--check` fails CI if the two
 * drift. Every bound here is deliberate: a ticket, a Windows log line and a
 * model's output are all attacker-influenced, so nothing is accepted
 * unbounded and nothing unknown is passed through.
 */
import { z } from 'zod';

export const CONTRACT = 'ticket-rmm-v1' as const;

/** Opaque identifier from the peer: ticket id, org id, technician id, … */
const ExtId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:@-]+$/, 'identifier charset');
/** Short free text; control characters other than \n and \t are refused. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const Text = (max: number) => z.string().max(max).refine((s) => !CONTROL.test(s), 'control characters');
const IsoDate = z.string().datetime({ offset: true });
const ModelProfile = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, 'model profile charset');

// ── POST /api/integration/v1/jobs ───────────────────────────────────────────

export const TicketComment = z.object({
  id: ExtId,
  author_role: z.enum(['customer', 'staff', 'system']),
  created_at: IsoDate,
  body: Text(8000),
}).strict();

export const TicketAttachmentText = z.object({
  id: ExtId,
  name: Text(256),
  excerpt: Text(8000),
}).strict();

export const Ticket = z.object({
  id: ExtId,
  revision: z.number().int().min(0).max(2_147_483_647),
  subject: Text(512),
  body: Text(20000),
  comments: z.array(TicketComment).max(50).default([]),
  attachments_text: z.array(TicketAttachmentText).max(10).default([]),
}).strict();

export const JobRequest = z.object({
  contract: z.literal(CONTRACT),
  idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  correlation_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  organization_id: ExtId,
  technician_id: ExtId,
  ticket: Ticket,
  /** Optional. An immutable rem0te endpoint id — never a hostname. */
  endpoint: z.object({ rem0te_endpoint_id: z.string().min(1).max(64).regex(/^[a-z0-9]+$/) }).strict().nullable().default(null),
  model_profiles: z.array(ModelProfile).min(1).max(3).refine((a) => new Set(a).size === a.length, 'duplicate model profile'),
  evidence: z.object({
    include_endpoint_inventory: z.boolean().default(false),
  }).strict().default({ include_endpoint_inventory: false }),
  expires_at: IsoDate,
}).strict();
export type JobRequest = z.infer<typeof JobRequest>;

// ── Delegated technician identity (JWS, EdDSA) ──────────────────────────────

export const DELEGATION_SCOPES = ['ticket_analysis:submit', 'ticket_analysis:read', 'actions:propose', 'actions:read'] as const;
export const DelegationClaims = z.object({
  iss: ExtId,                 // peer id
  aud: z.string().min(1).max(256),
  sub: ExtId,                 // peer technician id
  org: ExtId,                 // peer organization id
  scope: z.string().max(256),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  exp: z.number().int(),
  jti: z.string().min(16).max(128).regex(/^[A-Za-z0-9._-]+$/),
  /** Required for submit: sha256 (hex) of the canonical job request body. */
  req_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type DelegationClaims = z.infer<typeof DelegationClaims>;

/** A delegation token is good for at most this long, whatever `exp` says. */
export const MAX_DELEGATION_TTL_S = 300;

// ── Inference gateway (hosted by ClientSt0r) ────────────────────────────────

export const UntrustedSegment = z.object({
  ref: z.string().max(256),
  kind: z.enum(['ticket_subject', 'ticket_body', 'ticket_comment', 'ticket_attachment', 'endpoint_inventory', 'endpoint_heartbeat']),
  author_role: z.enum(['customer', 'staff', 'system', 'rem0te']).optional(),
  text: z.string().max(20000),
}).strict();

export const InferenceRequest = z.object({
  contract: z.literal(CONTRACT),
  request_id: z.string().uuid(),
  job_id: z.string().uuid(),
  organization_id: ExtId,
  model_profile: ModelProfile,
  task: z.literal('ticket_triage_v1'),
  output_schema: z.literal('analysis-output.v1'),
  max_output_tokens: z.number().int().min(1).max(8000),
  input: z.object({
    instructions_ref: z.literal('rem0te/ticket-triage/v1'),
    /** Everything here is data, never instructions. */
    untrusted_segments: z.array(UntrustedSegment).max(80),
    evidence_refs: z.array(z.string().max(256)).max(80),
  }).strict(),
}).strict();
export type InferenceRequest = z.infer<typeof InferenceRequest>;

/**
 * What a model is asked to produce. Parsed (not trusted): unknown keys are
 * dropped and counted, every string is bounded, and a "fact" that cites no
 * evidence rem0te can resolve is demoted — see analysis.ts.
 */
export const AnalysisOutput = z.object({
  category: z.string().min(1).max(64),
  summary: z.string().max(1500),
  facts: z.array(z.object({
    statement: z.string().min(1).max(600),
    evidence_refs: z.array(z.string().max(256)).max(10).default([]),
  })).max(20).default([]),
  hypotheses: z.array(z.object({
    statement: z.string().min(1).max(600),
    confidence: z.enum(['low', 'medium', 'high']),
    evidence_refs: z.array(z.string().max(256)).max(10).default([]),
  })).max(10).default([]),
  draft_reply: z.string().max(6000).default(''),
  next_steps: z.array(z.string().min(1).max(400)).max(10).default([]),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

export const InferenceResponse = z.object({
  contract: z.literal(CONTRACT),
  request_id: z.string().uuid(),
  job_id: z.string().uuid(),
  organization_id: ExtId,
  model_profile: ModelProfile,
  resolved_model: z.string().min(1).max(128),
  status: z.enum(['ok', 'refused', 'error']),
  error_code: z.string().max(64).optional(),
  output: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }).strict().optional(),
}).strict();
export type InferenceResponse = z.infer<typeof InferenceResponse>;

// ── Job and result as returned to the peer ──────────────────────────────────

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'expired'] as const;

const EvidenceItem = z.object({
  ref: z.string(),
  kind: z.string(),
  summary: z.string(),
  observed_at: IsoDate.nullable(),
}).strict();

const ClaimOut = z.object({
  statement: z.string(),
  evidence_refs: z.array(z.string()),
  model_profiles: z.array(z.string()),
}).strict();

export const AnalysisResult = z.object({
  visibility: z.literal('staff_only'),
  facts: z.array(ClaimOut.extend({ source: z.enum(['model_cited', 'rem0te_observed']) }).strict()),
  hypotheses: z.array(ClaimOut.extend({ confidence: z.enum(['low', 'medium', 'high']) }).strict()),
  unsupported_claims: z.array(ClaimOut.extend({ reason: z.string() }).strict()),
  draft_replies: z.array(z.object({
    model_profile: z.string(),
    text: z.string(),
    visibility: z.literal('staff_only'),
    requires_human_review: z.literal(true),
    /** Hosts of any links in the draft — a ticket can steer a model into inserting one. */
    link_hosts: z.array(z.string()),
  }).strict()),
  next_steps: z.array(z.object({
    text: z.string(),
    model_profiles: z.array(z.string()),
    executable: z.literal(false),
    requires_human_approval: z.literal(true),
    blocked_category: z.string().nullable(),
  }).strict()),
  per_model: z.array(z.object({
    model_profile: z.string(),
    resolved_model: z.string().nullable(),
    status: z.enum(['succeeded', 'failed']),
    category: z.string().nullable(),
    summary: z.string().nullable(),
    dropped_unknown_fields: z.number().int(),
    usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }).strict().nullable(),
  }).strict()),
  disagreements: z.array(z.object({
    kind: z.enum(['category', 'hypothesis']),
    detail: z.string(),
    model_profiles: z.array(z.string()),
  }).strict()),
  evidence: z.array(EvidenceItem),
  untrusted_input_flags: z.array(z.object({ ref: z.string(), pattern: z.string() }).strict()),
  partial_failures: z.array(z.object({ model_profile: z.string(), code: z.string(), message: z.string() }).strict()),
}).strict();
export type AnalysisResult = z.infer<typeof AnalysisResult>;

export const Job = z.object({
  contract: z.literal(CONTRACT),
  job_id: z.string().uuid(),
  status: z.enum(JOB_STATUSES),
  organization_id: z.string(),
  technician_id: z.string(),
  ticket: z.object({ id: z.string(), revision: z.number().int() }).strict(),
  endpoint_id: z.string().nullable(),
  model_profiles: z.array(z.string()),
  correlation_id: z.string(),
  idempotency_key: z.string(),
  payload_sha256: z.string(),
  created_at: IsoDate,
  updated_at: IsoDate,
  expires_at: IsoDate,
  completed_at: IsoDate.nullable(),
  last_event_sequence: z.number().int(),
  runs: z.array(z.object({
    model_profile: z.string(),
    status: z.enum(['pending', 'succeeded', 'failed']),
    error_code: z.string().nullable(),
  }).strict()),
  error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  result: AnalysisResult.nullable(),
}).strict();
export type Job = z.infer<typeof Job>;

export const EVENT_TYPES = ['job.accepted', 'job.running', 'job.succeeded', 'job.partial', 'job.failed', 'job.expired'] as const;

export const Event = z.object({
  contract: z.literal(CONTRACT),
  event_id: z.string().uuid(),
  sequence: z.number().int().min(1),
  type: z.enum(EVENT_TYPES),
  occurred_at: IsoDate,
  peer_id: z.string(),
  organization_id: z.string(),
  job_id: z.string().uuid(),
  correlation_id: z.string(),
  job: Job,
}).strict();
export type Event = z.infer<typeof Event>;

export const SignedEvent = z.object({
  event: Event,
  signature: z.object({ alg: z.literal('Ed25519'), kid: z.string(), sig: z.string() }).strict(),
}).strict();

export const Capabilities = z.object({
  contract: z.literal(CONTRACT),
  rem0te_version: z.string(),
  audience: z.string(),
  peer_id: z.string(),
  features: z.object({
    ticket_analysis: z.boolean(),
    model_comparison: z.boolean(),
    endpoint_evidence: z.array(z.enum(['inventory', 'heartbeat'])),
    /** Catalog actions that may be proposed, as "id@version"; empty when no approval signer is configured. */
    actions: z.array(z.string()),
    /** v0.29: monitoring alert events, polling and ticket linkage (see Alert*). */
    alerts: z.boolean(),
  }).strict(),
  model_profiles: z.array(z.string()),
  limits: z.object({
    max_model_profiles: z.number().int(),
    max_job_ttl_seconds: z.number().int(),
    max_delegation_ttl_seconds: z.number().int(),
    max_request_bytes: z.number().int(),
  }).strict(),
  signing_keys: z.array(z.object({ kid: z.string(), alg: z.literal('Ed25519'), public_key_pem: z.string() }).strict()),
}).strict();

// ── Action proposals (v0.26) ────────────────────────────────────────────────
//
// ClientSt0r may PROPOSE a catalog action on a mapped computer. Proposing is
// all it can do: the proposal becomes a plan on rem0te's approval signer, and
// nothing runs until roster approvers authorize that exact plan with their
// passkeys on the signer's own origin. There is no field for a command, a
// script, a path or a URL — only a catalog action id, its version and
// parameters the catalog validates.

export const ActionProposalRequest = z.object({
  contract: z.literal(CONTRACT),
  idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  organization_id: ExtId,
  technician_id: ExtId,
  /** An immutable rem0te endpoint id — never a hostname. */
  rem0te_endpoint_id: z.string().min(1).max(64).regex(/^[a-z0-9]+$/),
  action: z.object({ id: z.string().min(3).max(64).regex(/^[a-z0-9.]+$/), version: z.number().int().min(1).max(9999) }).strict(),
  params: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])).refine((o) => Object.keys(o).length <= 8, 'too many params'),
  reason: z.string().min(3).max(500),
  /** Who suggested it. An AI suggestion gets exactly the same approvals as a technician's. */
  origin: z.enum(['ai_suggestion', 'technician']),
  ticket_ref: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:#/-]+$/).nullable().default(null),
  starts_in_minutes: z.number().int().min(0).max(1440).default(0),
  window_hours: z.number().int().min(1).max(24).default(4),
}).strict();
export type ActionProposalRequest = z.infer<typeof ActionProposalRequest>;

export const ACTION_PROPOSAL_STATUSES = [
  'awaiting_approval', 'approved', 'rejected', 'canceled', 'expired', 'dispatched',
  'succeeded', 'failed', 'refused_by_endpoint', 'not_executed', 'unknown',
] as const;

export const ActionProposal = z.object({
  contract: z.literal(CONTRACT),
  idempotency_key: z.string(),
  job_id: z.string().regex(/^[a-f0-9]{32}$/),
  status: z.enum(ACTION_PROPOSAL_STATUSES),
  status_reason: z.string().nullable(),
  rem0te_endpoint_id: z.string(),
  action: z.object({ id: z.string(), version: z.number().int() }).strict(),
  origin: z.enum(['ai_suggestion', 'technician']),
  ticket_ref: z.string().nullable(),
  risk: z.enum(['low', 'high']),
  approvals_required: z.number().int(),
  customer_signoff: z.boolean(),
  /** Where people with a passkey on the roster approve. ClientSt0r shows it; it cannot act on it. */
  approval_url: z.string(),
  /** sha256 of the canonical plan the approvers are shown. */
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  window: z.object({ not_before: IsoDate, not_after: IsoDate }).strict(),
  /** What the computer reported, verbatim — never more than it observed. */
  outcome: z.enum(['succeeded', 'already_running', 'failed', 'refused', 'not_executed', 'uncertain']).nullable(),
  observed: z.record(z.string(), z.string()).nullable(),
  created_at: IsoDate,
  updated_at: IsoDate,
}).strict();
export type ActionProposal = z.infer<typeof ActionProposal>;

// ── Monitoring alerts (v0.29) ───────────────────────────────────────────────
//
// rem0te tells ClientSt0r about monitoring alerts for a mapped organization,
// when that business's notification policy turns ticketing on. Events are
// signed like job events, sequenced per organization, pushed to the peer's
// events URL and recoverable by polling. ClientSt0r answers by linking the
// ticket it opened. Linking grants nothing: it does not acknowledge,
// resolve, suppress or reach the computer.

export const ALERT_EVENT_TYPES = ['alert.raised', 'alert.updated', 'alert.resolved'] as const;

export const Alert = z.object({
  alert_id: z.string().min(1).max(64),
  /** A monitor key at the business, e.g. "offline", "disk-free", or "site-outage". */
  monitor: z.string().max(64),
  kind: z.enum(['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING', 'SITE_OUTAGE']),
  severity: z.enum(['info', 'warning', 'critical']),
  state: z.enum(['open', 'acknowledged', 'resolved']),
  /** Built by rem0te from sanitised fields. Computer names are device-reported: display as text. */
  title: Text(300),
  rem0te_endpoint_id: z.string().max(64).nullable(),
  computer_name: Text(128).nullable(),
  site_name: Text(128).nullable(),
  first_seen_at: IsoDate,
  last_seen_at: IsoDate,
  occurrences: z.number().int().min(1),
  resolved_at: IsoDate.nullable(),
  /** Set for a computer alert grouped under a site outage. */
  outage_alert_id: z.string().max(64).nullable(),
  ticket: z.object({ id: ExtId, url: z.string().url().max(500).nullable() }).strict().nullable(),
}).strict();

export const AlertEvent = z.object({
  contract: z.literal(CONTRACT),
  event_id: z.string().uuid(),
  /** Per (peer, organization), from 1, no gaps. */
  sequence: z.number().int().min(1),
  type: z.enum(ALERT_EVENT_TYPES),
  occurred_at: IsoDate,
  peer_id: z.string(),
  organization_id: z.string(),
  alert: Alert,
}).strict();
export type AlertEvent = z.infer<typeof AlertEvent>;

export const SignedAlertEvent = z.object({
  alert_event: AlertEvent,
  signature: z.object({ alg: z.literal('Ed25519'), kid: z.string(), sig: z.string() }).strict(),
}).strict();

/** POST /api/integration/v1/alerts/{alert_id}/ticket */
export const AlertTicketLink = z.object({
  contract: z.literal(CONTRACT),
  organization_id: ExtId,
  ticket_id: ExtId,
  /** https only. Shown to rem0te users as a link, so it must be the peer's own ticket page. */
  ticket_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'https only').nullable().default(null),
}).strict();

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }).strict(),
}).strict();

/** Every contract schema by file name, for the generator and the fixture tests. */
export const CONTRACT_SCHEMAS = {
  'job-request': JobRequest,
  'job': Job,
  'analysis-result': AnalysisResult,
  'event': Event,
  'signed-event': SignedEvent,
  'delegation-claims': DelegationClaims,
  'inference-request': InferenceRequest,
  'inference-response': InferenceResponse,
  'analysis-output': AnalysisOutput,
  'capabilities': Capabilities,
  'action-proposal-request': ActionProposalRequest,
  'action-proposal': ActionProposal,
  'error': ErrorBody,
  'alert': Alert,
  'alert-event': AlertEvent,
  'signed-alert-event': SignedAlertEvent,
  'alert-ticket-link': AlertTicketLink,
} as const;

export const MAX_JOB_TTL_S = 24 * 3600;
export const MAX_REQUEST_BYTES = 512 * 1024;
