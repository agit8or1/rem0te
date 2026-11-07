import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as net from 'net';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { RustdeskService } from '../common/rustdesk.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { queryHbbsOnline } from '../enrollment/hbbs-presence';
import { agentMeetsContract, AGENT_CONTRACT_VERSION, compareVersions } from '../common/agent-contract';
import { CANDIDATE_LIVE_MS } from '../enrollment/device-secret';

/**
 * Outcome of one check. Deliberately not a boolean:
 *   pass         the check ran and the thing it tests is fine
 *   fail         the check ran and found a concrete problem
 *   warn         works, but something is degraded or likely to bite
 *   stale        the evidence exists but is too old to trust as current
 *   unavailable  this check could not be run (no data source, not reported)
 *   info         a fact, not a verdict (e.g. "a password is stored")
 */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'stale' | 'unavailable' | 'info';
/** Where the evidence points. */
export type CheckLocation = 'technician' | 'endpoint' | 'server';

export interface DiagnosticCheck {
  key: string;
  label: string;
  location: CheckLocation;
  status: CheckStatus;
  /** What produced this result, in words. */
  source: string;
  /** When the underlying evidence was observed (not when this page loaded). */
  observedAt: string | null;
  summary: string;
  nextSteps: string[];
  /** Existing mechanisms the UI may offer — each needs an explicit click. */
  actions: { id: string; label: string; changesConfiguration: boolean }[];
}

const RANK: Record<CheckStatus, number> = { fail: 5, warn: 4, stale: 3, unavailable: 2, info: 1, pass: 0 };

const HEARTBEAT_FRESH_MIN = 10;
const TECH_REPORT_FRESH_MIN = 60;
const TECH_REPORT_MAX_H = 24;

function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function ageText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 120) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/**
 * Remove anything secret-shaped from a structure before it leaves the server
 * as a downloadable report. Keys that name a secret are replaced outright;
 * long opaque strings anywhere are masked too, because a value does not have
 * to be under a key called "password" to be one.
 */
