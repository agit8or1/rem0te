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
import { randomBytes, createCipheriv } from 'crypto';

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
        },
      });
      await prisma.computerAccess.create({
        data: { tenantId: tenant.id, endpointId: ep.id, userId: tech.id, grantedBy: owner.id },
      });
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
