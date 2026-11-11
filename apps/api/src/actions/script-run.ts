import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Running an approved library script (0.34): the rules that are the same in
 * the script library, the portal's run request, the approval signer and —
 * ported to Go in tools/windows-installer/internal/action/script.go — the
 * agent. Pure: zod and node:crypto only, so the signer loads it (it is on
 * build-approval-signer.mjs's allowed list) and the script library takes
 * its parameter and hash rules from here rather than from a copy.
 *
 * A run is the catalog action windows.script.run@1. Its parameters are
 * closed: which version, its content SHA-256, the arguments, and a timeout
 * from a fixed list. The plan also carries a `script` block — what the
 * signer's own allowlist entry says about that version (its declared
 * parameters, its contributors, its hashes) — which the signer checks is
 * exactly its entry, and from which the agent checks the arguments and the
 * approvers. The content itself is delivered beside the envelope and the
 * agent refuses it unless it hashes to the signed SHA-256.
 */

export const SCRIPT_RUN_ACTION = 'windows.script.run';
export const MAX_CONTENT_BYTES = 65_536;
export const MAX_PARAMETERS = 10;
export const DEFINITION_PREFIX = 'rem0te-script-definition-v1\n';
/** The only timeouts a run may ask for, minutes. The agent has the same list. */
export const TIMEOUT_MINUTES = [1, 5, 10, 15, 30] as const;
/** Most bytes kept of each of stdout and stderr, on the agent and again on the portal. */
export const MAX_SCRIPT_OUTPUT_BYTES = 65_536;
/** Approvals the signer needs before a script's hash goes on its allowlist. */
export const SCRIPT_ALLOWLIST_APPROVALS = 2;
/** How long run output is kept by the portal. */
export const SCRIPT_OUTPUT_RETENTION_DAYS = 90;

/**
 * Closed charsets for string parameters. Not author-supplied regexes: the
 * agent enforces exactly the same rule in Go, and a closed list can be
 * implemented identically and cannot be a catastrophic regex. None admits a
 * quote, `$`, a backtick, `;`, `|`, `&`, parentheses or a newline.
 */
export const CHARSETS = {
  alphanumeric: /^[A-Za-z0-9]*$/,
  identifier: /^[A-Za-z0-9_.-]*$/,
  hostname: /^[A-Za-z0-9.-]*$/,
  safe_text: /^[A-Za-z0-9 _.,:@-]*$/,
} as const;
export type Charset = keyof typeof CHARSETS;
const CHARSET_NAMES = Object.keys(CHARSETS) as [Charset, ...Charset[]];
export const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const INT32 = { min: -2_147_483_648, max: 2_147_483_647 } as const;

const ParamName = z.string().regex(PARAM_NAME_RE, 'a parameter name is a letter then up to 31 letters, digits or _');
const ParamDescription = z.string().trim().max(200).optional();

export const ParameterDecl = z.discriminatedUnion('type', [
  z.object({ name: ParamName, type: z.literal('string'), description: ParamDescription, required: z.boolean(), charset: z.enum(CHARSET_NAMES), maxLength: z.number().int().min(1).max(256) }).strict(),
  z.object({ name: ParamName, type: z.literal('integer'), description: ParamDescription, required: z.boolean(), min: z.number().int().min(INT32.min).max(INT32.max), max: z.number().int().min(INT32.min).max(INT32.max) }).strict()
    .refine((p) => p.min <= p.max, { message: 'min must not exceed max' }),
  z.object({ name: ParamName, type: z.literal('boolean'), description: ParamDescription, required: z.boolean() }).strict(),
  z.object({ name: ParamName, type: z.literal('choice'), description: ParamDescription, required: z.boolean(), choices: z.array(z.string().regex(CHARSETS.identifier).min(1).max(64)).min(1).max(20) }).strict()
    .refine((p) => new Set(p.choices).size === p.choices.length, { message: 'choices must be distinct' }),
]);
export type ParameterDecl = z.infer<typeof ParameterDecl>;

