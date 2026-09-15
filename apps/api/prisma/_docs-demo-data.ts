/**
 * Demo data for documentation screenshots. Runs ONLY against the throwaway
 * reboot_remote_docs database — it refuses to run anywhere else, because
 * everything here is fictional and must never reach a real deployment.
 *
 * Everything in here is deliberately unusable for a real session:
 *   - RustDesk IDs are synthetic and registered with no rendezvous server.
 *   - IPs come from 203.0.113.0/24 (TEST-NET-3, reserved for documentation).
 *   - Business names, domains and people are invented; e-mail lands on
 *     example.com, which RFC 2606 reserves.
 */
import { PrismaClient } from '@prisma/client';
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

type Machine = { name: string; online: boolean; ver: string | null; mins: number; os: 'Windows' | 'macOS' | 'Linux' };

/**
 * Device counts differ per business on purpose: a screenshot where every
 * customer has exactly three computers reads as placeholder data.
 */
const BUSINESSES: {
  name: string; code: string; city: string; state: string;
  owner: [string, string]; tech: [string, string]; machines: Machine[];
}[] = [
  {
    name: 'Northwind Dental', code: 'NWD', city: 'Portland', state: 'OR',
    owner: ['Dana', 'Whitfield'], tech: ['Sam', 'Rivera'],
    machines: [
      { name: 'NWD-RECEPTION-01', online: true,  ver: '1.4.9', mins: 1,    os: 'Windows' },
      { name: 'NWD-FRONTDESK-02', online: true,  ver: '1.4.9', mins: 3,    os: 'Windows' },
      { name: 'NWD-OPERATORY-03', online: true,  ver: '1.4.6', mins: 12,   os: 'Windows' },
      { name: 'NWD-XRAY-WS',      online: false, ver: '1.4.6', mins: 2880, os: 'Windows' },
      { name: 'NWD-BACKOFFICE',   online: true,  ver: '1.4.9', mins: 6,    os: 'Windows' },
    ],
  },
  {
    name: 'Cascade Accounting', code: 'CASC', city: 'Seattle', state: 'WA',
    owner: ['Marcus', 'Bell'], tech: ['Priya', 'Nandakumar'],
    machines: [
      { name: 'CASC-PAYROLL-01', online: true,  ver: '1.4.9', mins: 2,     os: 'Windows' },
      { name: 'CASC-AUDIT-02',   online: true,  ver: '1.4.9', mins: 4,     os: 'Windows' },
      { name: 'CASC-PARTNER-MB', online: true,  ver: '1.4.9', mins: 9,     os: 'macOS'   },
      { name: 'CASC-FILESRV',    online: true,  ver: '1.4.6', mins: 1,     os: 'Linux'   },
      { name: 'CASC-RECEPTION',  online: false, ver: '1.4.2', mins: 10080, os: 'Windows' },
      { name: 'CASC-TAX-SEASON', online: false, ver: null,    mins: 43200, os: 'Windows' },
    ],
  },
  {
    name: 'Harbor Logistics', code: 'HARB', city: 'Tacoma', state: 'WA',
    owner: ['Yusuf', 'Okonkwo'], tech: ['Ellen', 'Vasquez'],
    machines: [
      { name: 'HARB-DISPATCH-01', online: true,  ver: '1.4.9', mins: 1,   os: 'Windows' },
      { name: 'HARB-DISPATCH-02', online: true,  ver: '1.4.9', mins: 1,   os: 'Windows' },
      { name: 'HARB-WAREHOUSE-1', online: true,  ver: '1.4.6', mins: 22,  os: 'Windows' },
      { name: 'HARB-WAREHOUSE-2', online: false, ver: '1.4.6', mins: 360, os: 'Windows' },
      { name: 'HARB-GATEHOUSE',   online: true,  ver: '1.4.9', mins: 5,   os: 'Windows' },
      { name: 'HARB-YARD-KIOSK',  online: true,  ver: '1.4.9', mins: 2,   os: 'Linux'   },
      { name: 'HARB-OPS-MB',      online: false, ver: '1.4.9', mins: 1440, os: 'macOS'  },
    ],
  },
  {
    name: 'Cedar Ridge Veterinary', code: 'CRV', city: 'Bend', state: 'OR',
    owner: ['Alice', 'Tran'], tech: ['Noah', 'Feldman'],
    machines: [
      { name: 'CRV-FRONT-01',  online: true,  ver: '1.4.9', mins: 2,    os: 'Windows' },
      { name: 'CRV-EXAM-02',   online: true,  ver: '1.4.9', mins: 7,    os: 'Windows' },
      { name: 'CRV-LAB-PC',    online: false, ver: '1.4.6', mins: 5760, os: 'Windows' },
    ],
  },
  {
    name: 'Puget Sound Legal', code: 'PSL', city: 'Olympia', state: 'WA',
    owner: ['Grace', 'Lindqvist'], tech: ['Omar', 'Haddad'],
    machines: [
      { name: 'PSL-PARALEGAL-1', online: true,  ver: '1.4.9', mins: 3,   os: 'Windows' },
      { name: 'PSL-PARALEGAL-2', online: true,  ver: '1.4.9', mins: 8,   os: 'Windows' },
      { name: 'PSL-DOCREVIEW',   online: true,  ver: '1.4.6', mins: 14,  os: 'Windows' },
      { name: 'PSL-PARTNER-MB',  online: false, ver: '1.4.9', mins: 720, os: 'macOS'   },
    ],
  },
  {
    name: 'Alder Creek Fabrication', code: 'ACF', city: 'Everett', state: 'WA',
    owner: ['Ruth', 'Delacroix'], tech: ['Tom', 'Bergstrom'],
    machines: [
      { name: 'ACF-SHOPFLOOR-1', online: true,  ver: '1.4.9', mins: 1,    os: 'Windows' },
      { name: 'ACF-CAD-WS',      online: true,  ver: '1.4.9', mins: 4,    os: 'Windows' },
      { name: 'ACF-ESTIMATING',  online: false, ver: '1.4.6', mins: 180,  os: 'Windows' },
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
];

const OS_VERSIONS: Record<Machine['os'], string> = {
  Windows: 'Microsoft Windows NT 10.0.26100.0',
  macOS: 'macOS 15.1 (24B83)',
  Linux: 'Ubuntu 24.04.1 LTS',
};

async function main() {
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) throw new Error('Run prisma/seed.ts first');
  const roles = await prisma.role.findMany({ where: { tenantId: tenant.id } });
  const ownerRole = roles.find((r) => /owner/i.test(r.name))!;
  const userRole = roles.find((r) => /user/i.test(r.name))!;

  const pwHash = await argon2.hash('DemoPassw0rd!', {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4,
  });
  let idx = 0;
  let sessionIdx = 0;

  for (const b of BUSINESSES) {
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id, name: b.name, code: b.code,
        city: b.city, state: b.state, country: 'US',
        email: `it@${b.code.toLowerCase()}.example.com`,
        phone: '555-0100',
        isActive: true, quickConnectEnabled: true,
      },
    });

    const owner = await prisma.user.create({
      data: {
        email: `owner@${b.code.toLowerCase()}.example.com`,
        passwordHash: pwHash, firstName: b.owner[0], lastName: b.owner[1],
        status: 'ACTIVE', jobTitle: 'IT Manager', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { userId: owner.id, tenantId: tenant.id, roleId: ownerRole.id, customerId: customer.id, isActive: true },
    });

    const tech = await prisma.user.create({
      data: {
        email: `tech@${b.code.toLowerCase()}.example.com`,
        passwordHash: pwHash, firstName: b.tech[0], lastName: b.tech[1],
        status: 'ACTIVE', jobTitle: 'Support Technician', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: {
        userId: tech.id, tenantId: tenant.id, roleId: userRole.id, customerId: customer.id,
        isActive: true, capabilities: ['computers.view', 'computers.connect', 'sessions.view'],
      },
    });

    // A third person with a deliberately narrower grant, so the access-management
    // screenshot shows capabilities actually differing between users.
    const viewer = await prisma.user.create({
      data: {
        email: `office@${b.code.toLowerCase()}.example.com`,
        passwordHash: pwHash, firstName: 'Jordan', lastName: 'Ashby',
        status: 'ACTIVE', jobTitle: 'Office Coordinator', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: {
        userId: viewer.id, tenantId: tenant.id, roleId: userRole.id, customerId: customer.id,
        isActive: true, capabilities: ['computers.view'],
      },
    });

    for (const m of b.machines) {
      idx += 1;
      const seen = new Date(Date.now() - m.mins * 60_000);
      const ep = await prisma.endpoint.create({
        data: {
          tenantId: tenant.id, customerId: customer.id,
          name: m.name, hostname: m.name.toLowerCase(), platform: m.os,
          osVersion: OS_VERSIONS[m.os],
          status: m.online ? 'ACTIVE' : 'OFFLINE',
          isManaged: true, isOnline: m.online, lastSeenAt: seen,
          ipAddress: `203.0.113.${(idx % 250) + 2}`,
        },
      });
      await prisma.rustdeskNode.create({
        data: {
          tenantId: tenant.id, endpointId: ep.id,
          // Synthetic, and never registered with any rendezvous server.
          rustdeskId: String(100000000 + idx * 7654321).slice(0, 9),
          hostname: m.name.toLowerCase(), platform: m.os, version: m.ver,
          lastSeenAt: seen, permanentPassword: encrypt('demo-' + randomBytes(9).toString('hex')),
        },
      });
      // Let the technician actually reach the machines, so My Computers is populated.
      await prisma.computerAccess.create({
        data: { tenantId: tenant.id, endpointId: ep.id, userId: tech.id, grantedBy: owner.id },
      });
    }

    const sessionCount = 2 + (BUSINESSES.indexOf(b) % 3);
    for (let s = 0; s < sessionCount; s++) {
      sessionIdx += 1;
      const started = new Date(Date.now() - (sessionIdx * 3600_000 + s * 900_000));
      await prisma.supportSession.create({
        data: {
          tenantId: tenant.id, customerId: customer.id, technicianId: tech.id,
          isAdHoc: false, status: 'SESSION_COMPLETED',
          issueDescription: ISSUES[sessionIdx % ISSUES.length],
          startedAt: started,
          completedAt: new Date(started.getTime() + (12 + s * 9) * 60_000),
          duration: (12 + s * 9) * 60,
        },
      });
    }
  }

  console.log('Demo data created:');
  console.log('  businesses:', await prisma.customer.count());
  console.log('  endpoints :', await prisma.endpoint.count());
  console.log('  users     :', await prisma.user.count());
  console.log('  sessions  :', await prisma.supportSession.count());
}

main().finally(() => prisma.$disconnect());
