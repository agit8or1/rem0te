'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';

interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-md bg-muted px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all mt-2">
      {children}
    </pre>
  );
}

const SECTIONS: Section[] = [
  {
    id: 'how-connections-work',
    title: 'How RustDesk Connections Work',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          RustDesk is open-source remote desktop software similar to TeamViewer. It is self-hosted
          — your server handles both identity (matching devices) and optionally relay traffic.
        </p>
        <p>
          When a user installs RustDesk configured to use this server, it connects to the{' '}
          <strong className="text-foreground">hbbs</strong> service (rendezvous server) on ports
          21115–21118. hbbs assigns the device a unique numeric ID (e.g. 123 456 789) that stays
          consistent as long as the device is registered.
        </p>
        <p>
          When a Rem0te user wants to connect, they enter that ID in the{' '}
          <Link href="/quick-connect" className="underline text-foreground">
            Connect
          </Link>{' '}
          page. The hbbs server brokers the connection:
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            If a direct peer-to-peer connection is possible (same network or compatible NAT), the
            traffic goes directly between the two machines — hbbs is only used for the handshake.
          </li>
          <li>
            If a direct connection is not possible (strict NAT, firewalls), traffic is relayed
            through the <strong className="text-foreground">hbbr</strong> service on port 21117.
          </li>
        </ul>
        <p>
          The remote user will see an &quot;Accept / Decline&quot; prompt in their RustDesk app.
          They must click <strong className="text-foreground">Accept</strong> before the session
          begins.
        </p>
      </div>
    ),
  },
  {
    id: 'server-setup',
    title: 'Setting Up the RustDesk Server',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          After installation, the RustDesk server (hbbs + hbbr) is already running on your machine.
          The relay host and public key are written to the database during installation.
        </p>
        <p>
          To view or update them, go to{' '}
          <Link href="/settings" className="underline text-foreground">
            Settings → RustDesk tab
          </Link>
          . The two important values are:
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong className="text-foreground">Relay Host</strong> — the hostname or IP address
            clients use to reach this server. Must be reachable from the internet if you have
            remote devices.
          </li>
          <li>
            <strong className="text-foreground">Public Key</strong> — optional but recommended.
            Prevents clients from connecting to a spoofed server. Found at{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              /var/lib/rustdesk-server/id_ed25519.pub
            </code>
            .
          </li>
        </ul>
        <p>
          The server requires ports <strong className="text-foreground">21115–21119</strong> to be
          open on your firewall. Port 21116 needs both TCP and UDP. See{' '}
          <Link href="/settings" className="underline text-foreground">
            Settings → Network / Ports
          </Link>{' '}
          for the full list.
        </p>
      </div>
    ),
  },
  {
    id: 'enrolling-endpoints',
    title: 'Enrolling Endpoints (Permanent Management)',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>There are two ways to use RustDesk with this platform:</p>
        <div className="space-y-3">
          <div className="rounded-md border px-4 py-3 space-y-1">
            <p className="font-medium text-foreground">Ad-hoc (no registration)</p>
            <p>
              The user opens RustDesk, reads their 9-digit ID out, and the person helping them
              enters it in the Connect page. Nothing needs to be installed permanently — RustDesk
              can even run as a portable app. The ID may change each time RustDesk is restarted.
            </p>
          </div>
          <div className="rounded-md border px-4 py-3 space-y-1">
            <p className="font-medium text-foreground">Managed / Enrolled</p>
            <p>
              RustDesk is installed as a persistent service on the remote machine and registered in
              this system with a permanent record. The tech can connect without asking for the ID
              each time. The endpoint shows up in the Endpoints list with its current online status.
            </p>
          </div>
        </div>
        <p className="pt-1 font-medium text-foreground">How enrollment works</p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            Go to{' '}
            <Link href="/endpoints" className="underline text-foreground">
              Endpoints
            </Link>{' '}
            and create an <strong className="text-foreground">enrollment token</strong>.
          </li>
          <li>Provide that token to whoever is setting up the device.</li>
          <li>
            On the remote machine (after installing RustDesk), run:
            <CodeBlock>rustdesk --enroll YOUR_TOKEN_HERE</CodeBlock>
          </li>
          <li>
            The device calls the API and registers itself. It immediately appears in your Endpoints
            list.
          </li>
        </ol>
        <p>
          Tokens can be single-use or multi-use and can have an expiry date. Revoke them in the
          Endpoints page.
        </p>
      </div>
    ),
  },
  {
    id: 'installing-permanently',
    title: 'Installing RustDesk Permanently on a Device',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          To make a device always available for remote support (even after reboots, without a user
          logged in), install RustDesk as a service.
        </p>
        <p className="font-medium text-foreground">Steps</p>
        <ol className="list-decimal pl-5 space-y-2">
          <li>
            <strong className="text-foreground">Download</strong> — Send the user your download
            page link:{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/download</code>. It includes
            the correct server settings pre-baked into the download URL. Or download directly from{' '}
            <a
              href="https://rustdesk.com/download"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-foreground"
            >
              rustdesk.com/download
            </a>
            .
          </li>
          <li>
            <strong className="text-foreground">Install (Windows)</strong> — Run the{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">rustdesk-installer.exe</code>{' '}
            (not the portable .exe). This registers RustDesk as a Windows service automatically.
          </li>
          <li>
            <strong className="text-foreground">Configure the server</strong> — Run the config
            command from{' '}
            <Link href="/quickstart" className="underline text-foreground">
              Quick Start → Step 1
            </Link>{' '}
            or set it manually in RustDesk Settings → Network.
          </li>
          <li>
            <strong className="text-foreground">Install the service</strong> — If the service is
            not running automatically after install, run (as administrator):
            <CodeBlock>rustdesk --install-service</CodeBlock>
          </li>
          <li>
            <strong className="text-foreground">Enroll</strong> — Use an enrollment token (see
            previous section) to register the device.
          </li>
        </ol>
        <p>
          Once running as a service, RustDesk starts with Windows and is accessible even before a
          user logs in.
        </p>
      </div>
    ),
  },
  {
    id: 'connect-flow',
    title: 'The Connect Flow (Support Side)',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <ol className="list-decimal pl-5 space-y-2">
          <li>
            Go to{' '}
            <Link href="/quick-connect" className="underline text-foreground">
              Connect
            </Link>{' '}
            in the sidebar.
          </li>
          <li>
            <strong className="text-foreground">Ad-hoc tab</strong> — Enter the user&apos;s 9-digit
            RustDesk ID (they read it from their RustDesk app). Optionally add a contact name and
            issue description for the session log.
          </li>
          <li>
            <strong className="text-foreground">Managed Endpoint tab</strong> — Select an enrolled
            endpoint from the dropdown. No need to ask the user for their ID.
          </li>
          <li>
            Click <strong className="text-foreground">Connect</strong>. A session record is created
            and a RustDesk deep-link button appears.
          </li>
          <li>
            Click <strong className="text-foreground">Open in RustDesk</strong>. RustDesk must be
            installed on your computer. It will open and attempt to connect.
          </li>
          <li>
            The remote user sees an &quot;Accept&quot; prompt. Once they accept, the session starts.
          </li>
        </ol>
        <p>
          All sessions are logged under{' '}
          <Link href="/sessions" className="underline text-foreground">
            Sessions
          </Link>
          . You can mark a session as complete and add notes when finished.
        </p>
      </div>
    ),
  },
  {
    id: 'access-control',
    title: 'Access Control',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Rem0te has exactly three access levels. There is no reseller hierarchy and no separate
          role for billing, read-only or portal access.
        </p>
        <p className="font-medium text-foreground">Platform Admin</p>
        <p>
          The Rem0te operator. Creates and manages every business, sees every computer, and owns all
          platform settings and infrastructure.
        </p>
        <p className="font-medium text-foreground">Business Owner</p>
        <p>
          Full administrative control of one business — its computers, its people, its sessions and
          its audit history. A Business Owner can never see another business.
        </p>
        <p className="font-medium text-foreground">Business User</p>
        <p>
          Access is determined by permissions assigned by the Business Owner. New Business Users
          start with <strong className="text-foreground">View computers</strong> and{' '}
          <strong className="text-foreground">Remote connect</strong>; everything more
          administrative is off until granted.
        </p>
        <p>
          Manage all of this from{' '}
          <Link href="/users" className="underline text-foreground">Users</Link>, or from{' '}
          <Link href="/admin/access" className="underline text-foreground">Access Control</Link> if
          you are a Platform Admin.
        </p>
        <p>
          Every one of these boundaries is enforced on the server. Hiding a button in this interface
          is a courtesy — changing a URL or calling the API directly still gets refused.
        </p>
      </div>
    ),
  },
  {
    id: 'quick-connect',
    title: 'Quick Connect',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Quick Connect is for helping someone whose computer is{' '}
          <strong className="text-foreground">not</strong> an enrolled managed device — a one-off
          support call rather than a machine you look after.
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Send them to <code className="rounded bg-muted px-1 py-0.5 text-xs">/quick</code>.</li>
          <li>They download and run the Quick Connect client. Nothing is installed as a service.</li>
          <li>It shows a Remote ID and a password; they read both to you.</li>
          <li>
            You enter them under{' '}
            <Link href="/quick-connect" className="underline text-foreground">Quick Connect</Link>{' '}
            and connect.
          </li>
          <li>They close the client when you are done, which ends their availability.</li>
        </ol>
        <p>
          No permanent managed computer is created, and the password is never stored by Rem0te — the
          fact that the remote person read it out to you is what authorises the session.
        </p>
        <p>
          Three switches have to line up: the platform master switch (Settings → Quick Connect), the
          per-business switch, and the individual&apos;s{' '}
          <strong className="text-foreground">Use Quick Connect</strong> permission.
        </p>
      </div>
    ),
  },
];

export default function HelpPage() {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['how-connections-work']));

  function toggleSection(id: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function expandAll() {
    setOpenSections(new Set(SECTIONS.map((s) => s.id)));
  }

  function collapseAll() {
    setOpenSections(new Set());
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <PageHeader title="Help &amp; Docs" description="How Reboot Remote and RustDesk work together.">
        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Expand all
          </button>
          <span className="text-xs text-muted-foreground">·</span>
          <button
            onClick={collapseAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Collapse all
          </button>
        </div>
      </PageHeader>

      <div className="space-y-2">
        {SECTIONS.map((section) => {
          const isOpen = openSections.has(section.id);
          return (
            <Card key={section.id} className="overflow-hidden">
              <button
                onClick={() => toggleSection(section.id)}
                className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-muted/50 transition-colors"
              >
                <span className="font-medium text-sm">{section.title}</span>
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
              {isOpen && (
                <CardContent className="pt-0 pb-5 px-5 border-t">
                  <div className="pt-4">{section.content}</div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground pt-2">
        Need to get set up from scratch?{' '}
        <Link href="/quickstart" className="underline">
          Run the Quick Start wizard
        </Link>
        .
      </p>
    </div>
  );
}