export function redactForReport(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9+/_=-]{32,}$/.test(value) && !/^\d+$/.test(value)) return '[redacted]';
    return value.replace(/(password|token|secret)=([^\s&,]+)/gi, '$1=[redacted]');
  }
  if (Array.isArray(value)) return value.map((v) => redactForReport(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /pass(word)?|secret|token|nonce|cookie|authorization|credential|privatekey|apikey/i.test(k) &&
        !/^has|Matches$|Present$|Status$|^passCount$/i.test(k)
        ? '[redacted]'
        : redactForReport(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Test Connection.
 *
 * Separate checks, each with its own status, location, source and time —
 * never folded into one online/offline light, because the single light is
 * exactly what hid "the agent is dead but RustDesk is fine" and "RustDesk is
 * registered but the technician's client points at rustdesk.com".
 *
 * Nothing here starts a remote session or sends a punch-hole request: hbbs
 * presence uses the same passive OnlineRequest the RustDesk address book
 * uses, and the TCP probes only open and close a socket to the server's own
 * ports. Nothing here changes configuration; repairs are offered as actions
 * that use the existing mechanisms and need an explicit click.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly rustdesk: RustdeskService,
    private readonly enrollment: EnrollmentService,
  ) {}

  async run(actor: ActorContext, endpointId: string) {
    const ep = await this.acl.assertEndpointInScope(actor, endpointId);
    const now = new Date();
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true, name: true, hostname: true, platform: true, agentVersion: true, isOnline: true, lastSeenAt: true, status: true,
        rustdeskNode: {
          select: {
            rustdeskId: true, version: true, lastSeenAt: true, permanentPassword: true,
            agentSecretHash: true, candidateSecretHash: true, candidateSecretSeenAt: true, candidateSecretConflict: true,
            pendingPasswordAt: true, updateRequestedAt: true, updateTargetVersion: true,
            reinstallRequestedAt: true, rdSessionsActive: true, rdSessionsObservedAt: true,
          },
        },
      },
    });
    if (!endpoint) throw new NotFoundException('Computer not found');
    const node = endpoint.rustdeskNode;
    const checks: DiagnosticCheck[] = [];
    const nowIso = now.toISOString();

    // ── Server ──────────────────────────────────────────────────────────────
    const config = await this.rustdesk.serverConfig();
    if (!config) {
      checks.push({
        key: 'server_config', label: 'Server RustDesk settings', location: 'server', status: 'fail',
        source: 'Rem0te settings', observedAt: nowIso,
        summary: 'No valid RustDesk relay host and key are configured, so no client can be pointed at this server.',
        nextSteps: ['A Platform Admin must set the relay host and public key under Settings.'], actions: [],
      });
    } else {
      checks.push({
        key: 'server_config', label: 'Server RustDesk settings', location: 'server', status: 'pass',
        source: 'Rem0te settings', observedAt: nowIso,
        summary: `Clients are pointed at ${config.host}${config.key ? ' with a public key configured' : ' (no public key configured — encrypted connections cannot be enforced)'}.`,
        nextSteps: [], actions: [],
      });
      const [p21116, p21117, p21115] = await Promise.all([
        tcpProbe(config.host, 21116), tcpProbe(config.host, 21117), tcpProbe(config.host, 21115),
      ]);
      const ports = [
        { key: 'server_rendezvous', label: 'Rendezvous server (hbbs) TCP 21116', ok: p21116, what: 'rendezvous (hbbs)' },
        { key: 'server_relay', label: 'Relay server (hbbr) TCP 21117', ok: p21117, what: 'relay (hbbr)' },
        { key: 'server_nat', label: 'hbbs NAT test TCP 21115', ok: p21115, what: 'NAT test' },
      ];
      for (const p of ports) {
        checks.push({
          key: p.key, label: p.label, location: 'server', status: p.ok ? 'pass' : 'fail',
          source: `TCP connect from the Rem0te server to ${config.host}`, observedAt: nowIso,
          summary: p.ok
            ? `The ${p.what} port accepts connections from the Rem0te server. This does not prove it is reachable from the remote computer's or your network, or that a session will connect.`
            : `The ${p.what} port did not accept a connection from the Rem0te server itself.`,
          nextSteps: p.ok ? [] : [
            'Check that the RustDesk server services (hbbs/hbbr) are running on the server.',
            `Check the server firewall allows ${p.label.match(/\d{5}/)?.[0]}/tcp (and 21116/udp for hbbs).`,
          ],
          actions: [],
        });
      }
    }

    // ── Endpoint ────────────────────────────────────────────────────────────
    const hb = endpoint.lastSeenAt;
    if (!hb) {
      checks.push({
        key: 'agent_heartbeat', label: 'Rem0te agent heartbeat', location: 'endpoint', status: 'unavailable',
        source: 'Agent heartbeat (every 3 minutes)', observedAt: null,
        summary: 'This computer\'s agent has never checked in.',
        nextSteps: ['Run the Rem0te installer on the computer.'], actions: [],
      });
    } else {
      const age = now.getTime() - hb.getTime();
      const fresh = age <= HEARTBEAT_FRESH_MIN * 60_000;
      checks.push({
        key: 'agent_heartbeat', label: 'Rem0te agent heartbeat', location: 'endpoint', status: fresh ? 'pass' : 'fail',
        source: 'Agent heartbeat (every 3 minutes)', observedAt: hb.toISOString(),
        summary: fresh
          ? `Last check-in ${ageText(age)} ago.`
          : `No check-in for ${ageText(age)}. The computer is off, offline, or its agent task is not running. RustDesk itself may still be reachable — see the RustDesk registration check.`,
        nextSteps: fresh ? [] : [
          'Confirm the computer is powered on and online.',
          'If RustDesk is still registered but the agent is silent, re-run the installer on the computer (it keeps its enrolment and password).',
        ],
        actions: fresh ? [] : [{ id: 'reinstall_agent', label: 'Request agent reinstall (on next check-in)', changesConfiguration: true }],
      });
    }

    if (node) {
      if (!node.agentSecretHash) {
        checks.push({
          key: 'agent_identity', label: 'Agent identity (device secret)', location: 'endpoint', status: 'fail',
          source: 'Rem0te enrolment record', observedAt: nowIso,
          summary: 'This computer enrolled before device secrets existed. Its heartbeats only refresh online status; no credential rotation or update can be delivered to it.',
          nextSteps: ['Re-run the installer on the computer with a fresh enrolment link.'], actions: [],
        });
      } else if (node.candidateSecretHash && node.candidateSecretSeenAt &&
          now.getTime() - node.candidateSecretSeenAt.getTime() < CANDIDATE_LIVE_MS) {
        checks.push({
          key: 'agent_identity', label: 'Agent identity (device secret)', location: 'endpoint', status: 'fail',
          source: 'Rejected heartbeats', observedAt: node.candidateSecretSeenAt.toISOString(),
          summary: node.candidateSecretConflict
            ? 'Two different device secrets have been offered for this RustDesk ID recently. Heartbeats are being rejected and the new secret cannot be accepted until only one is seen.'
            : 'The computer is checking in with a NEW device secret (usually an installer re-run). Its heartbeats are rejected until you accept it.',
          nextSteps: ['Check the address on the computer page matches where the computer really is, then accept the new device secret.'],
          actions: node.candidateSecretConflict ? [] : [{ id: 'accept_device_secret', label: 'Accept this device', changesConfiguration: true }],
        });
      } else {
        checks.push({
          key: 'agent_identity', label: 'Agent identity (device secret)', location: 'endpoint', status: 'pass',
          source: 'Rem0te enrolment record', observedAt: nowIso,
          summary: 'Heartbeats from this computer authenticate with its device secret.', nextSteps: [], actions: [],
        });
      }

      const agentOk = agentMeetsContract(endpoint.agentVersion);
      checks.push({
        key: 'agent_version', label: 'Rem0te agent version', location: 'endpoint', status: endpoint.agentVersion ? (agentOk ? 'pass' : 'warn') : 'unavailable',
        source: 'Agent heartbeat', observedAt: hb?.toISOString() ?? null,
        summary: endpoint.agentVersion
          ? `Agent ${endpoint.agentVersion}${agentOk ? '' : ` is older than ${AGENT_CONTRACT_VERSION}: it does not report sessions, inventory or update evidence`}.`
          : 'The agent has not reported its version (installer older than 0.15.0).',
        nextSteps: agentOk ? [] : ['Request an agent reinstall; it keeps the enrolment, password and settings.'],
        actions: agentOk ? [] : [{ id: 'reinstall_agent', label: 'Request agent reinstall', changesConfiguration: true }],
      });

      // Live: is RustDesk on this computer registered with hbbs right now?
      const online = await queryHbbsOnline([node.rustdeskId], {
        host: process.env.HBBS_PRESENCE_HOST || undefined,
        port: Number(process.env.HBBS_PRESENCE_PORT) || undefined,
      });
      const ever = await this.enrollment.peerRegisteredWithHbbs(node.rustdeskId);
      if (online === null) {
        checks.push({
          key: 'rustdesk_presence', label: 'RustDesk registration (live)', location: 'server', status: 'unavailable',
          source: 'hbbs OnlineRequest from the Rem0te server', observedAt: nowIso,
          summary: 'Rem0te could not ask hbbs which computers are registered, so RustDesk reachability is unknown.',
          nextSteps: ['If hbbs runs on another host, set HBBS_PRESENCE_HOST so the API can query it.'], actions: [],
        });
      } else {
        const on = online.has(node.rustdeskId);
        checks.push({
          key: 'rustdesk_presence', label: 'RustDesk registration (live)', location: 'endpoint', status: on ? 'pass' : 'fail',
          source: 'hbbs OnlineRequest from the Rem0te server', observedAt: nowIso,
          summary: on
            ? `RustDesk ID ${node.rustdeskId} re-registered with this server's hbbs within the last 30 seconds. This shows the computer can reach the rendezvous server; it does not prove a session will connect (that also needs the relay or a direct path, and the right password).`
            : `RustDesk ID ${node.rustdeskId} is not currently registered with this server's hbbs.` +
              (ever === true ? ' It has registered before.' : ever === false ? ' hbbs has no record of it ever registering.' : ''),
          nextSteps: on ? [] : [
            'Check the RustDesk service is running on the computer.',
            'Check the computer can reach this server on 21116/udp and 21116/tcp (outbound firewall).',
            ever === false ? 'The client may be pointed at a different server or key; re-run the installer, which rewrites both.' : 'If the agent is also silent, the computer is probably off or offline.',
          ],
          actions: [],
        });
      }

      const want = await this.rustdesk.pinnedOrLatestVersion();
      const rv = node.version;
      checks.push({
        key: 'rustdesk_version', label: 'RustDesk version on the computer', location: 'endpoint',
        status: !rv ? 'unavailable' : compareVersions(rv, want) >= 0 ? 'pass' : 'warn',
        source: 'Agent heartbeat (file version of rustdesk.exe)', observedAt: node.lastSeenAt?.toISOString() ?? null,
        summary: !rv ? 'Not reported.' : `${rv} installed; the supported version is ${want}.` +
          (node.updateRequestedAt ? ` An update to ${node.updateTargetVersion} is staged.` : ''),
        nextSteps: rv && compareVersions(rv, want) < 0 ? ['Schedule it in an update rollout (Updates page).'] : [],
        actions: [],
      });

      // Credentials — facts only. A stored password is never "verified".
      const lastRotation = await this.prisma.activityLog.findFirst({
        where: { action: 'ENDPOINT_CREDENTIAL_ROTATED', resourceId: endpointId },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      const pendingAge = node.pendingPasswordAt ? now.getTime() - node.pendingPasswordAt.getTime() : null;
      checks.push({
        key: 'credential_sync', label: 'Stored RustDesk credential', location: 'endpoint',
        status: node.pendingPasswordAt ? 'warn' : node.permanentPassword ? 'info' : 'warn',
        source: 'Rem0te credential record and rotation acknowledgements', observedAt: (node.pendingPasswordAt ?? lastRotation?.createdAt ?? null)?.toISOString() ?? null,
        summary:
          (node.permanentPassword
            ? 'A password is stored for this computer. Rem0te cannot confirm it matches what RustDesk on the computer expects without connecting.'
            : 'No password is stored; RustDesk will prompt for one.') +
          (node.pendingPasswordAt
            ? ` A rotation has been waiting for the computer to acknowledge it for ${ageText(pendingAge!)}${endpoint.isOnline ? '' : ' (the computer is offline)'}; until then the previous password is the one in use.`
            : '') +
          (lastRotation ? ` Last acknowledged rotation: ${lastRotation.createdAt.toISOString()}.` : ''),
        nextSteps: [
          ...(node.pendingPasswordAt ? ['The rotation completes on the computer\'s next authenticated check-in.'] : []),
          'If RustDesk reports a wrong password, rotate the credential (it is applied and acknowledged by the agent).',
        ],
        actions: node.agentSecretHash && !node.pendingPasswordAt
          ? [{ id: 'rotate_credential', label: 'Rotate credential', changesConfiguration: true }] : [],
      });

      if (node.rdSessionsObservedAt) {
        const fresh = now.getTime() - node.rdSessionsObservedAt.getTime() <= HEARTBEAT_FRESH_MIN * 60_000;
        checks.push({
          key: 'endpoint_sessions', label: 'Incoming RustDesk sessions on the computer', location: 'endpoint',
          status: fresh ? 'info' : 'stale',
          source: 'Agent heartbeat (RustDesk connection-manager processes)', observedAt: node.rdSessionsObservedAt.toISOString(),
          summary: `${node.rdSessionsActive ?? 0} incoming session(s) at last report.`, nextSteps: [], actions: [],
        });
      }
    } else {
      checks.push({
        key: 'rustdesk_presence', label: 'RustDesk registration (live)', location: 'endpoint', status: 'unavailable',
        source: 'Rem0te enrolment record', observedAt: null,
        summary: 'This computer has no RustDesk ID recorded yet.', nextSteps: ['Finish enrolment by running the installer.'], actions: [],
      });
    }

    // ── Technician ──────────────────────────────────────────────────────────
    checks.push(...(await this.technicianChecks(actor.userId, config, now)));

    await this.audit.log({
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'DIAGNOSTICS_RUN', resource: 'endpoint', resourceId: endpointId,
      meta: { failed: checks.filter((c) => c.status === 'fail').map((c) => c.key) },
    });

    const byLocation = (['technician', 'endpoint', 'server'] as CheckLocation[]).map((loc) => {
      const cs = checks.filter((c) => c.location === loc);
      const worst = cs.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'pass');
      return { location: loc, worst: cs.length ? worst : 'unavailable', failing: cs.filter((c) => c.status === 'fail').map((c) => c.label) };
    });

    return {
      endpoint: { id: endpoint.id, name: endpoint.name, hostname: endpoint.hostname, rustdeskId: node?.rustdeskId ?? null },
      ranAt: nowIso,
      checks,
      byLocation,
      disclaimer:
        'These are separate checks of each part of the path. Passing them all does not prove a remote desktop session will connect, ' +
        'and a stored password is never tested. Test Connection does not start a session.',
    };
  }

  private async technicianChecks(userId: string, config: Awaited<ReturnType<RustdeskService['serverConfig']>>, now: Date): Promise<DiagnosticCheck[]> {
    const last = await this.prisma.technicianDiagnostic.findFirst({
      where: { userId, submittedAt: { not: null } },
      orderBy: { submittedAt: 'desc' },
    });
    const action = { id: 'run_technician_check', label: 'Check this computer (download read-only helper)', changesConfiguration: false };
    if (!last?.submittedAt || now.getTime() - last.submittedAt.getTime() > TECH_REPORT_MAX_H * 3600_000) {
      return [{
        key: 'tech_report', label: 'Your computer (technician side)', location: 'technician', status: 'unavailable',
        source: 'Technician helper script', observedAt: last?.submittedAt?.toISOString() ?? null,
        summary: 'A web page cannot inspect your computer\'s RustDesk installation. Run the read-only helper to check it (Windows).',
        nextSteps: ['Download and run the helper, then refresh this panel.'], actions: [action],
      }];
    }
    const r = (last.report ?? {}) as Record<string, unknown>;
    const at = last.submittedAt.toISOString();
    const stale = now.getTime() - last.submittedAt.getTime() > TECH_REPORT_FRESH_MIN * 60_000;
    const st = (ok: boolean, bad: CheckStatus = 'fail'): CheckStatus => (stale ? 'stale' : ok ? 'pass' : bad);
    const src = 'Technician helper script (read-only, run on your computer)';
    const want = await this.rustdesk.pinnedOrLatestVersion();
    const ver = String(r.installedVersion || r.portableVersion || '');
    const repair = { id: 'technician_setup', label: 'Download the RustDesk setup script (repairs server settings)', changesConfiguration: true };
    const out: DiagnosticCheck[] = [];

    out.push({
      key: 'tech_install', label: 'RustDesk on your computer', location: 'technician',
      status: st(!!(r.installed || r.portableCached), 'warn'), source: src, observedAt: at,
      summary: r.installed ? `Installed at ${String(r.installedPath)} (${String(r.installedVersion || 'version unknown')}).`
        : r.portableCached ? `Not installed; Rem0te's portable copy (${String(r.portableVersion || 'version unknown')}) is cached and Connect will use it.`
          : 'No RustDesk found. Connect will download a portable copy the first time.',
      nextSteps: [], actions: [],
    });
    if (r.installed) {
      const hostOk = r.hostMatches === true;
      const keyOk = r.keyMatches === true;
      out.push({
        key: 'tech_config', label: 'Your RustDesk server address and key', location: 'technician',
        status: st(hostOk && keyOk), source: src, observedAt: at,
        summary: hostOk && keyOk
          ? `Your installed RustDesk points at ${config?.host ?? 'this server'} with the matching key.`
          : `Your installed RustDesk points at ${String(r.configHost || 'no custom server (rustdesk.com)')}` +
            `${r.keyPresent ? (keyOk ? ' with the right key' : ' with a DIFFERENT key — hbbs rejects its connections as "Key mismatch"') : ' with no key'}.` +
            ' It will report remote computers as offline or reject the connection.',
        nextSteps: hostOk && keyOk ? [] : [
          'Use Connect: its script repairs the installed client (one administrator prompt), or',
          'run the RustDesk setup script from Downloads, or quit RustDesk so Connect can use the portable copy.',
        ],
        actions: hostOk && keyOk ? [] : [repair],
      });
      if (ver) {
        out.push({
          key: 'tech_version', label: 'Your RustDesk version', location: 'technician',
          status: st(compareVersions(ver, want) >= 0, 'warn'), source: src, observedAt: at,
          summary: `${ver}; supported version is ${want}.`,
          nextSteps: compareVersions(ver, want) >= 0 ? [] : ['Connect upgrades it during its repair step.'], actions: [],
        });
      }
    }
    const reach = r.tcp21116 === true && r.tcp21117 === true;
    out.push({
      key: 'tech_network', label: 'Your network to the RustDesk server', location: 'technician',
      status: st(reach), source: src, observedAt: at,
      summary: reach
        ? `Your computer can open TCP connections to ${config?.host ?? 'the server'} on 21116 and 21117.`
        : `From your computer: 21116/tcp ${r.tcp21116 ? 'reachable' : 'NOT reachable'}, 21117/tcp ${r.tcp21117 ? 'reachable' : 'NOT reachable'}.`,
      nextSteps: reach ? [] : ['A firewall or proxy on your network is blocking the RustDesk ports. Try another network or ask your network admin.'],
      actions: [],
    });
    if (stale) {
      out.forEach((c) => {
        c.summary = `(From a check ${ageText(now.getTime() - last.submittedAt!.getTime())} ago.) ${c.summary}`;
        c.actions.push(action);
      });
    }
    return out;
  }

  /** Downloadable troubleshooting report, redacted. */
  async report(actor: ActorContext, endpointId: string): Promise<string> {
    const d = await this.run(actor, endpointId);
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId: actor.businessId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'DIAGNOSTICS_REPORT_DOWNLOADED', resource: 'endpoint', resourceId: endpointId,
    });
    const safe = redactForReport(d) as typeof d;
    const lines = [
      `Rem0te connection diagnostics`,
      `Computer: ${safe.endpoint.name} (${safe.endpoint.hostname ?? '-'}) RustDesk ID ${safe.endpoint.rustdeskId ?? '-'}`,
      `Run at:   ${safe.ranAt}`,
      ``,
      safe.disclaimer,
      ``,
      ...safe.byLocation.map((l) => `${l.location.toUpperCase().padEnd(11)} worst: ${l.worst}${l.failing.length ? `  failing: ${l.failing.join(', ')}` : ''}`),
      ``,
    ];
    for (const c of safe.checks) {
      lines.push(`[${c.status.toUpperCase()}] ${c.label} (${c.location})`);
      lines.push(`  source:   ${c.source}`);
      lines.push(`  observed: ${c.observedAt ?? 'never'}`);
      lines.push(`  ${c.summary}`);
      c.nextSteps.forEach((s) => lines.push(`  -> ${s}`));
      lines.push('');
    }
    lines.push('Passwords, tokens and secrets are redacted from this report.');
    return lines.join('\r\n');
  }

  // ── Technician helper ────────────────────────────────────────────────────

  async technicianHelper(actor: ActorContext, endpointId?: string): Promise<string> {
    const config = await this.rustdesk.serverConfig();
    if (!config) throw new BadRequestException('No RustDesk server is configured yet');
    const base = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
    if (!base) throw new BadRequestException('PUBLIC_API_URL is not set, so the helper has nowhere to report');
    const token = randomBytes(24).toString('hex');
    await this.prisma.technicianDiagnostic.create({
      data: {
        userId: actor.userId, endpointId: endpointId ?? null,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 2 * 3600_000),
      },
    });
    return this.rustdesk.buildTechnicianCheckCmd({
      config, token, reportUrl: `${base}/api/v1/diagnostics/technician/report`,
      expectedVersion: await this.rustdesk.pinnedOrLatestVersion(),
    });
  }

  /** The helper reporting back. Single use; only whitelisted fields are kept. */
  async submitTechnicianReport(token: string, report: unknown, ip?: string) {
    if (!/^[0-9a-f]{48}$/.test(token)) return { accepted: false };
    const hash = createHash('sha256').update(token).digest('hex');
    const rec = await this.prisma.technicianDiagnostic.findUnique({ where: { tokenHash: hash } });
    if (!rec || rec.submittedAt || rec.expiresAt < new Date()) return { accepted: false };
    const r = (report && typeof report === 'object' ? report : {}) as Record<string, unknown>;
    const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, n) : '');
    const bool = (v: unknown) => v === true;
    const clean = {
      collectedAt: str(r.collectedAt, 40), os: str(r.os, 120),
      installed: bool(r.installed), installedPath: str(r.installedPath, 260), installedVersion: str(r.installedVersion, 32),
      portableCached: bool(r.portableCached), portableVersion: str(r.portableVersion, 32),
      serviceStatus: str(r.serviceStatus, 32), runningProcesses: typeof r.runningProcesses === 'number' ? Math.min(99, Math.max(0, Math.round(r.runningProcesses))) : null,
      configFound: bool(r.configFound), configHost: str(r.configHost, 253), hostMatches: bool(r.hostMatches),
      keyPresent: bool(r.keyPresent), keyMatches: bool(r.keyMatches), protocolHandler: bool(r.protocolHandler),
      tcp21116: bool(r.tcp21116), tcp21117: bool(r.tcp21117),
    };
    const claimed = await this.prisma.technicianDiagnostic.updateMany({
      where: { id: rec.id, submittedAt: null },
      data: { submittedAt: new Date(), submittedIp: ip ?? null, report: clean as Prisma.InputJsonValue },
    });
    if (claimed.count === 0) return { accepted: false };
    await this.audit.log({
      actorId: rec.userId, actorIp: ip,
      action: 'TECHNICIAN_DIAGNOSTIC_SUBMITTED', resource: 'technician_diagnostic', resourceId: rec.id,
      meta: { hostMatches: clean.hostMatches, keyMatches: clean.keyMatches, tcp21116: clean.tcp21116, tcp21117: clean.tcp21117 },
    });
    return { accepted: true };
  }
}
