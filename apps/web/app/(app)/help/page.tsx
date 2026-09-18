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
    title: 'Connecting to a Computer',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <ol className="list-decimal pl-5 space-y-2">
          <li>
            Open{' '}
            <Link href="/endpoints" className="underline text-foreground">
              Computers
            </Link>{' '}
            (or{' '}
            <Link href="/my-computers" className="underline text-foreground">
              My Computers
            </Link>
            ) and click <strong className="text-foreground">Connect</strong>.
          </li>
          <li>
            Your browser downloads a small file named for that machine. Run it. It uses the
            RustDesk already on your computer — or fetches a portable copy once — points it at
            this server, and opens the session with the password applied.
          </li>
          <li>
            It installs nothing, needs no elevation, and deletes itself afterwards because it
            carries a live credential.
          </li>
        </ol>
        <p>
          <strong className="text-foreground">Why a file and not a link?</strong> A{' '}
          <code className="font-mono text-xs">rustdesk://</code> link is routed by Windows to
          whichever RustDesk is installed, using whatever server <em>that</em> client is set to —
          and the URI scheme has no field for a server address. A client that has never been told
          about this server asks rustdesk.com instead, is told the ID does not exist, and reports{' '}
          <em>&ldquo;the target device is offline or does not exist&rdquo;</em> about a computer
          that is online. The script configures the client first, so it works the first time on a
          machine that has never seen this server.
        </p>
        <p>
          For an unattended person with nothing installed, use{' '}
          <Link href="/quick-connect" className="underline text-foreground">
            Quick Connect
          </Link>{' '}
          instead — they run a self-configuring client and read you its 9-digit ID.
        </p>
        <p>
          All sessions are logged under{' '}
          <Link href="/sessions" className="underline text-foreground">
            Sessions
          </Link>
          .
        </p>
      </div>
    ),
  },
  {
    id: 'tactical-rmm',
    title: 'Connecting from Tactical RMM',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          If you run Tactical RMM, you can start a Rem0te session straight from the
          agent you are already looking at — right-click it and pick the action. It
          is just another way to open a session; nothing about Rem0te changes.
        </p>
        <p className="font-medium text-foreground">Add the URL Action in Tactical RMM</p>
        <p>
          In TRMM, go to <strong className="text-foreground">Settings → Global
          Settings → URL Actions</strong> and add one:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong className="text-foreground">Name</strong> — Connect with Rem0te</li>
          <li><strong className="text-foreground">URL Pattern</strong> — the address below</li>
        </ul>
        <CodeBlock>{`https://${'{'}your-rem0te-host}/trmm?host={{agent.hostname}}&client={{client.name}}&site={{site.name}}&agent={{agent.agent_id}}`}</CodeBlock>
        <p>
          Then right-click any agent in TRMM →{' '}
          <strong className="text-foreground">Run URL Action</strong> → Connect with
          Rem0te. You can also make it the double-click action under TRMM&apos;s
          Preferences.
        </p>
        <p>
          Want to look at the computer rather than connect to it? Add a second action
          with <code className="text-foreground">&amp;action=open</code> on the end —
          that lands on the computer&apos;s page in Rem0te instead.
        </p>
        <p className="font-medium text-foreground">Everything in {'{{ }}'} is case sensitive</p>
        <p>
          Tactical RMM does not warn you about a typo — it sends the text through
          as-is, which arrives here as a hostname that matches nothing. Copy the line
          above rather than retyping it.
        </p>
        <p className="font-medium text-foreground">No API key, and no extra sign-in</p>
        <p>
          The action opens in your own browser, so it uses the Rem0te session you
          already have and only reaches computers you can already see. If you are not
          signed in, Rem0te asks, then carries on to the computer. There is
          deliberately no key in that address: a URL Action is visible to everyone in
          TRMM who can right-click an agent.
        </p>
        <p className="font-medium text-foreground">If two computers have the same name</p>
        <p>
          Common enough — two customers both with a machine called RECEPTION-PC.
          Rem0te will not guess, because guessing would open a session on the wrong
          customer&apos;s machine. It shows you both and asks. Pick one and it
          remembers, so the next time you launch that agent from TRMM it goes
          straight through.
        </p>
        <p>
          Full setup, including showing the RustDesk ID inside TRMM and calling
          Rem0te from a TRMM script, is in{' '}
          <Link href="/docs/tactical-rmm" className="underline text-foreground">
            the documentation
          </Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'specs-and-event-logs',
    title: 'System Specs, Updates and Event Logs',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          A managed computer&apos;s page shows what it has reported about itself:
          hardware, storage, network adapters, who is signed in, how long it has been
          up, and how many Windows updates it is waiting on. Open it from{' '}
          <Link href="/endpoints" className="underline text-foreground">Computers</Link> and
          look at the <strong className="text-foreground">Overview</strong> tab.
        </p>
        <p className="font-medium text-foreground">Nothing here is live</p>
        <p>
          Rem0te has no channel to reach into a computer. Everything on that tab arrived
          on a heartbeat, which happens about every three minutes, and each card says
          when its contents were collected. Pressing{' '}
          <strong className="text-foreground">Refresh</strong> queues a fresh collection
          for the next heartbeat — it does not fetch anything on the spot.
        </p>
        <p>
          Signed-in user and uptime come in on every heartbeat. Full specs are
          re-collected every six hours, and the Windows Update check every twelve —
          that one starts the Windows Update agent and goes out to the network, so it
          runs on its own slower schedule and keeps its own timestamp.
        </p>
        <p className="font-medium text-foreground">Event logs</p>
        <p>
          The <strong className="text-foreground">Event Log</strong> tab asks the
          computer for a page of one Windows log — Application, System, Security, Setup
          or Windows PowerShell. Pick a time range, the levels and how many of the most
          recent events you want; the table fills in when the machine answers, up to
          three minutes later. If it is offline the request waits half an hour and then
          expires.
        </p>
        <p>
          Reading event logs is a separate permission from viewing computers, because a
          machine&apos;s Security log is a different kind of access from its name and an
          online dot. A Business Owner has it; a Business User is granted it under{' '}
          <Link href="/users" className="underline text-foreground">Users</Link>. Every
          request is recorded in the audit log with the log name, the window and who
          asked.
        </p>
        <p className="font-medium text-foreground">If a computer reports nothing</p>
        <p>
          Re-run the managed installer on it. The agent that collects all of this is
          written to disk at install time, so a machine runs whatever version its last
          install left behind — and anything enrolled before per-device secrets existed
          is not trusted to report at all. The Overview tab says which of the two is
          the case.
        </p>
      </div>
    ),
  },
  {
    id: 'connect-troubleshooting',
    title: 'Connect Says the Computer Is Offline',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          That message comes from RustDesk, not Rem0te, and it usually means the client{' '}
          <em>you are connecting from</em> is asking a different rendezvous server — not that
          anything is wrong with the computer you are connecting to.
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-foreground">Quit RustDesk completely first</strong> — from the
            system tray, not just the window. A running client will not pick up a configuration
            change.
          </li>
          <li>
            <strong className="text-foreground">Uninstalling RustDesk does not clear its
            settings.</strong> <code className="font-mono text-xs">%APPDATA%\RustDesk</code>{' '}
            survives, and a fresh install reads the old server back out of it.
          </li>
          <li>
            Click <strong className="text-foreground">Connect</strong> again and run the file. It
            reapplies the configuration every time.
          </li>
          <li>
            To prepare a machine in advance, use{' '}
            <Link href="/downloads" className="underline text-foreground">
              Downloads
            </Link>{' '}
            → <em>Set up this computer for Connect</em>.
          </li>
        </ul>
        <p>
          Every run writes a log to{' '}
          <code className="font-mono text-xs">%LOCALAPPDATA%\Rem0te\rem0te-last-run.log</code>,
          which survives the window closing.
        </p>
        <p>
          Server-side, an administrator can ask the rendezvous server directly with{' '}
          <code className="font-mono text-xs">deploy/scripts/hbbs-probe.py &lt;id&gt;</code>. It
          reports ONLINE / OFFLINE / ID_NOT_EXIST / LICENSE_MISMATCH, which are four different
          problems that look identical from here.
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

      <Card>
        <CardContent className="space-y-2 pt-5 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Full documentation</p>
          <p>
            The complete reference lives with the source — installation and operations, the
            connect paths and their failure modes, every client Rem0te hands out, the update
            procedures, architecture, and the access-control model.
          </p>
          <p>
            <a
              href="https://github.com/agit8or1/rem0te/tree/main/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-foreground"
            >
              github.com/agit8or1/rem0te/tree/main/docs
            </a>
          </p>
        </CardContent>
      </Card>

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