export const Parameters = z.array(ParameterDecl).max(MAX_PARAMETERS)
  .refine((ps) => new Set(ps.map((p) => p.name.toLowerCase())).size === ps.length, { message: 'parameter names must be distinct (PowerShell parameter names are case-insensitive)' });

/** Why this content cannot be stored or run, or null. Bytes are hashed exactly as given. */
export function contentProblem(content: string): string | null {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0 || content.trim() === '') return 'The script is empty.';
  if (bytes > MAX_CONTENT_BYTES) return `The script is ${bytes} bytes; the limit is ${MAX_CONTENT_BYTES}.`;
  // A lone surrogate would not survive a UTF-8 round trip, so the stored text
  // would not hash to what was shown.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)) {
    return 'The script contains text that is not valid UTF-8.';
  }
  // eslint-disable-next-line no-control-regex
  const ctl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.exec(content);
  if (ctl) return `The script contains a control character (U+${ctl[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}). Only tab, CR and LF are allowed.`;
  return null;
}

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

/** Canonical JSON: sorted keys, no whitespace. Arrays keep their order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function definitionSha256(d: { language: string; targetOs: string; risk: string; parameters: ParameterDecl[]; contentSha256: string }): string {
  return sha256Hex(DEFINITION_PREFIX + canonical({ language: d.language, targetOs: d.targetOs, risk: d.risk, parameters: d.parameters, contentSha256: d.contentSha256 }));
}

// ── Arguments ───────────────────────────────────────────────────────────────

export type ArgValue = string | number | boolean;

/**
 * Why these arguments do not fit these declarations, or null. The same rule
 * as argumentsProblem in internal/action/script.go, and checked by the
 * portal, the signer and the agent: every key declared (exact name), every
 * required one present, and each value of its declared type — a string
 * 1..maxLength characters of its charset, an integer in range, a boolean, or
 * one of the choices. Nothing is coerced: "5" is not an integer.
 */
export function argumentsProblem(decls: ParameterDecl[], args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length > MAX_PARAMETERS) return `at most ${MAX_PARAMETERS} arguments`;
  const byName = new Map(decls.map((d) => [d.name, d]));
  for (const k of keys) if (!byName.has(k)) return `${k}: not a declared parameter`;
  for (const d of decls) {
    if (!(d.name in a)) { if (d.required) return `${d.name}: required`; continue; }
    const v = a[d.name];
    switch (d.type) {
      case 'string':
        if (typeof v !== 'string') return `${d.name}: must be a string`;
        if (v.length < 1 || v.length > d.maxLength) return `${d.name}: 1 to ${d.maxLength} characters`;
        if (!CHARSETS[d.charset].test(v)) return `${d.name}: only ${d.charset.replace('_', ' ')} characters`;
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) return `${d.name}: must be a whole number`;
        if (v < d.min || v > d.max) return `${d.name}: ${d.min} to ${d.max}`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return `${d.name}: must be true or false`;
        break;
      case 'choice':
        if (typeof v !== 'string' || !d.choices.includes(v)) return `${d.name}: one of ${d.choices.join(', ')}`;
        break;
    }
  }
  return null;
}

// ── The plan ────────────────────────────────────────────────────────────────

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Hex32 = z.string().regex(/^[0-9a-f]{32}$/);

/** windows.script.run@1's parameters. Closed: nothing else can be named. */
export const ScriptRunParams = z.object({
  scriptVersionId: Id,
  sha256: Hex64,
  parameters: z.record(z.string().regex(PARAM_NAME_RE), z.union([z.string().max(256), z.number().int().min(INT32.min).max(INT32.max), z.boolean()]))
    .refine((o) => Object.keys(o).length <= MAX_PARAMETERS, `at most ${MAX_PARAMETERS} arguments`),
  timeoutMinutes: z.number().int().refine((n) => (TIMEOUT_MINUTES as readonly number[]).includes(n), `one of ${TIMEOUT_MINUTES.join(', ')} minutes`),
}).strict();
export type ScriptRunParams = z.infer<typeof ScriptRunParams>;

/**
 * What the signer's allowlist entry says about the version a plan runs.
 * Signed with the plan. The signer refuses a plan whose block is not exactly
 * its entry; the agent takes the declared parameters and the contributors
 * from here (never from the portal's word at delivery).
 */
