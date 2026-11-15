/**
 * Demo data for the pages added in 0.46–0.50, for documentation screenshots
 * and the walkthrough video. Runs ONLY against the throwaway
 * reboot_remote_docs database, after _docs-demo-workbench.ts and
 * _docs-demo-dispatch.ts, and before _docs-demo-refresh.ts. Idempotent: it
 * clears what it owns first, so it can be re-run before every capture.
 *
 *   DATABASE_URL=…/reboot_remote_docs npx tsx prisma/_docs-demo-roster.ts
 *
 * What it writes, and why:
 *   - (0.50) Harbor Logistics moves from a hand-made patch policy to a
 *     company-wide one. The workbench's hand-made policies are revoked and
 *     rejected (their history stays on the Patching page). A company-wide
 *     policy, "Harbor — every computer, Tuesday night", runs revision 1 with
 *     HARB-DISPATCH-02 as the canary and HARB-DISPATCH-01 after it. An
 *     assignable policy, "Harbor depots — Sunday early morning", runs revision
 *     1 for the two depot computers, which are set to use it. HARB-WAREHOUSE-2
 *     is set to Exclude. HARB-GATEHOUSE was excluded until a few minutes ago
 *     and is back on Inherit, so the company-wide policy's last check says the
 *     change is settling and the computer's card says it joins at the next
 *     revision. The rest are left out with the code the real check gives
 *     (not Windows, standard agent).
 *
 *     Both revisions are written as the docs stack's direct-mode signer would
 *     have admitted them: ACTIVE at admission, no approvers. The rings are
 *     planned by the portal's own planRings (src/patching/assignment.ts), so
 *     the canary and its reason are what the real sweep would say. The signed
 *     documents name the computers' enrolled identities, as a real one must.
 *   - (0.46) automatic agent updates set per computer and per business:
 *     HARB-DISPATCH-01 On, HARB-GATEHOUSE Off, Harbor's business policy
 *     On (any time), Northwind Dental's Off. The docs API runs with
 *     AGENT_AUTO_UPDATE=off, which stops dispatch only: the selectors show these
 *     values and the "Effective" line says the server switch wins — true of
 *     the demo server.
 *   - (0.49) Settings → Confirm it is you as an installation upgraded from
 *     0.47 with everyday changes relaxed has it: the seven 0.47 everyday
 *     functions and a computer's patch policy set to Don't ask, everything
 *     else asks.
 *
 * Nothing here can reach anything: no signer call, no destinations.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { POLICY_SCHEMA, policyDigest, type PolicyDoc } from '../src/actions/patch-policy';
import { planRings, revisionReason, type Candidate, type LeftOut } from '../src/patching/assignment';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

// Security, Critical and Definition Updates — the default ticks in the UI (lib/patching.ts).
const CLASSES = ['0fa1201d-4330-4fa8-8ae9-b877473b6441', 'e6cf1350-c01b-414d-a61f-263d14d133b4', 'e0789628-ce08-4437-be74-2495b842f43b'];
/** A stand-in Ed25519 public key in the agent's encoding: 32 bytes, base64. */
const resultKey = (seed: string) => createHash('sha256').update(`docs-result-key:${seed}`).digest('base64');

const COMPANY = 'Harbor — every computer, Tuesday night';
const DEPOTS = 'Harbor depots — Sunday early morning';

