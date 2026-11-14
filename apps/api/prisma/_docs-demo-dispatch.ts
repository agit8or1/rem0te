/**
 * Demo data for the pages added in 0.44–0.48, for documentation screenshots.
 * Runs ONLY against the throwaway reboot_remote_docs database, after
 * _docs-demo-workbench.ts and before _docs-demo-refresh.ts. Idempotent: it
 * clears what it owns first, so it can be re-run before every capture — and
 * should be before a capture, so the chat and its unread replies are as described.
 *
 *   DATABASE_URL=…/reboot_remote_docs [DOCS_AGENT_SHA256=<hex>] \
 *     [DOCS_CHAT_IMAGE=<png>] npx tsx prisma/_docs-demo-dispatch.ts
 *
 * What it writes, and why:
 *   - HARB-DISPATCH-01 and HARB-DISPATCH-02 report a 0.48 signed agent with
 *     every catalog action and the tray chat protocol, so the Actions,
 *     Services, Processes and Chat tabs show what a current agent offers.
 *     DOCS_AGENT_SHA256 is the digest of the stand-in agent the docs stack's
 *     own throwaway release repository serves (UPDATE_REPO_DIR); with it the
 *     service-control and End process buttons are live, without it each row
 *     says the agent is not the published build. Nothing is ever delivered:
 *     there is no agent on the other end.
 *   - a small winget index (well-known packages, names and versions as the
 *     community index lists them) so Automation → Software catalog has a table
 *     to browse. Only the rows are written; nothing is fetched, and no catalog
 *     entry is made (adding one reads a manifest from winget-pkgs, so the
 *     captures tick rows and never press Add).
 *   - an open, recorded chat on HARB-DISPATCH-01 with emoji, a picture
 *     (DOCS_CHAT_IMAGE, else a small generated one) and a file from the person
 *     at the computer, and an unread last reply, so the header's chat inbox has
 *     a badge.
 *
 * Nothing here can reach anything: no destinations, no real hosts.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { CATALOG } from '../src/actions/catalog';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A plain PNG (an error-dialog shape, no text), when no picture is supplied. */