export const ScriptBlock = z.object({
  allowlistId: Hex32,
  scriptId: Id,
  versionId: Id,
  name: z.string().min(1).max(120),
  version: z.number().int().min(1).max(1_000_000),
  /** The script's business, or null for a global script. */
  businessId: Id.nullable(),
  language: z.literal('powershell'),
  targetOs: z.literal('windows'),
  risk: z.enum(['low', 'medium', 'high']),
  parameters: Parameters,
  contentSha256: Hex64,
  contentBytes: z.number().int().min(1).max(MAX_CONTENT_BYTES),
  definitionSha256: Hex64,
  /** Everyone who wrote the content (definition.ts contributorsOf): none of them may approve a run. */
  contributors: z.array(Id).min(1).max(50),
  /** The library reviewer who approved the version. */
  reviewedBy: Id,
}).strict();
export type ScriptBlock = z.infer<typeof ScriptBlock>;

/**
 * The script-specific rules for a plan, or null. Shared by the portal and
 * the signer through validatePlanAction; the agent's ParamsOK and Precheck
 * apply the same.
 */
export function scriptPlanProblem(p: { action: { id: string; version: number }; params: Record<string, unknown>; script?: ScriptBlock; targets: { businessId: string }[] }): string | null {
  const isRun = p.action.id === SCRIPT_RUN_ACTION;
  if (!isRun) return p.script === undefined ? null : 'script_not_allowed';
  if (!p.script) return 'script_missing';
  const params = ScriptRunParams.safeParse(p.params);
  if (!params.success) return 'params_not_allowed';
  const s = p.script;
  if (params.data.sha256 !== s.contentSha256 || params.data.scriptVersionId !== s.versionId) return 'script_mismatch';
  if (definitionSha256(s) !== s.definitionSha256) return 'script_mismatch';
  if (s.businessId !== null && p.targets.some((t) => t.businessId !== s.businessId)) return 'script_wrong_business';
  if (argumentsProblem(s.parameters, params.data.parameters)) return 'arguments_not_allowed';
  return null;
}

// ── The signer's allowlist ──────────────────────────────────────────────────

const Person = z.object({ userId: Id, name: z.string().min(1).max(120) }).strict();

/**
 * What the portal proposes for the signer's allowlist. The signer hashes
 * `content` itself and refuses the proposal if that is not `contentSha256`;
 * it shows its approvers the content, not the portal's description of it.
 */
export const ScriptProposal = z.object({
  allowlistId: Hex32,
  scriptId: Id,
  versionId: Id,
  name: z.string().min(1).max(120),
  version: z.number().int().min(1).max(1_000_000),
  description: z.string().max(2000),
  businessId: Id.nullable(),
  businessName: z.string().max(120).nullable(),
  language: z.literal('powershell'),
  targetOs: z.literal('windows'),
  risk: z.enum(['low', 'medium', 'high']),
  parameters: Parameters,
  contentSha256: Hex64,
  content: z.string().max(MAX_CONTENT_BYTES),
  contributors: z.array(Person).min(1).max(50),
  reviewedBy: Person.extend({ at: z.string().datetime() }).strict(),
  proposedBy: Person,
}).strict();
export type ScriptProposal = z.infer<typeof ScriptProposal>;

/** The block a plan for this proposal must carry, from the signer's own copy. */
export function scriptBlockOf(p: ScriptProposal): ScriptBlock {
  const contentSha256 = sha256Hex(p.content);
  return {
    allowlistId: p.allowlistId, scriptId: p.scriptId, versionId: p.versionId, name: p.name, version: p.version, businessId: p.businessId,
    language: p.language, targetOs: p.targetOs, risk: p.risk, parameters: p.parameters, contentSha256,
    contentBytes: Buffer.byteLength(p.content, 'utf8'),
    definitionSha256: definitionSha256({ language: p.language, targetOs: p.targetOs, risk: p.risk, parameters: p.parameters, contentSha256 }),
    contributors: p.contributors.map((c) => c.userId), reviewedBy: p.reviewedBy.userId,
  };
}