async function main() {
  const harbor = await prisma.customer.findFirst({ where: { name: 'Harbor Logistics' } });
  const northwind = await prisma.customer.findFirst({ where: { name: 'Northwind Dental' } });
  const admin = await prisma.user.findFirst({ where: { isPlatformAdmin: true }, orderBy: { createdAt: 'asc' } });
  if (!harbor || !northwind || !admin) throw new Error('run _docs-demo-data.ts and _docs-demo-workbench.ts first');

  // ── Clear what this module owns ─────────────────────────────────────────
  await prisma.endpoint.updateMany({ where: { customerId: harbor.id }, data: { patchPolicyMode: 'inherit', patchPolicySeriesId: null } });
  const old = await prisma.patchPolicySeries.findMany({ where: { customerId: harbor.id }, select: { id: true } });
  await prisma.patchPolicyComputer.deleteMany({ where: { customerId: harbor.id } });
  await prisma.patchPolicy.deleteMany({ where: { seriesId: { in: old.map((s) => s.id) } } });
  await prisma.patchPolicySeries.deleteMany({ where: { customerId: harbor.id } });
  await prisma.patchPolicyRevisionClaim.deleteMany({ where: { customerId: harbor.id } });

  const eps = await prisma.endpoint.findMany({
    where: { customerId: harbor.id, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, hostname: true, platform: true, updateChannel: true, createdAt: true, rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const byName = (n: string) => { const e = eps.find((x) => x.name === n); if (!e) throw new Error(`demo computer ${n} missing`); return e; };
  const host = (e: (typeof eps)[number]) => (e.hostname ?? e.name).slice(0, 64);

  // ── The hand-made policies become history ───────────────────────────────
  const handMade = await prisma.patchPolicy.findMany({ where: { customerId: harbor.id, seriesId: null } });
  for (const p of handMade) {
    if (p.status === 'ACTIVE') {
      await prisma.patchPolicy.update({ where: { id: p.id }, data: { status: 'REVOKED', revokedAt: ago(5 * DAY), revokedById: admin.id, signerRevokedAt: ago(5 * DAY - 2 * MIN), revokeReason: 'Replaced by the company-wide policy and the depots policy.' } });
    } else if (p.status === 'AWAITING_APPROVAL') {
      await prisma.patchPolicy.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
    }
  }

  // ── Who uses what ───────────────────────────────────────────────────────
  // Each Windows computer on the signed agent has a result key (a 0.34+ signed scan).
  const signed = eps.filter((e) => /windows/i.test(e.platform ?? '') && e.updateChannel === 'signed');
  const hours = await prisma.endpointMetricHourly.groupBy({ by: ['endpointId'], where: { endpointId: { in: signed.map((e) => e.id) }, hour: { gte: new Date(NOW - 7 * DAY) } }, _count: { _all: true } });
  const reliability = new Map(hours.map((h) => [h.endpointId, h._count._all]));
  const cand = (e: (typeof eps)[number]): Candidate => ({
    endpointId: e.id, hostname: host(e), createdAt: e.createdAt.getTime(),
    rustdeskId: e.rustdeskNode!.rustdeskId!, deviceSecretSha256: e.rustdeskNode!.agentSecretHash!,
    resultKey: resultKey(e.id), canaryReady: true, reliability: reliability.get(e.id) ?? 0,
  });
  for (const e of signed) if (!e.rustdeskNode?.rustdeskId || !e.rustdeskNode.agentSecretHash) throw new Error(`${e.name} has no enrolled identity`);

  const depots = [byName('HARB-DEPOT-BOI'), byName('HARB-DEPOT-SPO')];
  const gatehouse = byName('HARB-GATEHOUSE');
  const excluded = byName('HARB-WAREHOUSE-2');
  // The running company-wide revision was made while the gatehouse was excluded.
  const companyNow = signed.filter((e) => !depots.includes(e) && e !== gatehouse);
  const companyNext = signed.filter((e) => !depots.includes(e));
  const leftOutOf = (inScope: (typeof eps)): LeftOut[] => inScope.flatMap((e): LeftOut[] => {
    if (!/windows/i.test(e.platform ?? '')) return [{ endpointId: e.id, hostname: host(e), code: 'not_windows', message: `not Windows (it reports "${(e.platform ?? '').slice(0, 40)}"); patch policies install Windows updates only.` }];
    if (e.updateChannel !== 'signed') return [{ endpointId: e.id, hostname: host(e), code: 'no_signed_agent', message: 'runs the standard agent, which only reports updates. Move it to the signed agent (Devices → Full agent).' }];
    return [];
  });
  const inheriting = eps.filter((e) => !depots.includes(e) && e !== excluded);

  const series = async (o: { scope: 'business' | 'assigned'; name: string; createdAgo: number; settings: Record<string, unknown> }) =>
    prisma.patchPolicySeries.create({ data: { tenantId: harbor.tenantId, customerId: harbor.id, scope: o.scope, name: o.name, settings: o.settings as Prisma.InputJsonValue, createdById: admin.id, createdAt: ago(o.createdAgo), lastRevision: 1 } });

  /** Revision 1, as the direct-mode signer admitted it: ACTIVE at once, its computers live. */
  const revision = async (s: { id: string; name: string; scope: 'business' | 'assigned'; settings: Record<string, unknown> }, members: (typeof eps), createdAgo: number, canaryId: string) => {
    const plan = planRings(members.map(cand), { preferredCanary: canaryId });
    if (!plan.ok) throw new Error(`planRings: ${plan.message}`);
    const byId = new Map(members.map((e) => [e.id, e]));
    const created = ago(createdAgo);
    const st = s.settings as { allow: PolicyDoc['allow']; soakHours: number; failureThreshold: number; window: PolicyDoc['window']; reboot: PolicyDoc['reboot']; expiresInDays: number };
    const expires = new Date(created.getTime() + st.expiresInDays * DAY);
    const doc: PolicyDoc = {
      schema: POLICY_SCHEMA, policyId: randomBytes(16).toString('hex'), name: s.name, businessId: harbor.id, businessName: harbor.name,
      rings: plan.rings.map((r) => r.map((id) => { const e = byId.get(id)!; return { endpointId: id, hostname: host(e), rustdeskId: e.rustdeskNode!.rustdeskId!, deviceSecretSha256: e.rustdeskNode!.agentSecretHash!, resultKey: resultKey(id) }; })),
      allow: st.allow, soakHours: st.soakHours, failureThreshold: st.failureThreshold, window: st.window, reboot: st.reboot,
      createdAt: created.toISOString(), expiresAt: expires.toISOString(),
      createdBy: { userId: admin.id, name: 'Morgan Reyes' },
      reason: revisionReason(s.name, s.scope, 1, 'initial', [], []),
    };
    const p = await prisma.patchPolicy.create({
      data: {
        id: doc.policyId, tenantId: harbor.tenantId, customerId: harbor.id, name: s.name, document: doc as unknown as Prisma.InputJsonValue, digest: policyDigest(doc),
        status: 'ACTIVE', approvalUrl: `https://approve.example.com/p/${doc.policyId}`, approvals: [] as unknown as Prisma.InputJsonValue,
        expiresAt: expires, createdById: admin.id, createdAt: created, seriesId: s.id, revision: 1,
      },
    });
    await prisma.patchPolicyComputer.createMany({ data: plan.rings.flatMap((r, ring) => r.map((endpointId) => ({ policyId: p.id, endpointId, customerId: harbor.id, ring, live: true, createdAt: created }))) });
    await prisma.patchPolicySeries.update({ where: { id: s.id }, data: { currentPolicyId: p.id } });
    return plan;
  };

  // ── The company-wide policy ─────────────────────────────────────────────
  const companySettings = {
    allow: { classifications: CLASSES }, soakHours: 24, failureThreshold: 0,
    window: { days: ['tue'], start: '22:00', end: '02:00', timezone: 'America/Los_Angeles' },
    reboot: 'if_required_in_window', expiresInDays: 30, canaryEndpointId: byName('HARB-DISPATCH-02').id,
    reason: 'Monthly Windows updates for every Harbor computer, canary first (CR-1190).',
  };
  const company = await series({ scope: 'business', name: COMPANY, createdAgo: 5 * DAY, settings: companySettings });
  await revision({ ...company, scope: 'business', settings: companySettings }, companyNow, 5 * DAY, byName('HARB-DISPATCH-02').id);
  const next = planRings(companyNext.map(cand), { preferredCanary: byName('HARB-DISPATCH-02').id, previousCanary: byName('HARB-DISPATCH-02').id });
  if (!next.ok) throw new Error(`planRings: ${next.message}`);
  await prisma.patchPolicySeries.update({
    where: { id: company.id },
    data: {
      settleFingerprint: createHash('sha256').update(next.rings.flat().join(',')).digest('hex'), settleSince: ago(4 * MIN),
      lastCheck: {
        at: ago(MIN).toISOString(), code: 'settling', message: 'The computers changed; the change is proposed once it has held for 10 minute(s).', until: new Date(NOW + 6 * MIN).toISOString(),
        members: next.rings.flat().length, rings: next.rings.map((r) => r.length), canary: next.canary, leftOut: [...leftOutOf(inheriting), ...next.leftOut], lastRingOnly: [], promotion: null,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // ── The assignable policy for the depots ────────────────────────────────
  const depotSettings = {
    allow: { classifications: CLASSES }, soakHours: 12, failureThreshold: 0,
    window: { days: ['sun'], start: '02:00', end: '05:00', timezone: 'America/Los_Angeles' },
    reboot: 'if_required_in_window', expiresInDays: 30,
    reason: 'The depots run the scanners until midnight on weekdays; patch them on Sunday morning instead.',
  };
  const depot = await series({ scope: 'assigned', name: DEPOTS, createdAgo: 5 * DAY + HOUR, settings: depotSettings });
  for (const e of depots) await prisma.endpoint.update({ where: { id: e.id }, data: { patchPolicyMode: 'policy', patchPolicySeriesId: depot.id } });
  const dplan = await revision({ ...depot, scope: 'assigned', settings: depotSettings }, depots, 5 * DAY + 50 * MIN, depots[0].id);
  await prisma.patchPolicySeries.update({
    where: { id: depot.id },
    data: { lastCheck: { at: ago(MIN).toISOString(), code: 'up_to_date', message: 'The running revision names exactly these computers.', members: 2, rings: dplan.rings.map((r) => r.length), canary: dplan.canary, leftOut: [], lastRingOnly: [], promotion: null } as unknown as Prisma.InputJsonValue },
  });
  await prisma.endpoint.update({ where: { id: excluded.id }, data: { patchPolicyMode: 'exclude' } });
  await prisma.patchPolicyRevisionClaim.create({ data: { customerId: harbor.id, at: ago(5 * DAY) } });

  // ── A Windows Update scan from the signed agent ─────────────────────────
  // What `patch-scan` reports (src/patching/posture.ts), so the Patches tab
  // offers updates to select. Unsigned (no `signed` block): it is shown, and
  // a scan without one never opens a later ring. KB numbers are illustrative.
  const guid = (seed: string) => { const h = createHash('sha256').update(`docs-update:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
  const upd = (kb: string, title: string, classification: string, className: string, severity: string | undefined, sizeMb: number, reboot = 0) => ({
    updateId: guid(kb), revision: 200, kb, title, classification, className, ...(severity ? { severity } : {}),
    downloaded: false, rebootBehavior: reboot, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: sizeMb * 1024 * 1024,
  });
  const updates = [
    upd('KB5070773', '2026-11 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5070773)', CLASSES[0], 'Security Updates', 'Critical', 812, 1),
    upd('KB5070112', '2026-11 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 (KB5070112)', CLASSES[0], 'Security Updates', 'Important', 74),
    upd('KB2267602', 'Security Intelligence Update for Microsoft Defender Antivirus (KB2267602)', CLASSES[2], 'Definition Updates', undefined, 92),
    upd('KB5070390', 'Windows Malicious Software Removal Tool x64 - v5.143 (KB5070390)', 'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83', 'Updates', undefined, 61),
  ];
  for (const [n, list] of [['HARB-DISPATCH-01', updates], ['HARB-DISPATCH-02', updates.slice(1)], ['HARB-GATEHOUSE', updates]] as const) {
    const scanned = ago(38 * MIN);
    await prisma.endpointInventory.updateMany({
      where: { endpointId: byName(n).id },
      data: {
        patchScannedAt: scanned,
        patchPosture: {
          schema: 'rem0te-patch-posture/1', scannedAt: scanned.toISOString(), updates: list, managers: [], autoUpdate: 'notify',
          reboot: { pending: false, sources: [] },
          history: [
            { updateId: guid('KB5068861'), revision: 200, kb: 'KB5068861', title: '2026-10 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5068861)', result: 'succeeded', operation: 'install', date: ago(27 * DAY).toISOString() },
            { updateId: guid('KB5068400'), revision: 200, kb: 'KB5068400', title: '2026-10 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 (KB5068400)', result: 'succeeded', operation: 'install', date: ago(27 * DAY).toISOString() },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ── Software: a 0.42 inventory with uninstall keys, and a small catalog ──
  // The demo inventory predates 0.41 (no uninstall keys), so nothing on the
  // Software tab could be removed. Each program gets the key, view and
  // removal kind the 0.42 collector reports; the agent decides again before
  // it removes anything. The catalog entries are global, typed in (no
  // manifest is fetched), with stand-in hashes.
  const keys: Record<string, { key: string; view: '64' | '32'; quiet: boolean; msi: boolean; kind: string }> = {
    'Microsoft 365 Apps for business - en-us': { key: 'O365BusinessRetail - en-us', view: '64', quiet: false, msi: false, kind: 'office' },
    'Google Chrome': { key: 'Google Chrome', view: '64', quiet: false, msi: false, kind: 'chromium' },
    '7-Zip 24.08 (x64)': { key: '7-Zip', view: '64', quiet: false, msi: false, kind: 'nsis' },
    'Adobe Acrobat Reader (64-bit)': { key: '{AC76BA86-1033-FF00-7760-BC15014EA700}', view: '64', quiet: false, msi: true, kind: 'msi' },
    'Zebra Setup Utilities': { key: 'Zebra Setup Utilities_is1', view: '32', quiet: false, msi: false, kind: 'inno' },
    'Microsoft Edge': { key: 'Microsoft Edge', view: '32', quiet: false, msi: false, kind: 'none' },
    'Microsoft Visual C++ 2015-2022 Redistributable (x64)': { key: '{6ba9fb5e-8366-4cc4-bf65-25fe9819b2fc}', view: '32', quiet: true, msi: false, kind: 'quiet' },
    'Notepad++ (64-bit x64)': { key: 'Notepad++', view: '64', quiet: false, msi: false, kind: 'nsis' },
    'RustDesk': { key: 'RustDesk', view: '64', quiet: false, msi: false, kind: 'none' },
    'Windows PC Health Check': { key: '{B1E7D0E6-6F87-4D0A-9F3C-4C1A5D6A2E10}', view: '64', quiet: false, msi: true, kind: 'msi' },
  };
  const inv = await prisma.endpointInventory.findUnique({ where: { endpointId: byName('HARB-DISPATCH-01').id }, select: { software: true } });
  if (Array.isArray(inv?.software)) {
    const sw = (inv.software as Record<string, unknown>[]).map((p) => ({ ...p, ...(keys[p.name as string] ?? {}) }));
    await prisma.endpointInventory.update({ where: { endpointId: byName('HARB-DISPATCH-01').id }, data: { software: sw as Prisma.InputJsonValue } });
  }
  await prisma.softwareCatalogEntry.deleteMany({ where: { notes: { startsWith: 'Docs demo' } } });
  for (const [packageId, name, publisher, version] of [
    ['Mozilla.Firefox', 'Mozilla Firefox', 'Mozilla', '133.0.3'],
    ['VideoLAN.VLC', 'VLC media player', 'VideoLAN', '3.0.21'],
    ['Zoom.Zoom', 'Zoom Workplace', 'Zoom Video Communications, Inc.', '6.2.10'],
  ] as const) {
    await prisma.softwareCatalogEntry.create({
      data: {
        scope: 'GLOBAL', packageId, name, publisher, version, installerSha256: createHash('sha256').update(`docs-installer:${packageId}`).digest('hex'),
        hashSource: 'ADMIN_PASTED', architecture: 'x64', detection: { kind: 'display_name', name, match: 'prefix', compare: 'gte', version },
        notes: 'Docs demo entry: the hash is a stand-in.', createdById: admin.id, updatedById: admin.id, createdAt: ago(9 * DAY),
      },
    });
  }

  // ── 0.46: automatic agent updates per computer and per business ─────────
  await prisma.endpoint.updateMany({ where: { agentAutoUpdate: { not: null } }, data: { agentAutoUpdate: null } });
  await prisma.endpoint.update({ where: { id: byName('HARB-DISPATCH-01').id }, data: { agentAutoUpdate: 'on' } });
  await prisma.endpoint.update({ where: { id: gatehouse.id }, data: { agentAutoUpdate: 'off' } });
  for (const [biz, mode] of [[harbor, 'ANY_TIME'], [northwind, 'OFF']] as const) {
    const row = await prisma.clientUpdatePolicy.findFirst({ where: { customerId: biz.id, siteId: null, groupId: null } });
    if (row) await prisma.clientUpdatePolicy.update({ where: { id: row.id }, data: { agentMode: mode } });
    else await prisma.clientUpdatePolicy.create({ data: { tenantId: biz.tenantId, customerId: biz.id, enabled: false, timeZone: 'America/Los_Angeles', windows: [], agentMode: mode } });
  }

  // ── 0.49: Confirm it is you ─────────────────────────────────────────────
  await prisma.confirmPolicy.deleteMany({});
  const relaxed = ['actions.direct', 'scripts.direct', 'software.catalog', 'agent.migrate', 'agent.autoupdate.computer', 'agent.autoupdate.business', 'patching.policy', 'patching.override'];
  await prisma.confirmPolicy.createMany({ data: relaxed.map((key) => ({ key, value: 'off', updatedById: admin.id })) });

  console.log('Roster demo data created:', {
    companyWide: { revision1: companyNow.map((e) => e.name), next: next.rings.flat().length, leftOut: leftOutOf(inheriting).length },
    depots: depots.map((e) => e.name), excluded: excluded.name, confirmOff: relaxed.length,
  });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