function generatedPng(): Buffer {
  const w = 360, h = 160;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      let c = [245, 245, 245];
      if (y < 28) c = [0, 95, 184];
      const dx = x - 48, dy = y - 88;
      if (dx * dx + dy * dy < 400) c = [196, 43, 28];
      if (y > 120 && y < 146 && x > 260 && x < 340) c = [225, 225, 225];
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const actions = CATALOG.map((a) => `${a.id}@${a.version}`);
  const agentSha = /^[0-9a-f]{64}$/.test(process.env.DOCS_AGENT_SHA256 ?? '') ? process.env.DOCS_AGENT_SHA256! : null;
  for (const name of ['HARB-DISPATCH-01', 'HARB-DISPATCH-02']) {
    await prisma.endpoint.updateMany({
      where: { name },
      data: { updateChannel: 'signed', agentVersion: '0.48.0', agentActions: actions, chatProtocol: 2, ...(agentSha ? { agentSha256: agentSha } : {}) },
    });
  }

  // A winget index to browse (0.43). Replaces whatever the docs database held.
  // No dotted-quad versions: the capture masks would print them as an IP address.
  const pk: [string, string, string, string][] = [
    ['7zip.7zip', '7-Zip', 'igor pavlov', '24.09'], ['Adobe.Acrobat.Reader.64-bit', 'Adobe Acrobat Reader DC (64-bit)', 'adobe', '25.001.20432'],
    ['Audacity.Audacity', 'Audacity', 'audacity team', '3.7.1'], ['Brave.Brave', 'Brave', 'brave software', '1.73.104'],
    ['Docker.DockerDesktop', 'Docker Desktop', 'docker', '4.37.1'], ['Dropbox.Dropbox', 'Dropbox', 'dropbox', '215.4.7202'],
    ['GIMP.GIMP', 'GIMP', 'the gimp team', '2.10.38'], ['Git.Git', 'Git', 'the git development community', '2.47.1'],
    ['Google.Chrome', 'Google Chrome', 'google llc', '131.0.6778.205'], ['Google.GoogleDrive', 'Google Drive', 'google llc', '104.0.3'],
    ['Greenshot.Greenshot', 'Greenshot', 'greenshot', '1.2.10'], ['KeePassXCTeam.KeePassXC', 'KeePassXC', 'keepassxc team', '2.7.9'],
    ['Microsoft.Edge', 'Microsoft Edge', 'microsoft corporation', '131.0.2903.112'], ['Microsoft.OneDrive', 'Microsoft OneDrive', 'microsoft corporation', '24.244.1204.0003'],
    ['Microsoft.PowerToys', 'PowerToys', 'microsoft corporation', '0.87.1'], ['Microsoft.Teams', 'Microsoft Teams', 'microsoft corporation', '24335.206.3315.2433'],
    ['Microsoft.VisualStudioCode', 'Microsoft Visual Studio Code', 'microsoft corporation', '1.96.2'], ['Microsoft.WindowsTerminal', 'Windows Terminal', 'microsoft corporation', '1.21.3231.0'],
    ['Mozilla.Firefox', 'Mozilla Firefox', 'mozilla', '133.0.3'], ['Notepad++.Notepad++', 'Notepad++', 'notepadteam', '8.7.4'],
    ['OBSProject.OBSStudio', 'OBS Studio', 'obs project', '31.0.0'], ['OpenJS.NodeJS.LTS', 'Node.js LTS', 'openjs foundation', '22.12.0'],
    ['Postman.Postman', 'Postman', 'postman', '11.23.3'], ['PuTTY.PuTTY', 'PuTTY', 'simon tatham', '0.82'],
    ['Python.Python.3.12', 'Python 3.12', 'python software foundation', '3.12.8'], ['ShareX.ShareX', 'ShareX', 'sharex team', '17.0.0'],
    ['SlackTechnologies.Slack', 'Slack', 'slack technologies inc', '4.41.105'], ['TheDocumentFoundation.LibreOffice', 'LibreOffice', 'the document foundation', '24.8.4'],
    ['VideoLAN.VLC', 'VLC media player', 'videolan', '3.0.21'], ['WinSCP.WinSCP', 'WinSCP', 'martin prikryl', '6.3.6'],
    ['WiresharkFoundation.Wireshark', 'Wireshark', 'the wireshark developer community', '4.4.2'], ['Zoom.Zoom', 'Zoom Workplace', 'zoom video communications inc', '6.3.1.52879'],
    ['voidtools.Everything', 'Everything', 'voidtools', '1.4.1.1026'], ['Foxit.FoxitReader', 'Foxit PDF Reader', 'foxit software inc', '2024.4.0.27683'],
    ['Logitech.OptionsPlus', 'Logi Options+', 'logitech', '1.85.6513'], ['Malwarebytes.Malwarebytes', 'Malwarebytes', 'malwarebytes', '5.2.6'],
  ];
  await prisma.wingetPackage.deleteMany({});
  await prisma.wingetPackage.createMany({ data: pk.map(([packageId, name, publisher, latestVersion]) => ({ packageId, name, publisher, latestVersion })) });
  await prisma.wingetIndexState.upsert({
    where: { id: 1 },
    update: { refreshedAt: ago(5 * 60 * MIN), attemptedAt: ago(5 * 60 * MIN), packages: pk.length, skipped: 0, lastError: null },
    create: { id: 1, refreshedAt: ago(5 * 60 * MIN), attemptedAt: ago(5 * 60 * MIN), packages: pk.length, skipped: 0 },
  });

  const ep = await prisma.endpoint.findFirst({ where: { name: 'HARB-DISPATCH-01' }, include: { customer: true } });
  if (!ep) throw new Error('HARB-DISPATCH-01 not found: run _docs-demo-data.ts first');
  const tech = await prisma.user.findFirst({ where: { email: 'morgan.reyes@rem0te.example.com' } })
    ?? await prisma.user.findFirst({ where: { isPlatformAdmin: true }, orderBy: { createdAt: 'asc' } });
  if (!tech) throw new Error('no platform admin to start the chat');

  // Ours: every chat on this computer (the docs database has no others there).
  await prisma.chatConversation.deleteMany({ where: { endpointId: ep.id } });

  const image = process.env.DOCS_CHAT_IMAGE ? readFileSync(process.env.DOCS_CHAT_IMAGE) : generatedPng();
  const log = Buffer.from([
    '2026-11-14 08:41:02  Label printer: job 118 "dispatch-manifest" stuck in queue',
    '2026-11-14 08:41:30  Label printer: job 118 deleted by user',
    '2026-11-14 08:42:11  Print Spooler stopped unexpectedly',
    '',
  ].join('\r\n'));
  const tName = `${tech.firstName ?? ''} ${tech.lastName ?? ''}`.trim() || 'Technician';
  const person = 'e.vasquez';
  const conv = await prisma.chatConversation.create({
    data: {
      tenantId: ep.tenantId, customerId: ep.customerId, endpointId: ep.id, status: 'OPEN', startedById: tech.id, startedBy: 'technician',
      technicianName: tName, businessName: ep.customer?.name ?? 'Harbor Logistics', recorded: true,
      deviceState: 'window_open', deviceUser: person, deviceStateAt: ago(14 * MIN),
      // The tray page polls every few seconds; a poll more than a minute old reads as a
      // closed window. Dated ahead so the open window lasts through a capture run.
      deviceSeenAt: new Date(NOW + 45 * MIN),
      lastActivityAt: ago(1 * MIN), technicianMessages: 2, endUserMessages: 5, attachmentCount: 2, attachmentBytes: image.length + log.length,
      createdAt: ago(15 * MIN),
    },
  });
  const msg = (sender: 'TECHNICIAN' | 'END_USER', body: string, at: number, seen = true) => prisma.chatMessage.create({
    data: {
      conversationId: conv.id, sender, authorId: sender === 'TECHNICIAN' ? tech.id : null, authorName: sender === 'TECHNICIAN' ? tName : person, body,
      createdAt: ago(at * MIN),
      ...(sender === 'TECHNICIAN' ? { deliveredAt: ago(at * MIN - 4_000), shownAt: ago(at * MIN - 5_000), readAt: ago(at * MIN - 30_000) } : seen ? { technicianSeenAt: ago(at * MIN - 10_000) } : {}),
    },
  });
  const file = async (name: string, bytes: Buffer, kind: 'image' | 'file', at: number, seen = true) => {
    const m = await msg('END_USER', name, at, seen);
    await prisma.chatAttachment.create({
      data: {
        conversationId: conv.id, messageId: m.id, sender: 'END_USER', authorId: null, fileName: name, kind,
        contentType: kind === 'image' ? 'image/png' : 'application/octet-stream', sizeBytes: bytes.length, sha256: sha(bytes), bytes, createdAt: ago(at * MIN),
      },
    });
  };
  await msg('TECHNICIAN', 'Hi Ellen, this is Morgan from IT 👋 I can see the label printer queue is stuck on DISPATCH-01. What does the screen say when you print?', 14);
  await msg('END_USER', 'It just says the printer is in an error state 😕 here is a picture', 12);
  await file('printer-error.png', image, 'image', 12);
  await file('print-log.txt', log, 'file', 11);
  await msg('TECHNICIAN', 'Thanks, that helps. The Print Spooler stopped. I am starting it again from here, give me a minute ⏳', 9);
  await msg('END_USER', 'OK 👍', 8);
  await msg('END_USER', 'It printed! Thank you 🎉', 1, false);
  // The technician has read up to the picture; the last two replies are new.
  await prisma.chatReadState.upsert({
    where: { userId_conversationId: { userId: tech.id, conversationId: conv.id } },
    update: { lastReadAt: ago(9 * MIN) }, create: { userId: tech.id, conversationId: conv.id, lastReadAt: ago(9 * MIN) },
  });
  console.log(`dispatch demo: ${pk.length} winget packages; ${actions.length} actions on HARB-DISPATCH-01/02${agentSha ? ', published build' : ''}; chat ${conv.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
