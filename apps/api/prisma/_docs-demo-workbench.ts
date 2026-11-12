/**
 * Demo data for the pages added in 0.31–0.33, for documentation screenshots.
 * Runs ONLY against the throwaway reboot_remote_docs database, after
 * _docs-demo-data.ts and _docs-demo-monitoring.ts, and immediately before
 * _docs-demo-refresh.ts and a capture. Idempotent: it clears what it owns
 * first, so it can be re-run before every capture.
 *
 *   DATABASE_URL=…/reboot_remote_docs npx tsx prisma/_docs-demo-workbench.ts
 *
 * What it adds, and why each one exists:
 *   - metric history (raw samples for 24 h, hourly roll-ups for 30 days, disk
 *     passes every 6 h) for every online computer with inventory, so the
 *     Performance tab draws a series instead of "No samples yet". Plausible,
 *     synthetic shapes: a working-hours bump, noise, a slow disk climb, and one
 *     overnight gap on one computer, because a gap is a thing the chart shows.
 *   - completed Processes / Services / Network snapshots on the online Windows
 *     computers, stored through the same sanitiser and size cap as an agent's
 *     result (catalog.ts), so what is shown is exactly what the real path stores.
 *   - device groups and shared saved views.
 *   - a script library: an approved script, a second version in review, a
 *     business script in review and a draft. Hashes come from definition.ts.
 *   - a client-update policy for Harbor with a site override, and two
 *     policy-queued RustDesk updates being held (one by an open session).
 *   - (0.35) a device-group client-update policy and a group offline monitor
 *     on Harbor's Remote depots group, so the group-policy cards have a winner.
 *   - (0.36) no metric history or snapshots after NWD-BILLING-RMT's agent went
 *     silent; _docs-demo-refresh.ts keeps it reachable with an old heartbeat.
 *   - two patch policies: one awaiting its second approval, one active. The
 *     docs stack has no approval signer, so the pages say so — that is the
 *     truth about this stack, and the pre-flight lists it as unmet.
 *   - resolved alert history over 30 days, so the reports have periods to show.
 *   - the Linux and macOS computers report as the read-only agents do (lower
 *     case platform, package-manager update titles).
 *
 * Nothing here can reach anything: no signer, no destinations, no real hosts.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { hashVersion } from '../src/script-library/definition';
import { POLICY_SCHEMA, policyDigest, type PolicyDoc } from '../src/actions/patch-policy';
import { capResult, resultCapFor, sanitizeResult } from '../src/diagnostics-catalog/catalog';
import { rollup, hourStart } from '../src/metrics/metrics-math';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

/** Deterministic noise, so a re-run draws the same charts. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Pacific working hours, weekdays: when the people at these businesses are at their desks. */
function workLoad(t: number): number {
  const d = new Date(t - 8 * HOUR); // close enough to Pacific for a chart's shape
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  if (!weekday) return 0.1;
  if (h < 7 || h > 18.5) return 0.05;
  // Morning ramp, a lunch dip, an afternoon plateau.
  return h < 9 ? (h - 7) / 2 : h > 12 && h < 13 ? 0.6 : h > 17 ? (18.5 - h) / 1.5 : 1;
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { isPlatformAdmin: true }, orderBy: { createdAt: 'asc' } });
  const harbor = await prisma.customer.findFirst({ where: { name: 'Harbor Logistics' } });
  const northwind = await prisma.customer.findFirst({ where: { name: 'Northwind Dental' } });
  const cascade = await prisma.customer.findFirst({ where: { name: 'Cascade Accounting' } });
  if (!admin || !harbor || !northwind || !cascade) throw new Error('run _docs-demo-data.ts first');
  const site = await prisma.site.findFirst({ where: { customerId: harbor.id, name: 'Tacoma warehouse' } });
  if (!site) throw new Error('run _docs-demo-monitoring.ts first');
  const tech = async (code: string) => {
    const u = await prisma.user.findFirst({ where: { email: `tech@${code}.example.com` } });
    if (!u) throw new Error(`demo technician for ${code} missing`);
    return u;
  };
  const ellen = await tech('harb');
  const sam = await tech('nwd');
  const priya = await tech('casc');
  const ep = async (name: string) => {
    const e = await prisma.endpoint.findFirst({ where: { name }, include: { rustdeskNode: true } });
    if (!e) throw new Error(`demo computer ${name} missing`);
    return e;
  };

  // ── Clean slate for everything this script owns ─────────────────────────
  await prisma.endpointMetricSample.deleteMany({});
  await prisma.endpointMetricHourly.deleteMany({});
  await prisma.endpointDiskSample.deleteMany({});
  await prisma.diagnosticRun.deleteMany({ where: { key: { in: ['process_list', 'service_list', 'network_adapters'] } } });
  await prisma.savedView.deleteMany({});
  // Group policies first (0.35): a group carrying a policy cannot be deleted
  // (NO ACTION foreign keys), so these go before the groups.
  await prisma.clientUpdatePolicy.deleteMany({});
  await prisma.monitorRule.deleteMany({ where: { groupId: { not: null } } });
  // Membership is its own table from 0.34 (a computer can be in several groups).
  await prisma.endpointGroupMember.deleteMany({});
  await prisma.endpointGroup.deleteMany({});
  await prisma.scriptVersion.deleteMany({});
  await prisma.script.deleteMany({});
  await prisma.patchPolicy.deleteMany({});
  await prisma.monitorAlert.deleteMany({ where: { id: { startsWith: 'demohist' } } });
  await prisma.rustdeskNode.updateMany({
    data: { updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateRequestedById: null, updateHoldReason: null, updateHoldAt: null },
  });

  // ── The read-only agents: Linux and macOS report as they really do ──────
  // The POSIX agents send platform "linux" / "macos" and package-manager
  // update titles with no KB (linux-agent.ts, macos-agent.ts).
  const filesrv = await ep('CASC-FILESRV');
  await prisma.endpoint.update({ where: { id: filesrv.id }, data: { platform: 'linux', osVersion: 'Ubuntu 24.04.1 LTS' } });
  await prisma.endpointInventory.updateMany({
    where: { endpointId: filesrv.id },
    data: {
      pendingUpdates: [
        { title: 'openssl 3.0.13-0ubuntu3.4 (noble-security)', kb: null, severity: 'security', sizeBytes: null },
        { title: 'libssl3t64 3.0.13-0ubuntu3.4 (noble-security)', kb: null, severity: 'security', sizeBytes: null },
        { title: 'linux-image-generic 6.8.0-48.48 (noble-updates)', kb: null, severity: null, sizeBytes: null },
        { title: 'samba 2:4.19.5+dfsg-4ubuntu9.1 (noble-updates)', kb: null, severity: null, sizeBytes: null },
      ],
      pendingUpdateCount: 4, rebootRequired: true, updatesCheckedAt: ago(42 * MIN),
    },
  });
  const partnerMb = await ep('CASC-PARTNER-MB');
  await prisma.endpoint.update({ where: { id: partnerMb.id }, data: { platform: 'macos', osVersion: 'macOS 15.1 (24B83)' } });
  await prisma.endpointInventory.updateMany({
    where: { endpointId: partnerMb.id },
    data: {
      pendingUpdates: [
        { title: 'macOS Sequoia 15.1.1', kb: null, severity: 'recommended', sizeBytes: null },
        { title: 'Safari 18.1.1', kb: null, severity: null, sizeBytes: null },
      ],
      pendingUpdateCount: 2, rebootRequired: false, updatesCheckedAt: ago(3 * HOUR),
    },
  });

  // ── Metric history ──────────────────────────────────────────────────────
  const OFFLINE = new Set(['NWD-XRAY-WS', 'CASC-RECEPTION', 'CASC-TAX-SEASON', 'HARB-WAREHOUSE-2', 'HARB-WAREHOUSE-1',
    'HARB-YARD-KIOSK', 'HARB-OPS-MB', 'CRV-LAB-PC', 'PSL-PARTNER-MB', 'ACF-ESTIMATING']);
  const withInv = await prisma.endpoint.findMany({
    where: { inventory: { isNot: null } },
    select: { id: true, name: true, inventory: { select: { memoryTotalMb: true, memoryFreeMb: true, systemDiskTotalMb: true, systemDiskFreeMb: true, disks: true } } },
    orderBy: { name: 'asc' },
  });
  // 0.36: the agent-silent computer (_docs-demo-refresh.ts): reachable
  // through RustDesk, agent quiet for three days, so its history stops there
  // and it has no recent snapshots. Keep in step with the refresh.
  const AGENT_SILENT = new Set(['NWD-BILLING-RMT']);
  const SILENT_FOR = 3 * DAY + 2 * HOUR;
  let rawRows = 0, hourRows = 0, diskRows = 0;
  for (const [i, e] of withInv.entries()) {
    if (OFFLINE.has(e.name)) continue;
    const end = AGENT_SILENT.has(e.name) ? NOW - SILENT_FOR : NOW - MIN;
    const inv = e.inventory!;
    const rand = rng(1000 + i * 7919);
    const cpuBase = 4 + (i * 7) % 14;
    const cpuWork = 12 + (i * 11) % 30;
    const memNow = inv.memoryTotalMb && inv.memoryFreeMb !== null ? 100 * (1 - inv.memoryFreeMb / inv.memoryTotalMb) : 55;
    const diskNow = inv.systemDiskTotalMb && inv.systemDiskFreeMb !== null ? 100 * (1 - inv.systemDiskFreeMb / inv.systemDiskTotalMb) : 60;
    // The disk filled by a few points over the month; the near-full laptops faster.
    const diskClimb = diskNow > 90 ? 4.5 : 1.2 + (i % 4) * 0.4;
    // One computer was switched off overnight two days ago: the chart shows that as a gap.
    const gap = e.name === 'NWD-FRONTDESK-02' ? [NOW - 2 * DAY - 9 * HOUR, NOW - 2 * DAY - 3 * HOUR] : null;

    const samples: { at: number; cpu: number | null; memory: number | null; disk: number | null }[] = [];
    let spike = 0;
    for (let t = NOW - 30 * DAY; t <= end; t += 3 * MIN) {
      if (gap && t >= gap[0] && t < gap[1]) continue;
      const w = workLoad(t);
      if (spike <= 0 && rand() < 0.002) spike = 6 + Math.floor(rand() * 10); // a scan, an update, a big export
      const cpu = clamp(cpuBase + cpuWork * w + (rand() - 0.5) * 9 + (spike-- > 0 ? 45 : 0));
      const mem = clamp(memNow - 9 * (1 - w) + (rand() - 0.5) * 4, 5, 99);
      const disk = clamp(diskNow - diskClimb * ((NOW - t) / (30 * DAY)) + (rand() - 0.5) * 0.2, 1, 99.5);
      samples.push({ at: t, cpu: r1(cpu), memory: r1(mem), disk: r1(disk) });
    }
    const recent = samples.filter((s) => s.at >= NOW - 24 * HOUR);
    for (let k = 0; k < recent.length; k += 1000) {
      await prisma.endpointMetricSample.createMany({
        data: recent.slice(k, k + 1000).map((s) => ({ endpointId: e.id, at: new Date(s.at), cpu: s.cpu, memory: s.memory, disk: s.disk })),
      });
    }
    rawRows += recent.length;
    // Complete hours only: the current hour is computed from raw by the API.
    const current = hourStart(NOW);
    const hours = rollup(samples).filter((h) => h.hour < current);
    for (let k = 0; k < hours.length; k += 1000) {
      await prisma.endpointMetricHourly.createMany({
        data: hours.slice(k, k + 1000).map((h) => ({ ...h, endpointId: e.id, hour: new Date(h.hour) })),
      });
    }
    hourRows += hours.length;
    // Per-volume passes, every six hours, from the inventory's own volumes.
    const disks = (Array.isArray(inv.disks) ? inv.disks : []) as { drive?: string; totalBytes?: number; freeBytes?: number }[];
    const passes: Prisma.EndpointDiskSampleCreateManyInput[] = [];
    for (let t = NOW - 30 * DAY + 2 * HOUR; t <= end; t += 6 * HOUR) {
      if (gap && t >= gap[0] && t < gap[1]) continue;
      for (const d of disks) {
        if (!d.drive || !d.totalBytes || d.freeBytes === undefined) continue;
        const used = 100 * (1 - d.freeBytes / d.totalBytes);
        passes.push({ endpointId: e.id, at: new Date(t), drive: d.drive, used: r1(clamp(used - diskClimb * ((NOW - t) / (30 * DAY)), 1, 99.5)) });
      }
    }
    if (passes.length) await prisma.endpointDiskSample.createMany({ data: passes });
    diskRows += passes.length;
  }

  // ── Processes, services and network snapshots ───────────────────────────
  const windowsOnline = await prisma.endpoint.findMany({
    where: { platform: 'Windows', customerId: { not: null }, name: { notIn: [...OFFLINE, ...AGENT_SILENT] }, inventory: { isNot: null } },
    include: { inventory: true, customer: true },
  });
  const store = async (e: (typeof windowsOnline)[number], key: 'process_list' | 'service_list' | 'network_adapters', raw: unknown, mins: number, by: string) => {
    const clean = sanitizeResult(key, raw);
    if (!clean) throw new Error(`sanitizer refused ${key}`);
    const capped = capResult(clean, resultCapFor(key));
    await prisma.diagnosticRun.create({
      data: {
        endpointId: e.id, tenantId: e.tenantId, customerId: e.customerId, key, status: 'COMPLETED', requestedById: by,
        requestedAt: ago((mins + 3) * MIN), deliveredAt: ago((mins + 2) * MIN), startedAt: ago((mins + 2) * MIN), completedAt: ago(mins * MIN),
        expiresAt: ago((mins - 12) * MIN), dispatchCount: 1,
        result: capped.result as Prisma.InputJsonValue, resultBytes: capped.bytes, truncated: capped.truncated,
      },
    });
  };
  for (const [i, e] of windowsOnline.entries()) {
    const code = e.name.split('-')[0];
    const person = e.inventory?.loggedOnUser ?? null;
    const by = e.customerId === harbor.id ? ellen.id : e.customerId === northwind.id ? sam.id : e.customerId === cascade.id ? priya.id : admin.id;
    const rand = rng(77 + i * 131);
    const boot = NOW - (e.inventory?.uptimeSeconds ?? 86400) * 1000;
    const sys = 'NT AUTHORITY\\SYSTEM', ls = 'NT AUTHORITY\\LOCAL SERVICE', ns = 'NT AUTHORITY\\NETWORK SERVICE';
    const P: [string, string | null, number, number][] = [
      // name, user, cpu seconds, working set MB
      ['System', sys, 2410, 0.1], ['Registry', sys, 12, 62], ['smss.exe', sys, 0.4, 1.1], ['csrss.exe', sys, 38, 6.2],
      ['wininit.exe', sys, 0.8, 7.0], ['services.exe', sys, 160, 11.4], ['lsass.exe', sys, 214, 24.8], ['winlogon.exe', sys, 2.1, 12.3],
      ['fontdrvhost.exe', null, 1.4, 4.1], ['dwm.exe', null, 812, 118], ['svchost.exe', sys, 340, 28.5], ['svchost.exe', ns, 122, 19.2],
      ['svchost.exe', ls, 88, 22.4], ['svchost.exe', sys, 64, 41.7], ['svchost.exe', ls, 15, 9.8], ['svchost.exe', sys, 402, 61.3],
      ['MsMpEng.exe', sys, 1902, 236], ['NisSrv.exe', ls, 41, 9.1], ['SearchIndexer.exe', sys, 318, 46.5], ['spoolsv.exe', sys, 22, 14.2],
      ['WmiPrvSE.exe', ns, 54, 18.6], ['MpDefenderCoreService.exe', sys, 77, 31.0], ['rustdesk.exe', sys, 96, 38.4], ['powershell.exe', sys, 3.2, 74.1],
    ];
    if (person) {
      P.push(
        ['explorer.exe', person, 640, 164], ['msedge.exe', person, 1240, 312], ['msedge.exe', person, 410, 188], ['msedge.exe', person, 96, 74],
        ['OUTLOOK.EXE', person, 980, 288], ['ms-teams.exe', person, 1510, 402], ['OneDrive.exe', person, 140, 96], ['SearchHost.exe', person, 64, 142],
        ['StartMenuExperienceHost.exe', person, 22, 71], ['RuntimeBroker.exe', person, 9, 24], ['ShellExperienceHost.exe', person, 14, 58],
        ['ctfmon.exe', person, 4.1, 16], ['taskhostw.exe', person, 6.4, 19],
      );
      if (code === 'HARB') P.push(['ZebraDesigner.exe', person, 212, 148], ['EXCEL.EXE', person, 330, 196]);
      if (code === 'NWD') P.push(['Dentrix.exe', person, 940, 410], ['XrayBridge.exe', person, 48, 66]);
      if (code === 'CASC') P.push(['QBW.EXE', person, 1220, 520], ['EXCEL.EXE', person, 540, 244]);
    }
    // The Print Spooler on HARB-DISPATCH-01 is stopped: that is the open
    // alert _docs-demo-monitoring.ts raised, and the Processes, Services and
    // Alerts pages must all agree — so no spoolsv.exe on that one.
    const spoolerStopped = e.name === 'HARB-DISPATCH-01';
    if (spoolerStopped) P.splice(P.findIndex(([n]) => n === 'spoolsv.exe'), 1);
    let pid = 4;
    const processes = P.map(([name, user, cpu, ws]) => {
      pid += 4 + Math.floor(rand() * 900) * 4;
      return {
        name, pid: name === 'System' ? 4 : pid, cpuSeconds: r1(cpu * (0.7 + rand() * 0.6)), workingSetBytes: Math.round(ws * (0.85 + rand() * 0.3) * 1048576),
        user, startedAt: new Date(user === person && person ? NOW - (2 + rand() * 6) * HOUR : boot + rand() * 40_000).toISOString(),
      };
    });
    await store(e, 'process_list', { processCount: processes.length, userNamesRead: true, processes }, 6 + (i % 5), by);

    const S: [string, string, string, string, string | null][] = [
      ['AudioEndpointBuilder', 'Windows Audio Endpoint Builder', 'Running', 'Automatic', 'LocalSystem'],
      ['Audiosrv', 'Windows Audio', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['BFE', 'Base Filtering Engine', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['BITS', 'Background Intelligent Transfer Service', 'Stopped', 'Manual', 'LocalSystem'],
      ['BrokerInfrastructure', 'Background Tasks Infrastructure Service', 'Running', 'Automatic', 'LocalSystem'],
      ['CryptSvc', 'Cryptographic Services', 'Running', 'Automatic', 'NT AUTHORITY\\NetworkService'],
      ['DcomLaunch', 'DCOM Server Process Launcher', 'Running', 'Automatic', 'LocalSystem'],
      ['Dhcp', 'DHCP Client', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['DiagTrack', 'Connected User Experiences and Telemetry', 'Running', 'Automatic', 'LocalSystem'],
      ['Dnscache', 'DNS Client', 'Running', 'Automatic', 'NT AUTHORITY\\NetworkService'],
      ['DPS', 'Diagnostic Policy Service', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['EventLog', 'Windows Event Log', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['FontCache', 'Windows Font Cache Service', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['gpsvc', 'Group Policy Client', 'Running', 'Automatic', 'LocalSystem'],
      ['LanmanServer', 'Server', 'Running', 'Automatic', 'LocalSystem'],
      ['LanmanWorkstation', 'Workstation', 'Running', 'Automatic', 'NT AUTHORITY\\NetworkService'],
      ['MpsSvc', 'Windows Defender Firewall', 'Running', 'Automatic', 'NT AUTHORITY\\LocalService'],
      ['msiserver', 'Windows Installer', 'Stopped', 'Manual', 'LocalSystem'],
      ['Netlogon', 'Netlogon', 'Stopped', 'Manual', 'LocalSystem'],
      ['NlaSvc', 'Network Location Awareness', 'Running', 'Automatic', 'NT AUTHORITY\\NetworkService'],
      ['RemoteRegistry', 'Remote Registry', 'Stopped', 'Disabled', 'NT AUTHORITY\\LocalService'],
      ['RpcSs', 'Remote Procedure Call (RPC)', 'Running', 'Automatic', 'NT AUTHORITY\\NetworkService'],
      ['RustDesk', 'RustDesk Service', 'Running', 'Automatic', 'LocalSystem'],
      ['Schedule', 'Task Scheduler', 'Running', 'Automatic', 'LocalSystem'],
      ['SecurityHealthService', 'Windows Security Service', 'Running', 'Manual', 'LocalSystem'],
      ['SENS', 'System Event Notification Service', 'Running', 'Automatic', 'LocalSystem'],
      ['Spooler', 'Print Spooler', spoolerStopped ? 'Stopped' : 'Running', 'Automatic', 'LocalSystem'],
      ['SysMain', 'SysMain', 'Running', 'Automatic', 'LocalSystem'],
      ['Themes', 'Themes', 'Running', 'Automatic', 'LocalSystem'],
      ['TrustedInstaller', 'Windows Modules Installer', 'Stopped', 'Manual', 'LocalSystem'],
      ['UsoSvc', 'Update Orchestrator Service', 'Running', 'AutomaticDelayedStart', 'LocalSystem'],
      ['W32Time', 'Windows Time', 'Running', 'Manual', 'NT AUTHORITY\\LocalService'],
      ['WinDefend', 'Microsoft Defender Antivirus Service', 'Running', 'Automatic', 'LocalSystem'],
      ['WinRM', 'Windows Remote Management (WS-Management)', 'Stopped', 'Manual', 'NT AUTHORITY\\NetworkService'],
      ['Winmgmt', 'Windows Management Instrumentation', 'Running', 'Automatic', 'LocalSystem'],
      ['WlanSvc', 'WLAN AutoConfig', 'Running', 'Automatic', 'LocalSystem'],
      ['wscsvc', 'Security Center', 'Running', 'AutomaticDelayedStart', 'NT AUTHORITY\\LocalService'],
      ['WSearch', 'Windows Search', 'Running', 'AutomaticDelayedStart', 'LocalSystem'],
      ['wuauserv', 'Windows Update', 'Running', 'Manual', 'LocalSystem'],
      ['XblGameSave', 'Xbox Live Game Save', 'Stopped', 'Disabled', 'LocalSystem'],
    ];
    if (code === 'HARB') S.push(['ZebraPrintSvc', 'Zebra Print Monitor', 'Running', 'Automatic', 'LocalSystem']);
    if (code === 'NWD') S.push(['DtxImaging', 'Dentrix Imaging Bridge', 'Running', 'Automatic', `.\\svc-imaging`]);
    const services = S.map(([name, displayName, state, startMode, account]) => ({ name, displayName, state, startMode, account }))
      .sort((a, b) => a.name.localeCompare(b.name));
    await store(e, 'service_list', { serviceCount: services.length, services }, 7 + (i % 4), by);

    const net = (e.inventory?.networks as { name?: string; mac?: string; ipv4?: string; gateway?: string }[] | null)?.[0];
    const lease = NOW - (3 + (i % 5)) * HOUR;
    const adapters = [
      {
        name: net?.name ?? 'Intel(R) Ethernet Connection I219-LM', connectionId: 'Ethernet', status: 'Up', up: true,
        mac: net?.mac ?? '00:1A:2B:00:C3:D4', speedBps: 1_000_000_000,
        ipv4: [net?.ipv4 ?? '192.168.10.20'], ipv6: [`fe80::${(0x1a2b + i).toString(16)}:${(0x3c00 + i * 7).toString(16)}:fe4d:${(0x5e00 + i).toString(16)}%12`],
        gateway: [net?.gateway ?? '192.168.10.1'], dnsServers: [net?.gateway ?? '192.168.10.1', '1.1.1.1'],
        dnsSuffix: `${code.toLowerCase()}.local`, dhcpEnabled: true, dhcpServer: net?.gateway ?? '192.168.10.1',
        dhcpLeaseObtainedAt: new Date(lease).toISOString(), dhcpLeaseExpiresAt: new Date(lease + 8 * DAY).toISOString(),
      },
      {
        name: 'Intel(R) Wi-Fi 6E AX211 160MHz', connectionId: 'Wi-Fi', status: 'Disconnected', up: false,
        mac: `8C:17:59:${String(10 + (i % 80)).padStart(2, '0')}:4E:21`, speedBps: 0,
        ipv4: [], ipv6: [], gateway: [], dnsServers: [], dnsSuffix: null, dhcpEnabled: true, dhcpServer: null,
        dhcpLeaseObtainedAt: null, dhcpLeaseExpiresAt: null,
      },
      {
        name: 'Bluetooth Device (Personal Area Network)', connectionId: 'Bluetooth Network Connection', status: 'Disconnected', up: false,
        mac: `8C:17:59:${String(10 + (i % 80)).padStart(2, '0')}:4E:25`, speedBps: 3_000_000,
        ipv4: [], ipv6: [], gateway: [], dnsServers: [], dnsSuffix: null, dhcpEnabled: true, dhcpServer: null,
        dhcpLeaseObtainedAt: null, dhcpLeaseExpiresAt: null,
      },
    ];
    await store(e, 'network_adapters', { adapters }, 8 + (i % 3), by);
  }

  // ── Device groups ───────────────────────────────────────────────────────
  const groups: [string, string, string, string[]][] = [
    [harbor.id, 'Dispatch desks', 'Front-office dispatch workstations; restart only after 18:00.', ['HARB-DISPATCH-01', 'HARB-DISPATCH-02']],
    [harbor.id, 'Remote depots', 'Boise and Spokane depot PCs, on the depot VPN.', ['HARB-DEPOT-BOI', 'HARB-DEPOT-SPO']],
    [harbor.id, 'Warehouse floor', 'Shared floor PCs and the yard kiosk.', ['HARB-WAREHOUSE-1', 'HARB-WAREHOUSE-2', 'HARB-YARD-KIOSK']],
    [northwind.id, 'Clinical', 'Operatory and imaging workstations.', ['NWD-OPERATORY-03', 'NWD-XRAY-WS']],
    [northwind.id, 'Front office', 'Reception, front desk and billing.', ['NWD-RECEPTION-01', 'NWD-FRONTDESK-02', 'NWD-BILLING-RMT']],
  ];
  const groupIds: Record<string, string> = {};
  for (const [customerId, name, description, members] of groups) {
    const g = await prisma.endpointGroup.create({ data: { tenantId: harbor.tenantId, customerId, name, description, createdById: admin.id } });
    groupIds[name] = g.id;
    const eps = await prisma.endpoint.findMany({ where: { name: { in: members } }, select: { id: true } });
    await prisma.endpointGroupMember.createMany({ data: eps.map((e) => ({ endpointGroupId: g.id, endpointId: e.id, addedById: admin.id })) });
  }

  // ── Shared saved views ──────────────────────────────────────────────────
  const views: [string, string, Record<string, unknown>, string[], string, string, string][] = [
    [harbor.id, 'Harbor — offline', { businessId: harbor.id, online: 'offline' }, [], 'lastSeen', 'desc', 'comfortable'],
    [harbor.id, 'Dispatch desks', { businessId: harbor.id, groupId: groupIds['Dispatch desks'] }, [], 'name', 'asc', 'comfortable'],
    [harbor.id, 'Restart pending', { businessId: harbor.id, restartPending: 'true' }, [], 'patches', 'desc', 'compact'],
    [northwind.id, 'Northwind — needs patches', { businessId: northwind.id }, [], 'patches', 'desc', 'comfortable'],
    [cascade.id, 'Cascade — open alerts', { businessId: cascade.id, alerts: 'any' }, [], 'alerts', 'desc', 'comfortable'],
  ];
  for (const [customerId, name, filters, columns, sortField, sortDir, density] of views) {
    await prisma.savedView.create({
      data: { tenantId: harbor.tenantId, customerId, userId: admin.id, shared: true, name, resource: 'devices', filters: filters as Prisma.InputJsonValue, columns, sortField, sortDir, density },
    });
  }

  // ── Script library ──────────────────────────────────────────────────────
  // A second operator, so a version can be authored by one person and
  // reviewed by another, as the library requires.
  const reviewer = await prisma.user.upsert({
    where: { email: 'morgan.reyes@rem0te.example.com' },
    update: {},
    create: {
      email: 'morgan.reyes@rem0te.example.com', firstName: 'Morgan', lastName: 'Reyes', status: 'ACTIVE', isPlatformAdmin: true,
      jobTitle: 'Service desk lead', emailVerifiedAt: new Date(),
      // Cannot sign in: a hash of a value nobody keeps.
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$' + randomBytes(16).toString('base64').replace(/=+$/, '') + '$' + randomBytes(32).toString('base64').replace(/=+$/, ''),
    },
  });
  const CLEAR_QUEUE_V1 = [
    '# Clear a stuck print queue: stop the spooler, remove queued jobs, start it again.',
    "Stop-Service -Name 'Spooler' -Force",
    "Get-ChildItem -Path \"$env:SystemRoot\\System32\\spool\\PRINTERS\" -File | Remove-Item -Force",
    "Start-Service -Name 'Spooler'",
    "Get-Service -Name 'Spooler' | Select-Object Name, Status",
    '',
  ].join('\n');
  const CLEAR_QUEUE_V2 = [
    '# Clear a stuck print queue: stop the spooler, remove queued jobs, start it again.',
    'param([int]$WaitSeconds = 10)',
    "Stop-Service -Name 'Spooler' -Force",
    "(Get-Service -Name 'Spooler').WaitForStatus('Stopped', [TimeSpan]::FromSeconds($WaitSeconds))",
    "Get-ChildItem -Path \"$env:SystemRoot\\System32\\spool\\PRINTERS\" -File | Remove-Item -Force",
    "Start-Service -Name 'Spooler'",
    "Get-Service -Name 'Spooler' | Select-Object Name, Status",
    '',
  ].join('\n');
  const LABEL = [
    '# Restart the Zebra print monitor and report the label printers it sees.',
    "Restart-Service -Name 'ZebraPrintSvc'",
    "Get-Printer | Where-Object { $_.DriverName -like 'ZDesigner*' } | Select-Object Name, PrinterStatus, PortName",
    '',
  ].join('\n');
  const DISK = [
    '# Report the largest folders under a path, for a disk-space ticket.',
    'param([string]$Path = \'C:\\\', [int]$Top = 15)',
    'Get-ChildItem -Path $Path -Directory -ErrorAction SilentlyContinue |',
    '  ForEach-Object { [pscustomobject]@{ Folder = $_.FullName; GB = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB), 2) } } |',
    '  Sort-Object GB -Descending | Select-Object -First $Top',
    '',
  ].join('\n');
  const mkVersion = (content: string, risk: 'low' | 'medium' | 'high', parameters: unknown[], description: string) => {
    const h = hashVersion({ language: 'powershell', targetOs: 'windows', risk, parameters: parameters as never, content });
    return { description, language: 'powershell', targetOs: 'windows', risk, parameters: parameters as Prisma.InputJsonValue, content, ...h };
  };
  // Versions are written as drafts and moved through review, as the service
  // does: the 0035 trigger refuses any other order, and that is the point.
  type Review = { submittedAt: Date; decided?: { by: string; at: Date; note: string; approve: boolean } };
  const writeVersion = async (data: Prisma.ScriptVersionUncheckedCreateInput, review?: Review) => {
    const v = await prisma.scriptVersion.create({ data });
    if (!review) return v;
    await prisma.scriptVersion.update({ where: { id: v.id }, data: { status: 'IN_REVIEW', submittedAt: review.submittedAt } });
    if (!review.decided) return v;
    const d = review.decided;
    return prisma.scriptVersion.update({
      where: { id: v.id },
      data: { status: d.approve ? 'APPROVED' : 'REJECTED', decidedById: d.by, decidedAt: d.at, decisionNote: d.note, approvedSha256: d.approve ? v.contentSha256 : null },
    });
  };
  const q1 = await prisma.script.create({ data: { scope: 'GLOBAL', name: 'Clear stuck print queue', createdById: admin.id, createdAt: ago(21 * DAY) } });
  const q1v1 = mkVersion(CLEAR_QUEUE_V1, 'medium', [], 'Stops the Print Spooler, deletes queued jobs and starts it again. Prints in progress are lost.');
  const v1 = await writeVersion({ scriptId: q1.id, version: 1, ...q1v1, authorId: admin.id, contributorIds: [admin.id], createdAt: ago(21 * DAY) },
    { submittedAt: ago(21 * DAY), decided: { by: reviewer.id, at: ago(20 * DAY), note: 'Checked on a test PC; queue cleared.', approve: true } });
  const q1v2 = mkVersion(CLEAR_QUEUE_V2, 'medium', [{ name: 'WaitSeconds', type: 'integer', description: 'How long to wait for the spooler to stop', required: false, min: 1, max: 60 }],
    'Stops the Print Spooler, waits for it to stop, deletes queued jobs and starts it again. Prints in progress are lost.');
  await writeVersion({ scriptId: q1.id, version: 2, basedOnId: v1.id, ...q1v2, authorId: ellen.id, contributorIds: [ellen.id], createdAt: ago(2 * HOUR) },
    { submittedAt: ago(100 * MIN) });
  const lbl = await prisma.script.create({ data: { scope: 'BUSINESS', tenantId: harbor.tenantId, customerId: harbor.id, name: 'Restart label printer service', createdById: ellen.id, createdAt: ago(3 * DAY) } });
  await writeVersion({ scriptId: lbl.id, version: 1, ...mkVersion(LABEL, 'low', [], 'Restarts the Zebra print monitor on a dispatch desk and lists the label printers it can see.'),
    authorId: ellen.id, contributorIds: [ellen.id], createdAt: ago(3 * DAY) }, { submittedAt: ago(3 * DAY - HOUR) });
  const dsk = await prisma.script.create({ data: { scope: 'GLOBAL', name: 'Largest folders report', createdById: admin.id, createdAt: ago(5 * HOUR) } });
  await writeVersion({ scriptId: dsk.id, version: 1,
      ...mkVersion(DISK, 'low', [
        { name: 'Path', type: 'string', description: 'Folder to measure', required: false, charset: 'safe_text', maxLength: 120 },
        { name: 'Top', type: 'integer', description: 'How many folders to list', required: false, min: 1, max: 50 },
      ], 'Lists the largest folders under a path, for a disk-space ticket. Reads only.'),
    authorId: admin.id, contributorIds: [admin.id], createdAt: ago(5 * HOUR) });

  // ── Client-update policy ────────────────────────────────────────────────
  await prisma.clientUpdatePolicy.create({
    data: {
      tenantId: harbor.tenantId, customerId: harbor.id, enabled: true, timeZone: 'America/Los_Angeles',
      windows: [{ days: [1, 2, 3, 4, 5], start: '19:00', end: '23:00' }, { days: [6], start: '08:00', end: '12:00' }],
      skipActiveSession: true, skipLoggedOnUser: false, updatedById: admin.id,
    },
  });
  await prisma.clientUpdatePolicy.create({
    data: {
      tenantId: harbor.tenantId, customerId: harbor.id, siteId: site.id, enabled: true, timeZone: 'America/Los_Angeles',
      windows: [{ days: [0], start: '02:00', end: '05:00' }],
      skipActiveSession: true, skipLoggedOnUser: true, updatedById: admin.id,
    },
  });
  // 0.35 group policies: the Remote depots group updates overnight every day
  // (the depot VPN is quiet then), and has its own offline monitor, because
  // the VPN drops for half an hour most days. Each beats the business's own
  // setting for the two depot PCs, which the pages show as the winner.
  await prisma.clientUpdatePolicy.create({
    data: {
      tenantId: harbor.tenantId, customerId: harbor.id, groupId: groupIds['Remote depots'], priority: 10, enabled: true, timeZone: 'America/Los_Angeles',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '04:00' }], skipActiveSession: true, skipLoggedOnUser: false, updatedById: admin.id,
    },
  });
  await prisma.monitorRule.create({
    data: {
      scopeKey: `g:${groupIds['Remote depots']}`, customerId: harbor.id, groupId: groupIds['Remote depots'], priority: 10,
      key: 'offline', kind: 'OFFLINE', name: 'Depot offline (60 min: the depot VPN drops)', severity: 'WARNING', params: { minutes: 60 }, createdById: admin.id,
    },
  });
  await prisma.clientUpdatePolicy.create({
    data: {
      tenantId: northwind.tenantId, customerId: northwind.id, enabled: false, timeZone: 'America/Los_Angeles',
      windows: [{ days: [2, 4], start: '20:00', end: '22:00' }], skipActiveSession: true, skipLoggedOnUser: true, updatedById: admin.id,
    },
  });
  // Pin the RustDesk target, so the page does not depend on GitHub answering
  // during a capture (and the version shown does not move between runs).
  // Quick Connect on, so its page shows the form rather than "turned off".
  const platform = { rustdeskPinnedVersion: '1.4.9', quickConnectEnabled: true };
  await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: platform, create: { id: 'singleton', ...platform } });
  // A relay host, so the technician-client downloads are offered rather than
  // disabled. The same fictional host and key screenshots.mjs uses for its own
  // captures, so the gallery and the guide agree; neither reaches anything.
  await prisma.tenantSettings.updateMany({
    data: { rustdeskRelayHost: 'remote.example.net', rustdeskRelayPort: 21116, rustdeskPublicKey: 'YmFzZTY0ZXhhbXBsZWtleWZvcmRvY3Nvbmx5bm90cmVhbA=' },
  });
  // Two RustDesk updates the Harbor policy queued, each held for a reason that
  // does not depend on the time of the capture.
  const held: [string, string][] = [['HARB-WAREHOUSE-1', 'user_logged_on'], ['HARB-DEPOT-SPO', 'session_open']];
  for (const [name, reason] of held) {
    const e = await ep(name);
    await prisma.rustdeskNode.updateMany({
      where: { endpointId: e.id },
      data: { updateRequestedAt: ago(26 * HOUR), updateTargetVersion: '1.4.9', updateRequestSource: 'POLICY', updateHoldReason: reason, updateHoldAt: ago(12 * MIN) },
    });
  }

  // ── Patch policies ──────────────────────────────────────────────────────
  // The rings name computers on the signed agent channel, as a real policy
  // must. The signer is not part of the docs stack, so the pages report it as
  // unreachable — true here, and the pre-flight lists what is missing.
  const ringNames = [['HARB-DISPATCH-02'], ['HARB-DISPATCH-01', 'HARB-GATEHOUSE'], ['HARB-DEPOT-BOI', 'HARB-DEPOT-SPO']];
  await prisma.endpoint.updateMany({ where: { name: { in: ringNames.flat() } }, data: { updateChannel: 'signed' } });
  const policy = async (name: string, rings: string[][], status: 'AWAITING_APPROVAL' | 'ACTIVE', createdAgo: number, approvals: { name: string; role: string; at: string }[]) => {
    const docRings: PolicyDoc['rings'] = [];
    for (const ring of rings) {
      const out: PolicyDoc['rings'][number] = [];
      for (const n of ring) {
        const e = await ep(n);
        out.push({ endpointId: e.id, hostname: (e.hostname ?? e.name).slice(0, 64), rustdeskId: e.rustdeskNode!.rustdeskId!, deviceSecretSha256: e.rustdeskNode!.agentSecretHash! });
      }
      docRings.push(out);
    }
    const created = ago(createdAgo);
    const expires = new Date(created.getTime() + 30 * DAY);
    const doc: PolicyDoc = {
      schema: POLICY_SCHEMA, policyId: randomBytes(16).toString('hex'), name, businessId: harbor.id, businessName: harbor.name,
      rings: docRings,
      allow: { classifications: ['0fa1201d-4330-4fa8-8ae9-b877473b6441', 'e6cf1350-c01b-414d-a61f-263d14d133b4'], severities: ['Critical', 'Important'], excludeKbs: ['KB5041580'] },
      soakHours: 24, failureThreshold: 0,
      window: { days: ['tue', 'wed', 'thu'], start: '20:00', end: '23:30', timezone: 'America/Los_Angeles' },
      reboot: 'never', createdAt: created.toISOString(), expiresAt: expires.toISOString(),
      createdBy: { userId: admin.id, name: 'Platform Admin' },
      reason: 'Monthly security updates for Harbor, canary first, no restarts (CR-1142).',
    };
    await prisma.patchPolicy.create({
      data: {
        id: doc.policyId, tenantId: harbor.tenantId, customerId: harbor.id, name, document: doc as unknown as Prisma.InputJsonValue, digest: policyDigest(doc),
        status, approvalUrl: `https://approve.example.com/p/${doc.policyId}`, approvals: approvals as Prisma.InputJsonValue,
        expiresAt: expires, createdById: admin.id, createdAt: created,
      },
    });
  };
  await policy('Harbor security updates — dispatch and depots', ringNames, 'ACTIVE', 6 * DAY, [
    { name: 'Morgan Reyes', role: 'approver', at: ago(6 * DAY - 2 * HOUR).toISOString() },
    { name: 'Yusuf Okonkwo', role: 'customer', at: ago(6 * DAY - 5 * HOUR).toISOString() },
  ]);
  await policy('Harbor security updates — December', ringNames, 'AWAITING_APPROVAL', 3 * HOUR, [
    { name: 'Morgan Reyes', role: 'approver', at: ago(2 * HOUR).toISOString() },
  ]);

  // ── Alert history for the reports ───────────────────────────────────────
  // Resolved alerts over the last 30 days: offline episodes (some cleared by
  // the computer reconnecting, one closed by a person), full disks and a
  // pinned processor. Open alerts stay as _docs-demo-monitoring.ts left them.
  const hist: { name: string; kind: string; ruleKey: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; startAgo: number; mins: number; byPerson?: boolean }[] = [];
  const offliners = ['HARB-DEPOT-SPO', 'HARB-DEPOT-BOI', 'NWD-BILLING-RMT', 'CASC-CPA-REMOTE', 'HARB-WAREHOUSE-1', 'CRV-EXAM-02', 'PSL-DOCREVIEW', 'ACF-SHOPFLOOR-1'];
  for (const [i, n] of offliners.entries()) {
    const episodes = Math.max(1, 6 - i);
    for (let k = 0; k < episodes; k++) {
      hist.push({ name: n, kind: 'OFFLINE', ruleKey: 'offline', severity: 'WARNING', title: `${n} has been offline for 15 minutes`,
        startAgo: (2 + k * 4.7 + i * 0.9) * DAY + (i * 53 + k * 17) * MIN, mins: 20 + ((i * 37 + k * 61) % 220), byPerson: i === 4 && k === 0 });
    }
  }
  for (const [i, n] of ['HARB-DEPOT-SPO', 'NWD-OPERATORY-03', 'CASC-AUDIT-02'].entries()) {
    hist.push({ name: n, kind: 'DISK_FREE', ruleKey: 'disk-free', severity: 'WARNING', title: `${n}: C: has 8% free`, startAgo: (5 + i * 6) * DAY, mins: 600 + i * 300 });
  }
  for (const [i, n] of ['ACF-CAD-WS', 'ACF-CAD-WS', 'HARB-DISPATCH-02', 'CASC-PAYROLL-01'].entries()) {
    hist.push({ name: n, kind: 'CPU_HIGH', ruleKey: 'cpu-high', severity: 'INFO', title: `${n}: processor above 95% for 5 samples`, startAgo: (1 + i * 5.5) * DAY, mins: 18 + i * 9 });
  }
  for (const [i, h] of hist.entries()) {
    const e = await ep(h.name);
    const first = ago(h.startAgo), resolved = new Date(first.getTime() + h.mins * MIN);
    await prisma.monitorAlert.create({
      data: {
        id: `demohist${String(i).padStart(4, '0')}`, tenantId: e.tenantId, customerId: e.customerId, siteId: e.siteId, endpointId: e.id,
        ruleKey: h.ruleKey, kind: h.kind, dedupKey: `${h.ruleKey}:${e.id}`, severity: h.severity, state: 'RESOLVED', title: h.title,
        detail: h.kind === 'OFFLINE' ? { minutes: 15, lastSeenAt: new Date(first.getTime() - 15 * MIN).toISOString() } : {},
        firstSeenAt: first, lastSeenAt: resolved, notifyFrom: first, nextCheckAt: resolved,
        resolvedAt: resolved, resolvedById: h.byPerson ? admin.id : null,
        resolveNote: h.byPerson ? 'Depot closed for the holiday' : 'Cleared: the monitor reads normal again.',
        events: { create: [{ type: 'raised', detail: { rule: h.ruleKey, inheritedFrom: 'global' }, createdAt: first }, { type: 'resolved', createdAt: resolved }] },
      },
    });
  }

  console.log('Workbench demo data created:', {
    metricSamples: rawRows, metricHours: hourRows, diskSamples: diskRows,
    snapshots: await prisma.diagnosticRun.count({ where: { key: { in: ['process_list', 'service_list', 'network_adapters'] } } }),
    groups: await prisma.endpointGroup.count(), views: await prisma.savedView.count(),
    scripts: await prisma.script.count(), scriptVersions: await prisma.scriptVersion.count(),
    clientUpdatePolicies: await prisma.clientUpdatePolicy.count(), patchPolicies: await prisma.patchPolicy.count(),
    alertHistory: hist.length,
  });
}

main().finally(() => prisma.$disconnect());
