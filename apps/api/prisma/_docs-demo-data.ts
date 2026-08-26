/**
 * Demo data for documentation screenshots. Runs ONLY against the throwaway
 * reboot_remote_docs database — it refuses to run anywhere else, because
 * everything here is fictional and must never reach a real deployment.
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

async function main() {
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) throw new Error('Run prisma/seed.ts first');
  const roles = await prisma.role.findMany({ where: { tenantId: tenant.id } });
  const ownerRole = roles.find((r) => /owner/i.test(r.name))!;
  const userRole = roles.find((r) => /user/i.test(r.name))!;

  const businesses = [
    { name: 'Northwind Dental', code: 'NWD', city: 'Portland', state: 'OR' },
    { name: 'Cascade Accounting', code: 'CASC', city: 'Seattle', state: 'WA' },
    { name: 'Harbor Logistics', code: 'HARB', city: 'Tacoma', state: 'WA' },
  ];

  const pwHash = await argon2.hash('DemoPassw0rd!', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
  let idx = 0;

  for (const b of businesses) {
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id, name: b.name, code: b.code,
        city: b.city, state: b.state, country: 'US',
        email: `it@${b.code.toLowerCase()}.example.com`,
        isActive: true, quickConnectEnabled: true,
      },
    });

    const owner = await prisma.user.create({
      data: {
        email: `owner@${b.code.toLowerCase()}.example.com`,
        passwordHash: pwHash, firstName: 'Dana', lastName: b.name.split(' ')[0],
        status: 'ACTIVE', jobTitle: 'IT Manager', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { userId: owner.id, tenantId: tenant.id, roleId: ownerRole.id, customerId: customer.id, isActive: true },
    });

    const tech = await prisma.user.create({
      data: {
        email: `tech@${b.code.toLowerCase()}.example.com`,
        passwordHash: pwHash, firstName: 'Sam', lastName: 'Rivera',
        status: 'ACTIVE', jobTitle: 'Support Technician', emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: {
        userId: tech.id, tenantId: tenant.id, roleId: userRole.id, customerId: customer.id,
        isActive: true, capabilities: ['computers.view', 'computers.connect', 'sessions.view'],
      },
    });

    // A believable mix: current, behind, never-reported, and offline.
    const machines = [
      { name: 'RECEPTION-01', online: true,  ver: '1.4.9', mins: 1 },
      { name: 'FRONTDESK-02', online: true,  ver: '1.4.6', mins: 2 },
      { name: 'BACKOFFICE-01', online: false, ver: null,   mins: 2880 },
    ];

    for (const m of machines) {
      idx += 1;
      const seen = new Date(Date.now() - m.mins * 60_000);
      const ep = await prisma.endpoint.create({
        data: {
          tenantId: tenant.id, customerId: customer.id,
          name: m.name, hostname: m.name, platform: 'Windows',
          osVersion: 'Microsoft Windows NT 10.0.26100.0',
          status: m.online ? 'ACTIVE' : 'OFFLINE',
          isManaged: true, isOnline: m.online, lastSeenAt: seen,
          ipAddress: `203.0.113.${20 + idx}`,
        },
      });
      await prisma.rustdeskNode.create({
        data: {
          tenantId: tenant.id, endpointId: ep.id,
          rustdeskId: String(100000000 + idx * 7654321).slice(0, 9),
          hostname: m.name, platform: 'Windows', version: m.ver,
          lastSeenAt: seen, permanentPassword: encrypt('DemoEndpointPw' + idx),
        },
      });
    }

    // Session history so the Sessions screen is not empty.
    for (let s = 0; s < 3; s++) {
      const started = new Date(Date.now() - (s + 1) * 3600_000);
      await prisma.supportSession.create({
        data: {
          tenantId: tenant.id, customerId: customer.id, technicianId: tech.id,
          isAdHoc: false, status: 'SESSION_COMPLETED',
          issueDescription: ['Printer not responding', 'Slow login after update', 'Email profile repair'][s],
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
