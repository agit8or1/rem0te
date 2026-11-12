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
        <p>
          How big a server to use for 50, 250, 1,000 or 5,000 computers — CPU, memory, disk and PostgreSQL, with the
          measured cost of a heartbeat and how fast the database grows — is in{' '}
          <Link href="/docs/server-sizing" className="underline text-foreground">Server sizing</Link>. In short: 2 vCPU
          and 2–4 GB up to a few hundred computers, 4 vCPU and 8 GB for 1,000, 8 vCPU and 16 GB for 5,000. Since 0.34 a
          heartbeat no longer starts a process to ask the RustDesk ID server about the computer, and one API process
          measured roughly twice the rate 5,000 computers need; more than 5,000 has not been measured.
        </p>
        <p>
          From 0.34 old history ages out of the database on its own: finished agent commands and diagnostics after 90
          days, inventory changes and resolved alerts after 400, unused launch tokens 30 days after they expire. Remote
          sessions are kept, and the audit log is never pruned. Each window is a <code>RETENTION_*_DAYS</code> setting in
          the server&apos;s environment, with a floor and a ceiling; <code>RETENTION_SWEEP=off</code> stops the sweep.
          What each table holds now is on{' '}
          <Link href="/admin/status" className="underline text-foreground">Settings → System status</Link> (Platform
          Admins), and the details are in{' '}
          <Link href="/docs/data-retention" className="underline text-foreground">Data retention</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'enrolling-endpoints',
    title: 'Adding a Device (Permanent Management)',
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
            <p className="font-medium text-foreground">Managed (added as a device)</p>
            <p>
              RustDesk is installed as a persistent service on the remote machine and the machine
              is enrolled into a business. You can connect without asking for the ID each time, and
              on Windows the Rem0te agent reports its health, inventory and updates.
            </p>
          </div>
        </div>
        <p className="pt-1 font-medium text-foreground">How to add a device</p>
        <p>
          Open{' '}
          <Link href="/endpoints/enroll" className="underline text-foreground">
            Devices → Add device
          </Link>{' '}
          (the <strong className="text-foreground">Add device</strong> button on the Devices page). One page takes you through it:
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Choose the business, then a site or none, and who may connect. These are fixed into the link: the machine cannot pick another business or site.</li>
          <li>Choose the operating system. Windows gets the Rem0te agent; Linux and macOS (run with sudo) get a read-only agent that reports inventory and pending updates.</li>
          <li>Make the install command. You are asked to confirm it&apos;s you first, unless you did in the last 10 minutes: a link adds a computer to the business. Your choices are kept while you confirm. Copy the command (or, on Windows, the one-click installer link) and run it on the machine. It works once, expires in 24 hours, and is shown only once.</li>
          <li>Keep the page open. It checks every few seconds and says the device enrolled only when it has.</li>
          <li>It then shows the first health the server has received: online, the agent and its version, and whether the first inventory has arrived. Anything not yet received says so.</li>
          <li>Open the device, or the business&apos;s monitoring policies, from the last step.</li>
        </ol>
        <p>
          An unused link can be revoked from the waiting step. For a machine that already runs
          RustDesk and only needs listing, without the agent, use{' '}
          <Link href="/endpoints/new" className="underline text-foreground">Register by RustDesk ID</Link>.
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
            <strong className="text-foreground">Enrol</strong> — Add it from Devices → Add device
            (previous section). On a machine you can run commands on, Add device&apos;s installer does
            every step above for you.
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
    id: 'phone-width',
    title: 'Using Rem0te on a Phone',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          On a screen narrower than 768 px the menu is not drawn beside the page. The{' '}
          <strong className="text-foreground">menu button</strong> at the left of the top bar opens it over the page,
          with everything the sidebar holds: the business switcher, Help, the theme and Sign out. Choosing a page closes
          it, as do <strong className="text-foreground">Esc</strong>, tapping outside it and its close button.
        </p>
        <p>
          Wide tables — the device list, the reports, API keys — scroll sideways inside their own box instead of
          widening the page, so swipe the table rather than the page. A device&apos;s tab row scrolls the same way.
        </p>
      </div>
    ),
  },
  {
    id: 'global-search',
    title: 'Searching Everything (Ctrl+K)',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          The <strong className="text-foreground">Search</strong> box at the top of every page — or{' '}
          <strong className="text-foreground">Ctrl+K</strong> (<strong className="text-foreground">⌘K</strong> on a
          Mac) from anywhere — searches devices, businesses, sites, people and open alerts at once. Type at least two
          characters; the arrow keys move through the results, Enter opens one, Esc closes the box.
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong className="text-foreground">Devices</strong> match by name, hostname, RustDesk ID, serial number,
            signed-in user, IP address, a network adapter&apos;s IPv4 address or alias. A result says which of those
            matched. Archived devices are not included, as in the device list.
          </li>
          <li>
            <strong className="text-foreground">Businesses</strong> by name, code, email or city;{' '}
            <strong className="text-foreground">sites</strong> by name, city or address (a site opens the device list
            filtered to it); <strong className="text-foreground">people</strong> by name or email;{' '}
            <strong className="text-foreground">alerts</strong> by title, open and acknowledged ones only.
          </li>
          <li>
            Exact matches come first, then ones that start with what you typed. Each group shows at most eight; when
            there are more it says so, and for devices links to the device list&apos;s own search.
          </li>
        </ul>
        <p>
          <strong className="text-foreground">You only ever find what you could already open.</strong> Each group uses
          the same rules as its own page: devices need <em>View computers</em> and show only the devices you can see
          (for a Business User, the ones assigned to you or shared company-wide; for a technician, the ones your
          assignment names); sites need <em>View computers</em>; people need <em>View business users</em>; alerts need{' '}
          <em>See and work alerts</em>. A group you have no permission for is left out, not shown as empty. Another
          business&apos;s device is not found even by its exact hostname or RustDesk ID.
        </p>
        <p>
          Searches are not written to the audit log and the server does not log what you typed. A reverse proxy in
          front of Rem0te may still record request addresses, which include the search. Searching is limited to 120
          requests a minute from one address; the box says so if you hit it.
        </p>
      </div>
    ),
  },
  {
    id: 'device-list',
    title: 'The Device List',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          <Link href="/endpoints" className="underline text-foreground">Devices</Link> lists every device you can
          see — online ones first, then by name. Search, filters, sorting and paging all run on the server, so they
          cover every device, not just the page on screen. Click a column heading to sort by it.
        </p>
        <p>
          <strong className="text-foreground">Health</strong> is the worst open monitoring alert;{' '}
          <strong className="text-foreground">Pending patches</strong> comes from the last update scan; CPU, RAM,
          disk and the logged-in user come from the last heartbeat. Each shows its age, and a value that is stale —
          a resource sample older than 15 minutes, an update scan older than 36 hours — is greyed: it is what the
          device last reported, not what it is doing now. Health and alerts need the monitoring:alerts permission.
        </p>
        <p>
          <strong className="text-foreground">Columns</strong> and row density are remembered in this browser.{' '}
          <strong className="text-foreground">Views</strong> save the current filters, sort, columns and density
          under a name, on your account. A view is personal, or shared with everyone in one business — sharing is
          for a Business Owner, a technician with computers:edit over the whole business, or the MSP, and is
          audited. A view stores only the list&apos;s parameters, so opening one shows each person only the devices
          they can see. <strong className="text-foreground">Export CSV</strong> downloads the whole filtered view
          (up to 10,000 devices), contains only what you can see, and is recorded in the audit log.
        </p>
        <p>
          <strong className="text-foreground">Device groups</strong> (Views → Device groups…) are named groups of one
          business&apos;s computers, for filtering and bulk actions. A computer can be in several groups of its
          business — adding it to one never takes it out of another — and the Groups column lists them all. A computer
          moved to another business leaves the old business&apos;s groups. Groups grant nothing. They are managed by the
          same people who may share views, and every change is audited.
        </p>
        <p>
          A <strong className="text-foreground">rule group</strong> (Views → Save filters as a rule group…) holds
          whichever computers of its business match the current filters — online, platform, site, tag, updates,
          alerts, RustDesk version range, last seen (More filters) — worked out each time it is read, so a computer
          that goes offline leaves an &ldquo;online&rdquo; group at once. Nobody adds to it by hand. Everyone sees only
          the members they can already see, and a rule on alerts needs the monitoring:alerts permission. Filtered by
          a rule group, the bulk bar acts on its current members (at most 200).
        </p>
        <p>
          <strong className="text-foreground">Tick rows</strong> to act on up to 200 devices at once: add to or remove
          from a group, refresh inventory, queue a RustDesk client update (Platform Admin), or export the selection.
          Each device is checked on its own exactly as if you had done it to that one device, and the result lists
          every device that was refused and why. There is no bulk connect, archive, delete or approved action.
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
              Devices
            </Link>{' '}
            (or{' '}
            <Link href="/my-computers" className="underline text-foreground">
              Devices → My devices
            </Link>
            ) and click <strong className="text-foreground">Connect</strong>.
          </li>
          <li>
            If the connection uses the computer&apos;s password, you are asked to confirm it&apos;s you first (once
            every 10 minutes). The password goes into the file below and nowhere else.
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
    id: 'chat',
    title: 'Chatting with the Person at a Computer',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Open a computer and choose the <strong className="text-foreground">Chat</strong> tab. <strong className="text-foreground">Start chat</strong>{' '}
          opens a small window on that computer&apos;s desktop, titled with the business name and headed with your name,
          saying the business will never ask for a password and that links are never opened. The computer picks the
          chat up at its next check-in, normally within three minutes; after that, messages arrive within seconds.
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-foreground">Windows with the signed agent only.</strong> Linux, macOS and the
            standard Windows agent cannot chat yet, and the tab says so for those computers. The desktop window has not
            yet been run on real Windows.
          </li>
          <li>
            Each message shows <em>Sent</em>, <em>Delivered</em>, <em>Shown</em> or <em>Read</em>, and only what the computer
            has confirmed. The panel also says what the computer last reported: window open, nobody signed in, the window
            could not be opened, or the computer has gone quiet.
          </li>
          <li>
            The person can reply or close the window. Closing it ends the chat, and so do <em>End chat</em> and two hours
            with no message.
          </li>
          <li>
            Up to 2,000 characters a message and 20 messages a minute. Text is shown as plain text on both sides.
          </li>
          <li>
            Starting and writing need the <em>Chat with the person at a computer</em> permission. Anyone who can see the
            computer can read its transcripts, which are deleted 400 days after the chat ends. A <em>remote connections</em>{' '}
            containment pause stops new chats and messages. The audit log records each start and end, never the text.
          </li>
        </ul>
        <p>
          See <Link href="/docs/chat" className="underline text-foreground">Chat</Link> for the details.
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
          <Link href="/endpoints" className="underline text-foreground">Devices</Link> and
          look at the <strong className="text-foreground">Overview</strong> tab.
        </p>
        <p className="font-medium text-foreground">The device page</p>
        <p>
          The top of the page says whether the computer is online (or offline since
          when), its business and site, and when its agent last checked in, marked
          stale when it has missed check-ins. The strip under it lists what needs
          attention: open alerts, a pending restart, pending updates with the age of
          the scan, and which agent it runs. Each opens the tab that explains it.
          Connect, Diagnose, Run action and Patch sit beside it; Archive and the other
          rare actions are under More, each with a confirmation. The tabs are
          Overview, Performance, Monitoring, Software, Processes, Services, Network, Patches, Event logs,
          Diagnostics, Actions and History (sessions, notes, the AI-written summary and who can connect), and
          each can be linked with <code>?tab=</code>.
        </p>
        <p className="font-medium text-foreground">Nothing here is live</p>
        <p>
          Rem0te has no channel to reach into a computer. Everything on that tab arrived
          on a heartbeat, which happens about every three minutes, and each card says
          when its contents were collected. Pressing{' '}
          <strong className="text-foreground">Refresh</strong> queues a fresh collection
          for the next heartbeat — it does not fetch anything on the spot.
        </p>
        <p className="font-medium text-foreground">Performance: CPU, memory and disk over time</p>
        <p>
          The <strong className="text-foreground">Performance</strong> tab (0.33) charts processor, memory and
          system-disk use from every heartbeat, and each volume from the inventory pass, over 24 hours, 7, 30 or 90
          days. Longer ranges show each hour&apos;s mean with its lowest-to-highest band. Hatched stretches are gaps —
          no samples arrived, because the computer was offline or its agent was not reporting — and nothing is drawn
          across them. Samples are kept 48 hours and hourly figures 90 days. History raises no alerts; the
          monitors judge each reading as it arrives. See{' '}
          <Link href="/docs/metric-history" className="underline text-foreground">Metric history</Link>.
        </p>
        <p>
          Signed-in user and uptime come in on every heartbeat. Full specs are
          re-collected every six hours, and the Windows Update check every twelve —
          that one starts the Windows Update agent and goes out to the network, so it
          runs on its own slower schedule and keeps its own timestamp.
        </p>
        <p className="font-medium text-foreground">Event logs</p>
        <p>
          The <strong className="text-foreground">Event logs</strong> tab asks the
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
        <p className="font-medium text-foreground">One-click diagnostics</p>
        <p>
          A Windows computer&apos;s <strong className="text-foreground">Diagnostics</strong> list
          has nine read-only checks — disk space, service health, recent system errors, top
          processes, network connectivity, DNS, pending updates, reboot status and a fresh
          inventory. Press <strong className="text-foreground">Run</strong>: the computer picks the
          request up on its next heartbeat, runs the fixed check its agent carries, and the result
          appears with its age. Nothing on the computer is changed and nothing you type reaches it —
          there is nothing to type. If the computer does not check in within fifteen minutes the run
          expires and says so. <em>Recent system errors</em> needs the event-log permission; every
          other check needs only to see the computer. Every run is in the audit log. More in{' '}
          <Link href="/docs/diagnostics" className="underline text-foreground">One-click diagnostics</Link>.
        </p>
        <p className="font-medium text-foreground">Processes, Services and Network</p>
        <p>
          These three tabs list every running process (with its user and start time), every
          service (with its start mode and the account it runs as) and every network connection
          (addresses, gateway, DNS, DHCP and MAC). Each is a snapshot: it says when it was taken
          and how old it is, and <strong className="text-foreground">Refresh</strong> asks the
          computer for a new one on its next heartbeat, exactly like a diagnostic. Command lines
          and file paths are never collected. There are no end-task, stop or start buttons —
          restarting a service is a signed maintenance action on the Actions tab. Windows computers
          with the standard agent only; the Linux agent does not collect them. More in{' '}
          <Link href="/docs/diagnostics#the-processes-services-and-network-tabs" className="underline text-foreground">One-click diagnostics</Link>.
        </p>
        <p className="font-medium text-foreground">The AI-written summary</p>
        <p>
          <em>History</em> ends with an <strong className="text-foreground">AI-written summary</strong> of the
          computer&apos;s notes and remote sessions. Rem0te holds no AI provider key: from 0.34 the summary is written by
          ClientSt0r&apos;s AI, through the same signed connection as ticket analysis, for the ClientSt0r organization
          the business is mapped to. <strong className="text-foreground">What is sent to ClientSt0r</strong> lists every
          field, what is never sent (the computer&apos;s name and hostname, the business, addresses, who wrote a note,
          the RustDesk ID) and how many passwords, tokens, e-mail and IP addresses were removed first; <em>Show the
          exact text</em> shows it word for word. Generating one needs Rename/edit computers and Ticket analysis
          (ClientSt0r); every request is in the audit log, without the text, and an integration pause stops it.
        </p>
        <p>
          ClientSt0r does not offer this yet: the panel says <em>Needs ClientSt0r support for
          device_timeline_v1</em> and the button stays off until ClientSt0r advertises it. A summary already written
          can still be edited by hand. More in{' '}
          <Link href="/docs/integration-clientst0r#the-device-pages-ai-summary-034" className="underline text-foreground">ClientSt0r integration</Link>.
        </p>
        <p className="font-medium text-foreground">If a computer reports nothing</p>
        <p>
          Re-run the managed installer on it. The agent that collects all of this is
          written to disk at install time, so a machine runs whatever version its last
          install left behind — and anything enrolled before per-device secrets existed
          is not trusted to report at all. The Overview tab says which of the two is
          the case.
        </p>
        <p className="font-medium text-foreground">If a computer went offline after an update</p>
        <p>
          Its installer re-ran and it is now calling in with a new device secret, which
          the server refuses. The Overview tab shows the address those heartbeats come
          from. If that address is right, press <strong>Accept this device</strong> and
          the computer reports in on its next heartbeat. Accepting also adopts the new
          RustDesk password the reinstall reported, so Connect keeps working. If it is not calling in at
          all, an installer from before 0.19.2 left its heartbeat script unreadable:
          re-run the installer on the machine itself, since <strong>Update</strong>{' '}
          cannot reach it, then accept it as above. A computer archived by mistake
          comes back with <strong>Restore</strong> on the same page.
        </p>
        <p className="font-medium text-foreground">Updating or upgrading a computer&apos;s agent</p>
        <p>
          From 0.34 the <strong>Agent</strong> card on a computer&apos;s Overview tab says which agent it runs, its
          version and whether that is current, its update channel and the portal&apos;s update mode.{' '}
          <strong>Update agent</strong> re-runs the current installer on a standard agent (the same as Reinstall
          agent); on a signed agent it is <strong>Check for update now</strong>, which installs only what the signed
          repository lists. Linux and macOS agents act on nothing the console sends, so the card gives the command to
          re-run on the computer. <strong>Upgrade to signed agent</strong> moves one Windows computer to the signed
          agent at its next check-in, after a reason and a fresh sign-in; when it can&apos;t, the card says exactly
          what is missing, such as a signed release that has not been published yet. It is refused while the portal is
          in <em>Signed only</em> mode and held while updates are paused for the business. Several computers can be
          moved at once from the device list, and{' '}
          <Link href="/endpoints/agent-migrations" className="underline">Agent migrations</Link> lists what is pending,
          held, not confirmed or done. More in{' '}
          <Link href="/docs/update-signing#moving-existing-agents" className="underline">Update signing</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'monitoring-and-alerts',
    title: 'Monitoring and Alerts',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Rem0te watches managed computers and raises an alert when one needs a person: offline, a
          system disk nearly full, the processor or memory pinned, a Windows service stopped, matching
          events in an event log, or a restart pending for days. Alerts are under{' '}
          <Link href="/alerts" className="underline text-foreground">Alerts</Link> in the sidebar, and
          each computer has a <strong className="text-foreground">Monitoring</strong> tab with its own
          alerts, the monitors in effect, its change history and installed software.
        </p>
        <p className="font-medium text-foreground">Monitoring only reads</p>
        <p>
          A monitor never changes a computer. It uses what the agent already sends on its heartbeat,
          plus the services and event-log queries a monitor asks about.
        </p>
        <p className="font-medium text-foreground">Setting it up</p>
        <p>
          <Link href="/settings/monitoring" className="underline text-foreground">Settings → Monitoring</Link>.
          Start with <strong className="text-foreground">Add recommended</strong>. Monitors are inherited:
          global, then business, then site, then computer; a monitor with the same key lower down replaces
          the one above it, and a disabled one switches it off there.
        </p>
        <p className="font-medium text-foreground">One alert per problem</p>
        <p>
          A repeat raises the count on the open alert instead of making another. When three or more
          computers at a site are offline and they are at least half of it, one site-outage alert gathers
          them. <strong className="text-foreground">Acknowledge</strong> stops escalation;{' '}
          <strong className="text-foreground">Resolve</strong> closes it with a note. Most alerts also
          resolve themselves when the problem clears.
        </p>
        <p className="font-medium text-foreground">Maintenance windows are not containment</p>
        <p>
          A maintenance window holds notifications for planned work — alerts are still recorded. To stop
          changes reaching computers during an incident, use{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Containment</Link>.
        </p>
        <p className="font-medium text-foreground">Who is told</p>
        <p>
          Up to four escalation levels, each with webhook or (0.34) email destinations — email only to confirmed addresses, saying only the alert, computer, business and a link — under the Notifications tab, and
          optionally a ticket in ClientSt0r. Changing who is notified asks you to confirm it is you.
          See <Link href="/docs/monitoring" className="underline text-foreground">Monitoring and alerts</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'client-updates',
    title: 'Automatic RustDesk Client Updates',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          A business can let the server update outdated RustDesk clients by itself, at a time nobody is
          using the computers. Set it in{' '}
          <Link href="/settings/client-updates" className="underline text-foreground">Settings → Client updates</Link>.
          It is off until someone turns it on.
        </p>
        <p className="font-medium text-foreground">The update window</p>
        <p>
          Pick the days and times, and the time zone they are in — for example every night 22:00–05:00
          Europe/London. An end earlier than the start runs past midnight and belongs to the day it starts
          on. Daylight-saving changes are handled: on the night the clocks go forward a window that starts in
          the missing hour opens when the clock reaches the next real time. The page shows when the window
          next opens. A site can have its own policy, which replaces the business one for that site.
        </p>
        <p className="font-medium text-foreground">What happens</p>
        <p>
          While the window is open, the server queues outdated Windows computers that are online, in batches
          (25 per two-minute sweep by default), and each is told to re-run its installer on its next heartbeat. Outside the window nothing
          is queued, and anything already queued automatically waits. By default a computer with an open
          remote session is skipped (the install restarts RustDesk and would end the session); you can also
          skip computers someone is logged on to. Updates paused by{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Containment</Link>{' '}
          stop all of this.
        </p>
        <p className="font-medium text-foreground">Clicking Update still goes at once</p>
        <p>
          An update someone queues by hand on the Updates page is sent on the next heartbeat, whatever the
          window. The Updates page and the computer&apos;s page say which kind each queued update is, and who
          queued a manual one. Clicking Update on one that is waiting for the window sends it now.
        </p>
        <p className="font-medium text-foreground">Computers that will never update automatically</p>
        <p>
          The Computers list says why: not Windows, never authenticated with a device secret (re-run the
          installer on the machine once), or an agent so old it has never reported a RustDesk version. An
          offline computer is queued when it is next online inside the window.
        </p>
        <p className="font-medium text-foreground">Who can change it</p>
        <p>
          A Business Owner for their own business, a technician whose assignment gives{' '}
          <em>Rename/edit computers</em> over the whole business, or the MSP. Turning it on asks you to confirm
          it is you; turning it off never does. Every change, and every computer queued automatically, is in
          the audit log.
        </p>
      </div>
    ),
  },
  {
    id: 'api-keys',
    title: 'API Keys',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Integrations (a PSA, an asset system, your own scripts) use the public API at{' '}
          <code className="text-foreground">/api/v1/pub/v1</code> with an API key. Create one under{' '}
          <Link href="/settings/api-keys" className="underline text-foreground">Settings → API keys</Link>.
        </p>
        <p>
          A key belongs to one business and can do only what its scopes allow — tick only what the
          integration needs. It is shown once, when it is created; only a hash is kept, so a lost key is
          revoked and replaced. Revoking takes effect at once. Keys are managed by a Business Owner, or by a
          Platform Admin for any business.
        </p>
        <p>
          Creating a key asks you to <strong className="text-foreground">confirm it&apos;s you</strong>, whatever its
          scopes: a key keeps working after you sign out, so a stolen or unattended session must not be enough to make
          one. Your entries stay in the form while you confirm. A key cannot be edited afterwards — to change its
          scopes, create a new one and revoke the old. Revoking never asks. See the{' '}
          <Link href="/docs/public-api" className="underline text-foreground">API guide</Link>.
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
              Remote Support → Technician client
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
    id: 'test-connection',
    title: 'Test Connection and Session Status',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Every computer&apos;s page has a <strong className="text-foreground">Test connection</strong> panel, on its
          Diagnostics tab (the Diagnose button opens it). It
          checks the server, the computer and — with <em>Check my computer</em> — the RustDesk on your own machine,
          and says which one is wrong. Fixes that change something are labelled; the test itself changes nothing.
          <em> Download report</em> gives a redacted copy safe to attach to a ticket.
        </p>
        <p>
          A session&apos;s status names the evidence behind it. <strong className="text-foreground">Client opened</strong>{' '}
          means RustDesk started on your computer — not that you connected.{' '}
          <strong className="text-foreground">Connection confirmed</strong> comes from the remote computer&apos;s agent
          (0.20.0 or later) or from you. With no confirming or failing signal, a session reads{' '}
          <strong className="text-foreground">Status unknown</strong>, and its duration is shown only when it was measured.
        </p>
        <p>
          More in <Link href="/docs/connecting" className="underline text-foreground">Connecting</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'technicians-and-requests',
    title: 'MSP Technicians and Support Requests',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          A technician can be given access to a business without belonging to it: chosen capabilities, optionally
          only some computers, optionally only until a date or during set hours. If you have such access, the
          business switcher at the top of the menu chooses which business you are working in, and{' '}
          <Link href="/technician" className="underline text-foreground">All Assigned</Link> shows them all — including
          access that is not active right now and why.
        </p>
        <p>
          Most technician access is now an <strong className="text-foreground">access level</strong>: L1 Help Desk,
          L2 Technician or L3 Senior. No level gives Remote connect or a computer&apos;s password. View-only works only
          where the computer can enforce it, and interactive control needs a{' '}
          <strong className="text-foreground">temporary grant</strong>: request it from the computer&apos;s page, have
          someone else approve it, then activate it with a fresh sign-in. If Connect is refused, the message says why.
          Domain controllers, hypervisors, backup servers and the Rem0te host are refused to everyone. Unusually broad
          activity pauses your privileged access until someone else clears it. More in{' '}
          <Link href="/docs/technician-access" className="underline text-foreground">Technician access</Link>.
        </p>
        <p>
          From 0.24, Windows agents can update through a <strong className="text-foreground">signed update chain</strong>:
          they run only files signed offline by your release signer, so this portal cannot make them install anything
          else. Platform Admins see which computers are still on the older update path, and can stop the portal handing
          those anything to run, under{' '}
          <Link href="/settings/security/update-signing" className="underline text-foreground">Settings → Security → Update Signing</Link>.
          More in <Link href="/docs/update-signing" className="underline text-foreground">Update signing</Link>.
        </p>
        <p>
          From 0.26, one change can be made on a Windows computer without a remote session:{' '}
          <strong className="text-foreground">starting the Print Spooler, once</strong>, from the computer&apos;s{' '}
          <em>Actions</em> tab. Nothing runs until people on the approval roster approve that exact plan with a passkey,
          on a separate approval page this portal does not serve; servers need two approvers, and some businesses also
          require their own sign-off. The computer checks the approvals itself and runs it at most once. Documents
          already in the print queue may print immediately and cannot be recalled. A result says whether the service
          was running, never that anything printed; an uncertain outcome must be reconciled before you can ask again.
          More in <Link href="/docs/approved-actions" className="underline text-foreground">Approved actions</Link>.
        </p>
        <p>
          From 0.32, the same <em>Actions</em> tab (or <strong className="text-foreground">Run action</strong> at the top of
          a computer&apos;s page) offers four <strong className="text-foreground">maintenance actions</strong>: restart one
          service from a fixed list (Print Spooler, Windows Update, BITS, Windows Time, WinRM, RustDesk), schedule a
          restart after a warning of 5 minutes to 24 hours, cancel a pending restart, and collect a fixed set of logs.
          Each one always needs two different approvers, whatever the computer. A scheduled restart shows the person at
          the computer a fixed warning and closes unsaved programs when it ends; it is never immediate, and the computer
          skips it, like a RustDesk restart, while a RustDesk session is open. Collected logs are bounded, redacted twice
          and shown only to people who may read the computer&apos;s event logs. Like every approved action, these do
          nothing until an approval signer is installed and the computer runs a 0.32+ signed agent; until then the tab
          says why. They have been tested against a simulated Windows only.{' '}
          More in <Link href="/docs/approved-actions#maintenance-actions-032" className="underline text-foreground">Approved actions</Link>.
        </p>
        <p>
          From 0.27, Windows updates can be installed in stages from{' '}
          <Link href="/patching" className="underline text-foreground">Patching</Link>: one{' '}
          <strong className="text-foreground">canary</strong> computer first, then rings. Each ring is one plan that two
          people on the approval roster approve with a passkey, and the next ring cannot be requested until the canary
          reports every update <em>effective</em> (installed, no longer offered, no restart pending). Unless the plan&apos;s
          restart rule says otherwise (below), Rem0te never restarts a computer, so &ldquo;restart required&rdquo; waits
          for someone to restart it. Only security,
          critical, rollup and ordinary Microsoft updates are installed; drivers, feature upgrades, optional updates and
          computers managed by WSUS, Intune or Configuration Manager are refused. Each computer&apos;s{' '}
          <em>Patches</em> tab shows what Windows Update offers it. Every agent reports this; installing through a
          deployment needs the signed agent. More in{' '}
          <Link href="/docs/staged-patching" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.30, the <em>Patches</em> tab starts with <strong className="text-foreground">Patch status</strong>:
          where the evidence came from (signed agent, standard agent read-only, or nothing yet), how old it is and
          whether it is <em>stale</em> (over 36 hours), the last successful scan and last boot, who manages patching
          (WSUS or Intune mean rem0te will not deploy; the standard agent cannot tell, so it says <em>unknown</em>), the
          relevant KBs, and whether a later scan confirmed each installed update. A <em>restart pending</em> alert sent
          to ClientSt0r carries a redacted copy for the ticket. What each agent type can do, and what has been tested
          on real Windows, is in{' '}
          <Link href="/docs/capabilities" className="underline text-foreground">What each agent can do</Link>.
        </p>
        <p>
          From 0.32, the Linux installer also installs a small <strong className="text-foreground">read-only agent</strong>{' '}
          (a shell script on a systemd timer, every 3 minutes), shown as <em>Standard (Linux)</em>. It heartbeats with the
          device secret from the enrolment, and reports the OS, kernel, uptime, CPU, memory, disks, logged-on users, the
          RustDesk version and pending package updates from apt, dnf or zypper (without refreshing them; <em>unknown</em>{' '}
          when there is none). It acts on nothing the console sends, so rotating the password, reinstalling or updating
          RustDesk on a Linux computer means re-running the installer there; it has no software list or event logs. Remove
          it with the installer&apos;s <code>--uninstall</code>. More in{' '}
          <Link href="/docs/inventory#linux-computers-032" className="underline text-foreground">Inventory</Link>.
        </p>
        <p>
          From 0.33 the macOS installer does the same when it is run with <code>sudo</code>: a read-only agent in{' '}
          <code>/Library/Rem0te</code>, run by a LaunchDaemon every 3 minutes, shown as <em>Standard (macOS)</em>. It reports
          the macOS version, kernel, uptime, CPU, memory, volumes, the console user, the model and serial, the RustDesk
          version, and the updates macOS itself last found. It never runs <code>softwareupdate</code>: if macOS has not
          checked in the last 36 hours the scan says <em>unknown</em> rather than showing an old list, and restart pending
          is always unknown on a Mac. Like the Linux agent it acts on nothing the console sends. It has been tested
          against recorded macOS output, not yet on a Mac. More in{' '}
          <Link href="/docs/inventory#macos-computers-033" className="underline text-foreground">Inventory</Link>.
        </p>
        <p>
          From 0.32, a computer&apos;s <em>Patches</em> tab has <strong className="text-foreground">Install updates</strong>{' '}
          when it can be patched: pick updates and give a reason, and it becomes a one-computer deployment that two
          approvers still approve on the approval signer. When it cannot be patched there is no button; the tab says why
          (for example, the standard agent) and what to do instead.{' '}
          <strong className="text-foreground">Patch policies</strong> on the Patching page are approved once, by two
          people on the approval signer, and then run inside their maintenance window: the canary first, the next ring
          only once the canary is confirmed effective. The approval signer, not this portal, signs each ring, and only if
          it stays inside the policy&apos;s computers, update classes, excluded KBs, window and expiry. Revoking one is
          one-way. Platform Admins see a pre-flight listing what a production
          install still lacks. Fixture-tested only so far. More in{' '}
          <Link href="/docs/patching-setup" className="underline text-foreground">Patching setup</Link> and{' '}
          <Link href="/docs/staged-patching" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.34, a deployment, an <em>Install updates</em> request and a patch policy each have a{' '}
          <strong className="text-foreground">restart rule</strong>: <em>Never restart</em> (the default) or{' '}
          <em>Restart if required, inside the window</em>. With the second, a computer that Windows says needs a restart
          after the install shows the same fixed warning as a scheduled restart and restarts 15 minutes later. It does not
          restart while a RustDesk session is open (or when it cannot tell), or if the restart would fall after the
          plan&apos;s window; then the deployment shows the restart as <em>deferred</em>, with why, and the update stays
          &ldquo;restart required&rdquo;. The approvers see and sign the rule, and a plan under a policy may never ask for
          more than the policy allows. After the restart a new scan confirms the update effective. The in-window restart
          has been tested against a simulated Windows only; it has not yet run on a real Windows computer. More in{' '}
          <Link href="/docs/staged-patching#restarting-after-updates" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.34, computers <strong className="text-foreground">sign their own patch results</strong> with a key
          they generate and never send. A policy names each computer&apos;s key, and the approval signer checks the
          canary&apos;s signed results and scan before it opens the next ring, so a result this portal altered or made
          up is refused. Every ring of a policy except the last needs computers running the 0.34 agent. Before approving
          a computer&apos;s first policy, compare the key fingerprint on the approval page with{' '}
          <code>rem0te-agent.exe status</code> on the computer. Policies approved before 0.34 can still run their
          canary, but no later ring. More in{' '}
          <Link href="/docs/staged-patching#signed-results-034" className="underline text-foreground">Signed results</Link>.
        </p>
        <p>
          From 0.31 the menu is organised by job: <strong className="text-foreground">Dashboard</strong>,{' '}
          <strong className="text-foreground">Devices</strong> (all devices, your own, adding one),{' '}
          <strong className="text-foreground">Alerts</strong>, <strong className="text-foreground">Automation</strong>,{' '}
          <strong className="text-foreground">Patching</strong>,{' '}
          <strong className="text-foreground">Remote Support</strong> (sessions, Quick Connect, support requests and the
          technician client), <strong className="text-foreground">Reports</strong> (0.32) and{' '}
          <strong className="text-foreground">Settings</strong>, which holds users, the audit log
          and platform administration. Help and the documentation are at the bottom of the menu.
        </p>
        <p>
          <Link href="/automation/scripts" className="underline text-foreground">Automation → Script library</Link> holds
          PowerShell scripts for one business, or global ones a Platform Admin writes. Every edit is a new version with its
          own SHA-256. A version goes from draft to review to approved or rejected, and someone other than everyone who
          wrote it must approve it, with a fresh sign-in. Before you approve, the page shows warnings for things like{' '}
          <code>Invoke-Expression</code>, downloads, encoded commands, credentials and disabling Defender. They&apos;re
          warnings, not a verdict. <strong className="text-foreground">Running a script (0.34)</strong>: on an approved
          version, <em>Run this version</em> first proposes it to the approval signer, where two approvers who didn&apos;t
          write it add its exact SHA-256 to the signer&apos;s own allowlist. Then you can request a run on up to 25 Windows
          computers, with typed arguments and a timeout of 1 to 30 minutes; two more approvers approve each run on the
          signer&apos;s page. The signed agent checks the hash before it runs anything, as SYSTEM, and each computer&apos;s
          Actions tab shows the exit code and the first 64 KB of output, redacted, for 90 days. Revoking is permanent.
          It has been tested with PowerShell 7 on Linux, <strong className="text-foreground">not yet on a real Windows
          computer</strong>. Writing needs <em>Write scripts</em>; reviewing, proposing and revoking need <em>Review
          scripts</em>; requesting a run also needs <em>Request approved actions</em>. More in{' '}
          <Link href="/docs/script-library" className="underline text-foreground">Script library</Link>.
        </p>
        <p>
          The <Link href="/dashboard" className="underline text-foreground">Dashboard</Link> (0.31) says what is broken,
          which businesses it affects, which devices need attention, what is already being worked on, and what to
          do next — only for what you can see. <strong className="text-foreground">Work on next</strong> is a ranked
          list and each item says why it is there: site outages, then critical alerts, actions whose outcome is
          unknown, failed actions, warnings, approval requests, restarts pending and info alerts, oldest first.
          Acknowledged alerts and alerts in a maintenance window are left out. <em>Patch compliance</em> counts only
          devices with an update scan under 36 hours old and shows the coverage beside it; with no such scan it says{' '}
          <em>No data</em>. Server health moved to Settings → System status. More in{' '}
          <Link href="/docs/technician-guide" className="underline text-foreground">Technician guide</Link>.
        </p>
        <p>
          <Link href="/reports" className="underline text-foreground">Reports</Link> (0.32) answer four questions from
          stored data, per business and site: <strong className="text-foreground">Patch compliance</strong> (the
          dashboard&apos;s definition; devices with a stale scan or none are coverage gaps, never counted as
          compliant), <strong className="text-foreground">Agent coverage</strong> (agent type and version, devices
          without a device secret, devices not heard from in a chosen number of days, non-Windows devices with no
          inventory), <strong className="text-foreground">Alert frequency</strong> over a period, with time to resolve,
          and <strong className="text-foreground">Offline time</strong>, measured from the Offline monitor&apos;s alerts
          because the online flag keeps no history. There is no availability percentage: which computers were
          monitored, and when, is not recorded. Each report shows only what you can already see and needs the
          permission of its data (View computers, or monitoring:alerts). <em>Export CSV</em> is capped at 10,000
          rows and recorded in the audit log before the file is sent. More in{' '}
          <Link href="/docs/reports" className="underline text-foreground">Reports</Link>.
        </p>
        <p>
          From 0.34 a report can be <Link href="/reports/schedules" className="underline text-foreground">scheduled</Link>:
          weekly or monthly (days 1–28), at a time in a time zone, emailed to confirmed addresses with a link and,
          optionally, the CSV — the same audited export, with the same row limit. It is computed with its owner&apos;s
          access when it is sent; if the owner has lost access, nothing of the report is sent, the recipients are told
          it did not come, and the schedule switches itself off. Each period is sent at most once, even across a restart.
          Outbound email is set up by a Platform Admin under{' '}
          <Link href="/settings/email" className="underline text-foreground">Settings → Email</Link>. Mail only ever
          goes to addresses whose owner clicked a confirmation link. See{' '}
          <Link href="/docs/email" className="underline text-foreground">Email and scheduled reports</Link>.
        </p>
        <p>
          From 0.28, writes can be <strong className="text-foreground">paused</strong> while an incident is looked at:
          approved actions, remote connections, agent updates and ClientSt0r jobs — and, from 0.34, outbound email — for every business or for one. A red
          strip at the top of the page says what is stopped and why; a refused click says <em>CONTAINED</em>. A Business
          Owner can suspend their own business, and only they can lift that. A pause set by the MSP is lifted by someone
          other than whoever set it, always with a fresh sign-in. The audit log is now tamper-evident: every entry is
          chained to the one before it and checked hourly. See{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Settings → Security → Containment</Link>{' '}
          and <Link href="/docs/containment" className="underline text-foreground">Containment</Link>.
        </p>
        <p>
          <strong className="text-foreground">What Connect does and does not control.</strong> Rem0te decides who may
          launch a session to which computer and records it; RustDesk carries the session. Once connected, clipboard,
          file transfer and RustDesk&apos;s in-session chat are RustDesk&apos;s own defaults (the Chat tab is separate), a computer installed by Rem0te accepts its password
          without asking the person at it, and nothing ends a session from the portal. <em>Client opened</em> is not a
          connection; <em>Connection confirmed</em> comes from the computer&apos;s agent or from you. Platform Admins,
          technician managers and Business Owners can see every control and its effective state under Settings →
          Security → Security Features. More in{' '}
          <Link href="/docs/security-model" className="underline text-foreground">Security model</Link>.
        </p>
        <p>
          Customers can ask for help through their business&apos;s support link, without an account. Requests appear
          under <Link href="/support-requests" className="underline text-foreground">Remote Support → Support requests</Link>: claim
          one, connect, and complete or hand it off.
        </p>
        <p>
          More in <Link href="/docs/technicians" className="underline text-foreground">MSP technicians</Link> and{' '}
          <Link href="/docs/support-requests" className="underline text-foreground">Support requests</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'software-deployment',
    title: 'Software deployment',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          From 0.34, <Link href="/automation/software" className="underline text-foreground">Automation → Software catalog</Link>{' '}
          holds the software Rem0te may install on Windows computers: winget packages, each pinned to one exact version,
          one installer SHA-256 and a <strong className="text-foreground">detection rule</strong> that says how a computer
          tells whether it is installed. A business&apos;s Business Owner keeps its own entries; a Platform Admin keeps the
          global ones. Every change needs a fresh sign-in and is recorded in the audit log with the hash and rule before and
          after. The hash comes from the package&apos;s installer manifest in the public winget-pkgs repository, which the
          server reads when you save, or is pasted by you and recorded as pasted.
        </p>
        <p>
          <strong className="text-foreground">The hash check.</strong> Nothing is uploaded to Rem0te and the portal serves no
          installer. Each computer downloads the installer with winget from winget&apos;s own source, hashes the downloaded
          file itself and refuses it — installing nothing — unless it matches the pinned SHA-256 and the hash in the manifest
          winget downloaded beside it. winget&apos;s own hash check then applies when it installs.{' '}
          <strong className="text-foreground">The gap that remains:</strong> the install step downloads the installer again,
          so the bytes actually installed are verified by winget against the source manifest, not hashed again by the agent.
        </p>
        <p>
          <strong className="text-foreground">Approval, canary and rings.</strong> Installing and uninstalling are always high
          risk: every plan needs two approvers on the approval signer with a passkey, you cannot approve your own request,
          and nothing in this portal can approve. Software plans are not offered to ClientSt0r. A deployment starts with one{' '}
          <em>canary</em> computer and then up to four rings of 25. The next ring can be requested only once the one before
          it has passed: the canary&apos;s detection rule must confirm the change (a canary that already had it proves
          nothing), failures must stay within the threshold you set, and the soak time must have passed. A deployment
          keeps the entry as it was; if the entry is changed or archived, no further ring is requested. Computers are never
          restarted. On one computer, the <em>Software</em> tab&apos;s <strong className="text-foreground">Managed software</strong>{' '}
          offers Install and Uninstall when the server allows them — a one-computer deployment, approved the same way — and
          otherwise says why not and what to do.
        </p>
        <p>
          <strong className="text-foreground">Detection rules and compliance.</strong> A rule is one of three kinds: a
          Programs and Features display name (exact or starting with), an uninstall registry key, or the version of a file
          under Program Files — each with a version that must be <em>at least</em> or <em>exactly</em> a value. The{' '}
          <Link href="/reports/software-compliance" className="underline text-foreground">Software compliance</Link> report
          counts each entry on each Windows computer it applies to as compliant, outdated, missing or unknown, from the
          newest evidence: the inventory&apos;s installed-software list (display-name rules only) or what the computer
          reported when a software plan ran there. Evidence older than the report&apos;s limit is unknown, never compliant.
        </p>
        <p>
          <strong className="text-foreground">When a computer refuses.</strong> A computer whose software is managed by
          Configuration Manager or Intune refuses software plans (<em>managed elsewhere</em>), and the portal stops offering
          them there. A computer without a usable winget — App Installer missing, or older than 1.7 — reports{' '}
          <em>winget unavailable</em> or <em>winget too old</em> and runs nothing; its Software tab then warns before the
          next request. Software plans need the signed agent and the approval signer.
        </p>
        <p>
          <strong className="text-foreground">None of this has run on real Windows yet.</strong> It has been tested against
          a simulated winget and simulated computers only. More in{' '}
          <Link href="/docs/software-deployment" className="underline text-foreground">Software deployment</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'sign-in-and-offboarding',
    title: 'Sign-in, Step-up and Offboarding',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Some actions — revealing a computer password (including a Connect that uses it), changing permissions,
          managing technicians, SSO and passkey changes — ask you to{' '}
          <strong className="text-foreground">confirm it&apos;s you</strong> with your password, an authenticator code
          or a passkey. If you have an authenticator, its code or a passkey is required — your password alone is not
          enough. It lasts 10 minutes for that sign-in.
        </p>
        <p>
          Making an install link, and creating any API key, always ask — for every role, and whatever the step-up
          settings say. A link puts a computer into a business, and a key keeps working after you sign out, so an
          unattended or stolen session must not be enough for either. API keys that already have the enrolment scope
          keep working: a key cannot confirm anything, and is itself the second proof.
        </p>
        <p>
          You can add passkeys and link a single sign-on provider from{' '}
          <Link href="/account" className="underline text-foreground">My Account</Link>. Password sign-in always remains
          available.
        </p>
        <p>
          When someone leaves, <strong className="text-foreground">Offboarding</strong> removes their access and lists
          which RustDesk passwords they had. Removing access does <strong className="text-foreground">not</strong>{' '}
          change a password someone already saw — rotate those computers&apos; credentials. A rotation stays pending until
          the computer checks in and confirms it.
        </p>
        <p>
          More in <Link href="/docs/sign-in" className="underline text-foreground">Sign-in</Link> and{' '}
          <Link href="/docs/offboarding" className="underline text-foreground">Offboarding</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'public-address',
    title: "The Server's Public Address",
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          The address people use to reach this server, such as <code className="text-foreground">https://remote.example.com</code>.
          Support links, sign-in redirects, passkeys, launcher links and installer downloads are all built from it. A
          Platform Admin sets it in{' '}
          <Link href="/settings" className="underline text-foreground">Settings → General → Public address</Link>; until
          then the server uses <code className="text-foreground">FRONTEND_URL</code> from its environment file.
        </p>
        <p>
          Saving checks that the address really leads back to this server. Changing the host name stops existing
          passkeys working (unless <code className="text-foreground">WEBAUTHN_RP_ID</code> is set) and means updating the
          redirect URI at each SSO provider. Enrolled computers are not affected.
        </p>
        <p>
          More in <Link href="/docs/setup#public-address" className="underline text-foreground">Setup → Public address</Link>.
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
            <Link href="/quick-connect" className="underline text-foreground">Remote Support → Quick Connect</Link>{' '}
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
      <PageHeader title="Help &amp; Docs" description="Quick answers here; the full guides are in the documentation.">
        <div className="flex items-center gap-2">
          <Link href="/docs" className="text-xs font-medium text-primary hover:underline">Full documentation</Link>
          <span className="text-xs text-muted-foreground">·</span>
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
