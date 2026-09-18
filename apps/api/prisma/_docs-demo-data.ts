/**
 * Demo data for documentation screenshots. Runs ONLY against the throwaway
 * reboot_remote_docs database — it refuses to run anywhere else, because
 * everything here is fictional and must never reach a real deployment.
 *
 * Nothing in here can reach a real machine:
 *   - RustDesk IDs are synthetic and registered with no rendezvous server.
 *   - Endpoint passwords are random per run and never displayed by the UI.
 *   - Business names, people and domains are invented; mail lands on
 *     example.com, which RFC 2606 reserves.
 *
 * The one exception to "no real-world values" is `ipAddress`. The dashboard map
 * geolocates it, and reserved documentation ranges (198.51.100.0/24 and
 * friends) resolve to nothing, leaving the map empty. Each site below therefore
 * carries a public address chosen ONLY because the GeoIP database places it in
 * the intended city. They are office-egress addresses for businesses that do
 * not exist, identify no real device or customer, and are never connected to.
 */
import { PrismaClient, ActivityAction, SessionStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, createCipheriv, createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const encKey = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex');
function encrypt(text: string) {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/**
 * Hardware profiles for the inventory the agent would have collected.
 *
 * Seeded because the device page is mostly inventory now, and without it every
 * screenshot of it shows "Specs have not been collected yet" over rows of
 * dashes — a gallery advertising the feature as empty. Chosen to vary: a
 * workstation, two business laptops, a Mac, a Linux server, a near-full disk
 * and a machine waiting on a restart, so the usage bars and the amber states
 * appear at all.
 *
 * All fictional, like everything else here. Serials are obviously synthetic.
 */
type HwProfile = {
  manufacturer: string; model: string; chassisType: string;
  biosVersion: string; cpuModel: string; cpuCores: number; cpuThreads: number;
  cpuMhz: number; memoryTotalMb: number; memoryFreeMb: number;
  diskTotalGb: number; diskFreeGb: number;
  gpu: string; resolution: string;
  pendingUpdates: number; rebootRequired: boolean;
  user: string | null;
  uptimeSeconds: number;
};

const HW_PROFILES: HwProfile[] = [
  {
    manufacturer: 'Dell Inc.', model: 'OptiPlex 7090', chassisType: 'Mini Tower',
    biosVersion: '1.21.0', cpuModel: 'Intel(R) Core(TM) i7-11700 @ 2.50GHz',
    cpuCores: 8, cpuThreads: 16, cpuMhz: 2496, memoryTotalMb: 32768, memoryFreeMb: 18944,
    diskTotalGb: 953, diskFreeGb: 412, gpu: 'Intel(R) UHD Graphics 750', resolution: '2560x1440',
    pendingUpdates: 0, rebootRequired: false, user: 'a.patel', uptimeSeconds: 4 * 86400 + 7 * 3600,
  },
  {
    manufacturer: 'LENOVO', model: 'ThinkPad T14 Gen 3', chassisType: 'Notebook',
    biosVersion: 'N3AET82W (1.62)', cpuModel: 'Intel(R) Core(TM) i5-1245U @ 1.60GHz',
    cpuCores: 10, cpuThreads: 12, cpuMhz: 1600, memoryTotalMb: 16384, memoryFreeMb: 5120,
    diskTotalGb: 476, diskFreeGb: 38, gpu: 'Intel(R) Iris(R) Xe Graphics', resolution: '1920x1200',
    pendingUpdates: 7, rebootRequired: true, user: 'j.okafor', uptimeSeconds: 19 * 86400,
  },
  {
    manufacturer: 'HP', model: 'EliteBook 840 G9', chassisType: 'Notebook',
    biosVersion: 'U70 Ver. 01.12.01', cpuModel: 'Intel(R) Core(TM) i7-1265U @ 1.80GHz',
    cpuCores: 10, cpuThreads: 12, cpuMhz: 1800, memoryTotalMb: 16384, memoryFreeMb: 9216,
    diskTotalGb: 476, diskFreeGb: 201, gpu: 'Intel(R) Iris(R) Xe Graphics', resolution: '1920x1080',
    pendingUpdates: 2, rebootRequired: false, user: null, uptimeSeconds: 6 * 3600 + 40 * 60,
  },
  {
    manufacturer: 'Apple Inc.', model: 'MacBook Pro (14-inch, M2 Pro)', chassisType: 'Notebook',
    biosVersion: '10151.61.4', cpuModel: 'Apple M2 Pro',
    cpuCores: 10, cpuThreads: 10, cpuMhz: 3504, memoryTotalMb: 16384, memoryFreeMb: 4608,
    diskTotalGb: 994, diskFreeGb: 612, gpu: 'Apple M2 Pro (16-core GPU)', resolution: '3024x1964',
    pendingUpdates: 1, rebootRequired: false, user: 'r.castellanos', uptimeSeconds: 2 * 86400 + 3 * 3600,
  },
  {
    manufacturer: 'Supermicro', model: 'SYS-510P-M', chassisType: 'Rack Mount',
    biosVersion: '1.4b', cpuModel: 'Intel(R) Xeon(R) Silver 4310 @ 2.10GHz',
    cpuCores: 12, cpuThreads: 24, cpuMhz: 2100, memoryTotalMb: 65536, memoryFreeMb: 41984,
    diskTotalGb: 1863, diskFreeGb: 1204, gpu: 'ASPEED Graphics Family', resolution: '1024x768',
    pendingUpdates: 0, rebootRequired: false, user: null, uptimeSeconds: 141 * 86400,
  },
  {
    manufacturer: 'Dell Inc.', model: 'Latitude 5540', chassisType: 'Notebook',
    biosVersion: '1.9.2', cpuModel: 'Intel(R) Core(TM) i5-1345U @ 1.60GHz',
    cpuCores: 10, cpuThreads: 12, cpuMhz: 1600, memoryTotalMb: 16384, memoryFreeMb: 7424,
    diskTotalGb: 476, diskFreeGb: 22, gpu: 'Intel(R) Iris(R) Xe Graphics', resolution: '1920x1080',
    pendingUpdates: 12, rebootRequired: false, user: 's.whitfield', uptimeSeconds: 31 * 86400,
  },
];

/**
 * Sample System-log entries. Real Windows event IDs and providers with
 * plausible messages — an event log full of invented ids would look wrong to
 * anyone who reads these for a living.
 */
const DEMO_EVENTS: { id: number; level: number; provider: string; message: string }[] = [
  { id: 7000, level: 2, provider: 'Service Control Manager',
    message: 'The Print Spooler service failed to start due to the following error: The service did not respond to the start or control request in a timely fashion.' },
  { id: 41, level: 1, provider: 'Microsoft-Windows-Kernel-Power',
    message: 'The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.' },
  { id: 7031, level: 2, provider: 'Service Control Manager',
    message: 'The Windows Update service terminated unexpectedly. It has done this 2 time(s). The following corrective action will be taken in 60000 milliseconds: Restart the service.' },
  { id: 1014, level: 3, provider: 'Microsoft-Windows-DNS-Client',
    message: 'Name resolution for the name update.internal.example.com timed out after none of the configured DNS servers responded.' },
  { id: 129, level: 3, provider: 'storahci',
    message: 'Reset to device, \\Device\\RaidPort0, was issued.' },
  { id: 6008, level: 2, provider: 'EventLog',
    message: 'The previous system shutdown at 3:42:11 AM was unexpected.' },
  { id: 219, level: 3, provider: 'Microsoft-Windows-Kernel-PnP',
    message: 'The driver \\Driver\\WudfRd failed to load for the device USB\\VID_0BDA&PID_8153.' },
  { id: 10016, level: 3, provider: 'Microsoft-Windows-DistributedCOM',
    message: 'The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID {2593F8B9-4EAF-457C-B68A-50F6B8EA6B54}.' },
  { id: 36874, level: 2, provider: 'Schannel',
    message: 'An TLS 1.3 connection request was received from a remote client application, but none of the cipher suites supported by the client application are supported by the server.' },
  { id: 1001, level: 3, provider: 'Microsoft-Windows-WER-SystemErrorReporting',
    message: 'The computer has rebooted from a bugcheck. The bugcheck was: 0x0000009f (0x0000000000000003).' },
];

/** Plausible pending-update titles, drawn on in order. */
const UPDATE_TITLES: { title: string; kb: string; severity: string; sizeBytes: number }[] = [
  { title: '2026-09 Cumulative Update for Windows 10 Version 22H2 for x64-based Systems', kb: 'KB5041580', severity: 'Important', sizeBytes: 812_000_000 },
  { title: 'Security Intelligence Update for Microsoft Defender Antivirus', kb: 'KB2267602', severity: 'Critical', sizeBytes: 118_000_000 },
  { title: '2026-09 .NET Framework 3.5 and 4.8.1 Cumulative Update for Windows 10 Version 22H2', kb: 'KB5041938', severity: 'Important', sizeBytes: 74_600_000 },
  { title: 'Windows Malicious Software Removal Tool x64 — September 2026', kb: 'KB890830', severity: 'Moderate', sizeBytes: 62_300_000 },
  { title: 'Intel Corporation — System — 10.1.19.4 driver update', kb: '', severity: 'Low', sizeBytes: 3_900_000 },
  { title: '2026-08 Servicing Stack Update for Windows 10 Version 22H2 for x64-based Systems', kb: 'KB5041948', severity: 'Important', sizeBytes: 15_400_000 },
  { title: 'Realtek Semiconductor Corp. — Audio — 6.0.9612.1 driver update', kb: '', severity: 'Low', sizeBytes: 11_200_000 },
  { title: '2026-09 Update for Windows 10 Version 22H2 for x64-based Systems', kb: 'KB5042099', severity: 'Moderate', sizeBytes: 28_700_000 },
  { title: 'Microsoft Edge — Stable Channel Update 129.0.2792.52', kb: '', severity: 'Important', sizeBytes: 168_000_000 },
  { title: 'NVIDIA — Display — 32.0.15.6094 driver update', kb: '', severity: 'Low', sizeBytes: 421_000_000 },
  { title: '2026-07 Cumulative Update Preview for .NET Framework 4.8.1', kb: 'KB5041082', severity: 'Low', sizeBytes: 48_100_000 },
  { title: 'Windows Security platform definition update', kb: 'KB5007651', severity: 'Moderate', sizeBytes: 9_800_000 },
];
const ago = (ms: number) => new Date(Date.now() - ms);

type OS = 'Windows' | 'macOS' | 'Linux';
type Machine = {
  name: string; online: boolean; ver: string | null; mins: number; os: OS;
  /** Remote worker or branch site — geolocates away from the head office. */
  ip?: string;
};

const OS_VERSIONS: Record<OS, string> = {
  Windows: 'Microsoft Windows NT 10.0.26100.0',
  macOS: 'macOS 15.1 (24B83)',
  Linux: 'Ubuntu 24.04.1 LTS',
};

/**
 * The friendlier OS strings the inventory pass collects.
 *
 * `osVersion` above is what the heartbeat reports — a raw
 * `OSVersion.VersionString`. The inventory collects `Win32_OperatingSystem`'s
 * caption and build separately, which is why the device page can show
 * "Windows 11 Pro / 26100" where the endpoint list shows the NT string.
 */
const OS_CAPTIONS: Record<OS, string> = {
  Windows: 'Microsoft Windows 11 Pro',
  macOS: 'macOS Sequoia 15.1',
  Linux: 'Ubuntu 24.04.1 LTS',
};

const OS_BUILDS: Record<OS, string> = {
  Windows: '26100',
  macOS: '24B83',
  Linux: '6.8.0-45-generic',
};

/**
 * The agent version the demo machines report.
 *
 * Read from version.json rather than hardcoded: the Overview tab compares the
 * reported agent against this server's version and flags a mismatch, so a
 * literal here would make every screenshot show the whole demo estate running
 * an outdated agent one release after it was written.
 */
const DEMO_AGENT_VERSION: string = (() => {
  try {
    const file = process.env.VERSION_FILE
      ?? path.join(__dirname, '..', '..', '..', 'version.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** Verified against the deployed GeoIP database; each places in the named city. */
const REMOTE = {
  boise: '168.225.185.124',
  denver: '134.5.102.86',
  spokane: '76.121.35.117',
  eugene: '73.67.160.81',
};

const BUSINESSES: {
  name: string; code: string; city: string; state: string; ip: string;
  owner: [string, string]; tech: [string, string]; machines: Machine[];
}[] = [
  {
    name: 'Northwind Dental', code: 'NWD', city: 'Portland', state: 'OR',
    ip: '184.41.65.179', owner: ['Dana', 'Whitfield'], tech: ['Sam', 'Rivera'],
    machines: [
      { name: 'NWD-RECEPTION-01', online: true,  ver: '1.4.9', mins: 1,    os: 'Windows' },
      { name: 'NWD-FRONTDESK-02', online: true,  ver: '1.4.9', mins: 3,    os: 'Windows' },
      { name: 'NWD-OPERATORY-03', online: true,  ver: '1.4.6', mins: 12,   os: 'Windows' },
      { name: 'NWD-XRAY-WS',      online: false, ver: '1.4.6', mins: 2880, os: 'Windows' },
      { name: 'NWD-BACKOFFICE',   online: true,  ver: '1.4.9', mins: 6,    os: 'Windows' },
      { name: 'NWD-BILLING-RMT',  online: true,  ver: '1.4.9', mins: 18,   os: 'Windows', ip: REMOTE.eugene },
    ],
  },
  {
    name: 'Cascade Accounting', code: 'CASC', city: 'Seattle', state: 'WA',
    ip: '56.173.218.124', owner: ['Marcus', 'Bell'], tech: ['Priya', 'Nandakumar'],
    machines: [
      { name: 'CASC-PAYROLL-01', online: true,  ver: '1.4.9', mins: 2,     os: 'Windows' },
      { name: 'CASC-AUDIT-02',   online: true,  ver: '1.4.9', mins: 4,     os: 'Windows' },
      { name: 'CASC-PARTNER-MB', online: true,  ver: '1.4.9', mins: 9,     os: 'macOS'   },
      { name: 'CASC-FILESRV',    online: true,  ver: '1.4.6', mins: 1,     os: 'Linux'   },
      { name: 'CASC-RECEPTION',  online: false, ver: '1.4.2', mins: 10080, os: 'Windows' },
      { name: 'CASC-TAX-SEASON', online: false, ver: null,    mins: 43200, os: 'Windows' },
      { name: 'CASC-CPA-REMOTE', online: true,  ver: '1.4.9', mins: 25,    os: 'macOS',   ip: REMOTE.denver },
    ],
  },
  {
    name: 'Harbor Logistics', code: 'HARB', city: 'Tacoma', state: 'WA',
    ip: '99.92.21.167', owner: ['Yusuf', 'Okonkwo'], tech: ['Ellen', 'Vasquez'],
    machines: [
      { name: 'HARB-DISPATCH-01', online: true,  ver: '1.4.9', mins: 1,    os: 'Windows' },
      { name: 'HARB-DISPATCH-02', online: true,  ver: '1.4.9', mins: 1,    os: 'Windows' },
      { name: 'HARB-WAREHOUSE-1', online: true,  ver: '1.4.6', mins: 22,   os: 'Windows' },
      { name: 'HARB-WAREHOUSE-2', online: false, ver: '1.4.6', mins: 360,  os: 'Windows' },
      { name: 'HARB-GATEHOUSE',   online: true,  ver: '1.4.9', mins: 5,    os: 'Windows' },
      { name: 'HARB-YARD-KIOSK',  online: true,  ver: '1.4.9', mins: 2,    os: 'Linux'   },
      { name: 'HARB-OPS-MB',      online: false, ver: '1.4.9', mins: 1440, os: 'macOS'   },
      { name: 'HARB-DEPOT-BOI',   online: true,  ver: '1.4.9', mins: 8,    os: 'Windows', ip: REMOTE.boise },
      { name: 'HARB-DEPOT-SPO',   online: true,  ver: '1.4.6', mins: 40,   os: 'Windows', ip: REMOTE.spokane },
    ],
  },
  {
    name: 'Cedar Ridge Veterinary', code: 'CRV', city: 'Bend', state: 'OR',
    ip: '69.128.60.131', owner: ['Alice', 'Tran'], tech: ['Noah', 'Feldman'],
    machines: [
      { name: 'CRV-FRONT-01',  online: true,  ver: '1.4.9', mins: 2,    os: 'Windows' },
      { name: 'CRV-EXAM-02',   online: true,  ver: '1.4.9', mins: 7,    os: 'Windows' },
      { name: 'CRV-LAB-PC',    online: false, ver: '1.4.6', mins: 5760, os: 'Windows' },
    ],
  },
  {
    name: 'Puget Sound Legal', code: 'PSL', city: 'Olympia', state: 'WA',
    ip: '168.156.157.53', owner: ['Grace', 'Lindqvist'], tech: ['Omar', 'Haddad'],
    machines: [
      { name: 'PSL-PARALEGAL-1', online: true,  ver: '1.4.9', mins: 3,   os: 'Windows' },
      { name: 'PSL-PARALEGAL-2', online: true,  ver: '1.4.9', mins: 8,   os: 'Windows' },
      { name: 'PSL-DOCREVIEW',   online: true,  ver: '1.4.6', mins: 14,  os: 'Windows' },
      { name: 'PSL-PARTNER-MB',  online: false, ver: '1.4.9', mins: 720, os: 'macOS'   },
    ],
  },
  {
    name: 'Alder Creek Fabrication', code: 'ACF', city: 'Everett', state: 'WA',
    ip: '76.135.254.231', owner: ['Ruth', 'Delacroix'], tech: ['Tom', 'Bergstrom'],
    machines: [
      { name: 'ACF-SHOPFLOOR-1', online: true,  ver: '1.4.9', mins: 1,   os: 'Windows' },
      { name: 'ACF-CAD-WS',      online: true,  ver: '1.4.9', mins: 4,   os: 'Windows' },
      { name: 'ACF-ESTIMATING',  online: false, ver: '1.4.6', mins: 180, os: 'Windows' },
    ],
  },
];

const ISSUES = [
  'Printer not responding after driver update',
  'Slow login following the October patch',
  'Outlook profile repair',
  'Scanner not detected on the shared workstation',
  'Mapped drive missing after reboot',
  'Practice software will not launch',
  'Two-factor reset for a new phone',
  'Label printer queue stuck',
  'Statement export failing at month end',
  'Shared mailbox not syncing',
  'Dictation software licence re-activation',
  'Backup agent reporting a stale snapshot',
];

async function main() {
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) throw new Error('Run prisma/seed.ts first');
  const roles = await prisma.role.findMany({ where: { tenantId: tenant.id } });
  const ownerRole = roles.find((r) => /owner/i.test(r.name))!;
  const userRole = roles.find((r) => /user/i.test(r.name))!;

  const pwHash = await argon2.hash('DemoPassw0rd!', {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4,
  });

  const activity: {
    customerId: string | null; actorId: string | null; action: ActivityAction;
    resource?: string; resourceId?: string; actorIp?: string; createdAt: Date;
    metadata?: Record<string, unknown>;
  }[] = [];

  let idx = 0, sessionIdx = 0;

  for (let bi = 0; bi < BUSINESSES.length; bi++) {
    const b = BUSINESSES[bi];
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id, name: b.name, code: b.code,
        city: b.city, state: b.state, country: 'US',
        email: `it@${b.code.toLowerCase()}.example.com`, phone: '555-0100',
        isActive: true, quickConnectEnabled: true,
        // Staggered so the Created column does not read as seeded-at-once.
        createdAt: ago([412, 300, 255, 180, 96, 34][bi] * DAY),
      },
    });
    activity.push({
      customerId: customer.id, actorId: null, action: ActivityAction.BUSINESS_CREATED,
      resource: 'Customer', resourceId: customer.id, createdAt: ago([412, 300, 255, 180, 96, 34][bi] * DAY),
    });

    const owner = await prisma.user.create({
      data: {
        email: `owner@${b.code.toLowerCase()}.example.com`, passwordHash: pwHash,
        firstName: b.owner[0], lastName: b.owner[1], status: 'ACTIVE',
        jobTitle: 'IT Manager', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { userId: owner.id, tenantId: tenant.id, roleId: ownerRole.id, customerId: customer.id, isActive: true },
    });

    const tech = await prisma.user.create({
      data: {
        email: `tech@${b.code.toLowerCase()}.example.com`, passwordHash: pwHash,
        firstName: b.tech[0], lastName: b.tech[1], status: 'ACTIVE',
        jobTitle: 'Support Technician', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: {
        userId: tech.id, tenantId: tenant.id, roleId: userRole.id, customerId: customer.id,
        isActive: true,
        capabilities: ['computers.view', 'computers.connect', 'sessions.view', 'support.quick_connect'],
      },
    });

    // A third person with a deliberately narrower grant, so the access screens
    // show capabilities actually differing between people.
    const viewer = await prisma.user.create({
      data: {
        email: `office@${b.code.toLowerCase()}.example.com`, passwordHash: pwHash,
        firstName: 'Jordan', lastName: 'Ashby', status: 'ACTIVE',
        jobTitle: 'Office Coordinator', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: {
        userId: viewer.id, tenantId: tenant.id, roleId: userRole.id, customerId: customer.id,
        isActive: true, capabilities: ['computers.view'],
      },
    });

    const endpoints: { id: string; name: string }[] = [];
    for (const m of b.machines) {
      idx += 1;
      const seen = ago(m.mins * MIN);
      const ep = await prisma.endpoint.create({
        data: {
          tenantId: tenant.id, customerId: customer.id,
          name: m.name, hostname: m.name.toLowerCase(), platform: m.os,
          osVersion: OS_VERSIONS[m.os],
          // ACTIVE is the enrolment lifecycle, not connectivity: the API never
          // writes EndpointStatus.OFFLINE, and the dashboard counts ACTIVE rows
          // and derives "offline" from isOnline. Marking a disconnected machine
          // OFFLINE hides it from the totals entirely.
          status: 'ACTIVE',
          isManaged: true, isOnline: m.online, lastSeenAt: seen,
          // Matches version.json, or the Overview tab flags every demo machine
          // as running an outdated agent beside the specs it just collected.
          agentVersion: DEMO_AGENT_VERSION,
          ipAddress: m.ip ?? b.ip,
          createdAt: ago((40 + idx * 3) * DAY),
        },
      });
      endpoints.push({ id: ep.id, name: ep.name });
      await prisma.rustdeskNode.create({
        data: {
          tenantId: tenant.id, endpointId: ep.id,
          rustdeskId: String(100000000 + idx * 7654321).slice(0, 9),
          hostname: m.name.toLowerCase(), platform: m.os, version: m.ver,
          lastSeenAt: seen, permanentPassword: encrypt('demo-' + randomBytes(9).toString('hex')),
          // Bound, like a machine whose installer has actually run.
          //
          // Without this the device page showed "This computer cannot report
          // its specs yet — it enrolled before per-device secrets existed"
          // directly above a full set of collected specs: a contradiction, and
          // a state production cannot reach, because inventory is only ever
          // written for a heartbeat that authenticated. The hash is of a
          // random value that is then thrown away — no demo machine can
          // authenticate anywhere, and nothing here is reachable.
          agentSecretHash: createHash('sha256')
            .update(randomBytes(32).toString('base64url')).digest('hex'),
          agentSecretSetAt: ago((40 + idx * 3) * DAY),
        },
      });
      await prisma.computerAccess.create({
        data: { tenantId: tenant.id, endpointId: ep.id, userId: tech.id, grantedBy: owner.id },
      });

      // A deliberate cross-business collision on "reception-pc".
      //
      // Two customers each having a machine the front desk calls RECEPTION-PC
      // is not a contrived example, it is most MSPs — and it is the case the
      // Tactical RMM resolver exists to refuse to guess at. Seeded as an alias
      // rather than by renaming machines, so it changes no counts, no display
      // names and nothing the offline set is keyed on.
      if (/-RECEPTION/.test(m.name)) {
        await prisma.endpointAlias.create({
          data: { endpointId: ep.id, alias: 'reception-pc' },
        });
      }

      // A completed event-log query, so the Event Log tab has something to
      // show. The tab falls back to the last stored query for the machine, so
      // this is what a technician returning to the page would see.
      // Every online Windows machine, not a sample: the capture script picks
      // whichever online endpoint it finds first, so seeding a subset meant
      // the Event Log screenshot landed on a machine with no stored query and
      // photographed an empty form.
      if (m.online && m.os === 'Windows') {
        await prisma.endpointCommand.create({
          data: {
            endpointId: ep.id, tenantId: tenant.id, customerId: customer.id,
            type: 'EVENT_LOG_QUERY', status: 'SUCCEEDED',
            requestedById: tech.id,
            params: { logName: 'System', levels: [1, 2, 3], maxEvents: 50, sinceHours: 24, providerName: null },
            result: { events: DEMO_EVENTS.map((e, i) => ({
              timeCreated: ago((18 + idx * 7 + i * 47) * MIN).toISOString(),
              eventId: e.id, level: e.level,
              levelName: e.level === 1 ? 'Critical' : e.level === 2 ? 'Error' : e.level === 3 ? 'Warning' : 'Information',
              provider: e.provider, message: e.message,
            })) },
            createdAt: ago(26 * MIN), dispatchedAt: ago(24 * MIN), completedAt: ago(23 * MIN),
            dispatchCount: 1,
            expiresAt: ago(-4 * MIN),
          },
        });
      }

      // The inventory the agent would have reported. Only for machines that
      // are online or were recently: an endpoint that has been dark for days
      // having freshly-collected specs is the kind of detail that makes a
      // screenshot quietly wrong.
      if (m.mins < 6 * 60) {
        const hw = HW_PROFILES[idx % HW_PROFILES.length];
        const gb = (n: number) => n * 1024 * 1024 * 1024;
        const pending = UPDATE_TITLES.slice(0, hw.pendingUpdates).map((u) => ({
          title: u.title,
          kb: u.kb || null,
          severity: u.severity,
          sizeBytes: u.sizeBytes,
        }));
        await prisma.endpointInventory.create({
          data: {
            endpointId: ep.id,
            manufacturer: hw.manufacturer, model: hw.model, chassisType: hw.chassisType,
            // Synthetic, and obviously so.
            serialNumber: `DEMO-${String(idx).padStart(4, '0')}-${m.os.slice(0, 3).toUpperCase()}`,
            biosVersion: hw.biosVersion, biosDate: ago((900 + idx * 11) * DAY),
            osCaption: OS_CAPTIONS[m.os], osBuild: OS_BUILDS[m.os], osArch: '64-bit',
            osInstalledAt: ago((420 + idx * 9) * DAY),
            // Derived from the machine's own name prefix, which is the
            // business code. A fixed domain here put NORTHWIND\\ on a Cascade
            // Accounting machine — the kind of detail a reader spots
            // immediately and that makes a whole gallery look invented.
            domain: m.os === 'Windows'
              ? (idx % 3 === 0 ? 'WORKGROUP' : `${m.name.split('-')[0].toLowerCase()}.local`)
              : 'local',
            timezone: 'Pacific Standard Time',
            cpuModel: hw.cpuModel, cpuCores: hw.cpuCores,
            cpuThreads: hw.cpuThreads, cpuMhz: hw.cpuMhz,
            memoryTotalMb: hw.memoryTotalMb, memoryFreeMb: hw.memoryFreeMb,
            disks: [{
              drive: m.os === 'Windows' ? 'C:' : '/',
              label: m.os === 'Windows' ? 'OS' : 'root',
              fsType: m.os === 'Windows' ? 'NTFS' : m.os === 'macOS' ? 'APFS' : 'ext4',
              totalBytes: gb(hw.diskTotalGb), freeBytes: gb(hw.diskFreeGb),
            }],
            gpus: [{ name: hw.gpu, driverVersion: '31.0.101.4502', resolution: hw.resolution }],
            networks: [{
              name: m.os === 'Windows' ? 'Intel(R) Ethernet Connection I219-LM' : 'en0',
              mac: `00:1A:2B:${String(idx % 100).padStart(2, '0')}:C3:D4`,
              // Private ranges carry nothing and are left as themselves; the
              // masking pass only rewrites public addresses.
              ipv4: `192.168.${10 + (idx % 6)}.${20 + (idx % 60)}`,
              gateway: `192.168.${10 + (idx % 6)}.1`, dhcp: true,
            }],
            // Qualified with the machine's own business code, so the account
            // shown belongs to the company that owns the computer.
            // The live sample the Resources card reads. Without it that card
            // shows "Awaiting first sample" in every screenshot, which is the
            // same trap the inventory itself fell into before 0.16.0.
            cpuLoadPercent: m.online ? 6 + ((idx * 13) % 62) : null,
            systemDiskTotalMb: hw.diskTotalGb * 1024,
            systemDiskFreeMb: hw.diskFreeGb * 1024,
            liveSampledAt: ago((1 + (idx % 3)) * MIN),
            loggedOnUser: m.online && hw.user
              ? (m.os === 'Windows' ? `${m.name.split('-')[0]}\\${hw.user}` : hw.user)
              : null,
            lastBootAt: ago(hw.uptimeSeconds * 1000),
            uptimeSeconds: hw.uptimeSeconds,
            pendingUpdates: pending,
            pendingUpdateCount: pending.length,
            rebootRequired: hw.rebootRequired,
            updatesCheckedAt: ago((20 + (idx % 5) * 37) * MIN),
            collectedAt: ago((4 + (idx % 7) * 3) * MIN),
          },
        });
      }
      activity.push({
        customerId: customer.id, actorId: owner.id, action: ActivityAction.ENDPOINT_ENROLLED,
        resource: 'Endpoint', resourceId: ep.id, actorIp: b.ip,
        createdAt: ago((40 + idx * 3) * DAY), metadata: { name: m.name, platform: m.os },
      });
    }

    // ── Sessions, spread across 30 days so the 7d / 30d tiles differ ────────
    const completed = 6 + bi;
    for (let s = 0; s < completed; s++) {
      sessionIdx += 1;
      const target = endpoints[s % endpoints.length];
      // Weight recent days more heavily, but reach back past 7 days.
      const daysBack = s < 3 ? s * 0.6 : 2 + s * 2.4;
      const started = ago(daysBack * DAY + (s * 37) * MIN);
      const dur = (9 + ((s * 7) % 34)) * 60;
      await prisma.supportSession.create({
        data: {
          tenantId: tenant.id, customerId: customer.id, technicianId: tech.id,
          endpointId: target.id, isAdHoc: false, status: SessionStatus.SESSION_COMPLETED,
          issueDescription: ISSUES[sessionIdx % ISSUES.length],
          startedAt: started, completedAt: new Date(started.getTime() + dur * 1000),
          duration: dur, createdAt: started,
        },
      });
      activity.push({
        customerId: customer.id, actorId: tech.id, action: ActivityAction.SESSION_LAUNCHED,
        resource: 'Endpoint', resourceId: target.id, actorIp: b.ip,
        createdAt: started, metadata: { endpoint: target.name },
      });
      activity.push({
        customerId: customer.id, actorId: tech.id, action: ActivityAction.SESSION_COMPLETED,
        resource: 'Endpoint', resourceId: target.id, actorIp: b.ip,
        createdAt: new Date(started.getTime() + dur * 1000), metadata: { endpoint: target.name, seconds: dur },
      });
    }

    // A couple of Quick Connect (ad-hoc) sessions — no Endpoint row by design.
    if (bi % 2 === 0) {
      const started = ago((3 + bi) * HOUR);
      const dur = (11 + bi * 4) * 60;
      await prisma.supportSession.create({
        data: {
          tenantId: tenant.id, customerId: customer.id, technicianId: tech.id,
          isAdHoc: true, status: SessionStatus.SESSION_COMPLETED,
          issueDescription: 'Quick Connect — walk-in laptop, not an enrolled device',
          startedAt: started, completedAt: new Date(started.getTime() + dur * 1000),
          duration: dur, createdAt: started,
        },
      });
      activity.push({
        customerId: customer.id, actorId: tech.id, action: ActivityAction.QUICK_CONNECT_INITIATED,
        resource: 'SupportSession', actorIp: b.ip, createdAt: started,
      });
      activity.push({
        customerId: customer.id, actorId: tech.id, action: ActivityAction.QUICK_CONNECT_ENDED,
        resource: 'SupportSession', actorIp: b.ip,
        createdAt: new Date(started.getTime() + dur * 1000),
      });
    }

    // Sign-ins and everyday administration, so the audit timeline is not
    // nothing but sessions.
    activity.push(
      { customerId: customer.id, actorId: tech.id, action: ActivityAction.LOGIN_SUCCESS, actorIp: b.ip, createdAt: ago((2 + bi) * HOUR) },
      { customerId: customer.id, actorId: owner.id, action: ActivityAction.LOGIN_SUCCESS, actorIp: b.ip, createdAt: ago((5 + bi) * HOUR) },
      { customerId: customer.id, actorId: owner.id, action: ActivityAction.USER_CAPABILITIES_UPDATED, resource: 'User', resourceId: viewer.id, actorIp: b.ip, createdAt: ago((1 + bi) * DAY), metadata: { added: ['computers.view'] } },
      { customerId: customer.id, actorId: owner.id, action: ActivityAction.ENDPOINT_ACCESS_GRANTED, resource: 'User', resourceId: tech.id, actorIp: b.ip, createdAt: ago((2 + bi) * DAY) },
      { customerId: customer.id, actorId: tech.id, action: ActivityAction.ENDPOINT_PASSWORD_REVEALED, resource: 'Endpoint', resourceId: endpoints[0].id, actorIp: b.ip, createdAt: ago((6 + bi) * HOUR), metadata: { endpoint: endpoints[0].name } },
    );
  }

  // ── Enrolled but not yet assigned to a business ──────────────────────────
  // A real platform always has a couple of these: the installer ran, the
  // machine checked in, nobody has filed it yet. Without them the Unassigned
  // Computers screen is an empty table.
  const STRAYS = [
    { name: 'WS-NEW-0412', os: 'Windows' as OS, ver: '1.4.9', mins: 9,  ip: '184.41.65.179' },
    { name: 'MACBOOK-SETUP', os: 'macOS' as OS, ver: '1.4.9', mins: 47, ip: '56.173.218.124' },
  ];
  for (const m of STRAYS) {
    idx += 1;
    const seen = ago(m.mins * MIN);
    const ep = await prisma.endpoint.create({
      data: {
        tenantId: tenant.id, customerId: null,
        name: m.name, hostname: m.name.toLowerCase(), platform: m.os,
        osVersion: OS_VERSIONS[m.os], status: 'ACTIVE',
        isManaged: true, isOnline: true, lastSeenAt: seen,
        ipAddress: m.ip, createdAt: ago(2 * DAY),
      },
    });
    await prisma.rustdeskNode.create({
      data: {
        tenantId: tenant.id, endpointId: ep.id,
        rustdeskId: String(100000000 + idx * 7654321).slice(0, 9),
        hostname: m.name.toLowerCase(), platform: m.os, version: m.ver,
        lastSeenAt: seen, permanentPassword: encrypt('demo-' + randomBytes(9).toString('hex')),
      },
    });
  }

  // ── Live board: sessions in flight, so the dashboard tiles are not zeros ──
  const allEndpoints = await prisma.endpoint.findMany({ where: { isOnline: true }, take: 3 });
  const techs = await prisma.user.findMany({ where: { email: { startsWith: 'tech@' } }, take: 3 });
  const live: [SessionStatus, number][] = [
    [SessionStatus.SESSION_STARTED, 14], [SessionStatus.SESSION_STARTED, 6], [SessionStatus.PENDING, 2],
  ];
  for (let i = 0; i < live.length; i++) {
    const [status, mins] = live[i];
    const ep = allEndpoints[i], t = techs[i];
    if (!ep || !t) continue;
    await prisma.supportSession.create({
      data: {
        tenantId: tenant.id, customerId: ep.customerId, technicianId: t.id, endpointId: ep.id,
        isAdHoc: false, status,
        issueDescription: ['Workstation unresponsive after update', 'Cannot reach the shared drive', 'Awaiting user to accept the session'][i],
        startedAt: status === SessionStatus.PENDING ? null : ago(mins * MIN),
        createdAt: ago(mins * MIN),
      },
    });
  }

  await prisma.activityLog.createMany({
    data: activity.map((a) => ({
      tenantId: tenant.id, customerId: a.customerId, actorId: a.actorId,
      action: a.action, resource: a.resource, resourceId: a.resourceId,
      actorIp: a.actorIp, actorAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      metadata: a.metadata as never, createdAt: a.createdAt,
    })),
  });

  console.log('Demo data created:');
  console.log('  businesses:', await prisma.customer.count());
  console.log('  endpoints :', await prisma.endpoint.count());
  console.log('  users     :', await prisma.user.count());
  console.log('  sessions  :', await prisma.supportSession.count());
  console.log('  activity  :', await prisma.activityLog.count());
}

main().finally(() => prisma.$disconnect());
