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
    title: 'How RustDesk connections work',
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
    id: 'remote-access-readiness',
    title: 'Remote Access Readiness (Managed Secure Access)',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">Off unless this server switches it on (MSA_GRANTS), and lab-tested only.</strong>{' '}
          Managed Secure Access is a way of connecting in which the signed agent applies a short-lived, per-session
          RustDesk password and settings, and reads them back, instead of a standing permanent password. It has run only
          in the Windows lab (Windows Server, as SYSTEM): never on a Windows 10 or 11 desktop, and never on the fleet.
          With the switch off, every device connects exactly as before and nothing below appears.
        </p>
        <p>
          <strong className="text-foreground">Connect on a managed device (0.73).</strong> On a device that is Managed and
          verified, Connect asks the launch policy (your role, presets, view-only and consent rules, schedules, pauses) and
          turns its answer into a signed session grant; nothing you choose can widen it. The page then waits — up to 60
          seconds — for the device&apos;s agent to report the grant applied and every setting read back, and only then
          downloads the Connect script, which carries a one-time password and works once. If the agent is not reachable,
          cannot enforce the settings, or does not apply the grant in time, Connect is refused with the reason: it never
          falls back to a permanent password. A preset&apos;s view-only and consent rules, which a Legacy device cannot
          enforce, are enforced by RustDesk itself here. The signed agent must be 0.73.0 or later.
        </p>
        <p>
          <strong className="text-foreground">What a session can allow.</strong> Interactive control with clipboard, file
          transfer and audio, as the policy allows — never a TCP tunnel and never a remote restart. That limit is compiled
          into the signed agent, so the portal cannot raise it.
        </p>
        <p>
          <strong className="text-foreground">Sessions and Disconnect.</strong> The device&apos;s page lists its managed
          sessions with a timeline: Requested, Authorized, Received, Applied, Launched (the password was handed over —
          not a connection), Connected (the agent saw RustDesk accept one), then Disconnected, Expired, Revoked or Failed.
          The agent cannot see who is at the other end, whether the person at the device accepted the consent prompt, or
          what happened inside the session, and the timeline says so.{' '}
          <Link href="/endpoints/managed-sessions" className="underline text-foreground">Remote support → Managed sessions</Link>{' '}
          lists every live session you can see. Disconnect sends the device a signed revocation that ends the session;
          you can always end your own, and someone who can edit the device can end anyone&apos;s. A device that is
          offline cannot be told, so its session still ends at its time limit. A pause of remote connections ends live
          sessions the same way.
        </p>
        <p>
          <strong className="text-foreground">Moving devices (Platform Admin).</strong> One device at a time from its
          page, or a device group or customer as a cutover run on Remote access readiness: a canary first, which must
          become Managed and verified before anything else moves, then one batch per Advance. Nothing moves by itself, and
          a run can be halted or rolled back.
        </p>
        <p>
          <strong className="text-foreground">Readiness.</strong> Every 6 hours, or when RustDesk changes, the signed
          Windows agent reads the installed RustDesk: where it is installed, its version and build, whether its service is
          running, and whether its command line answers eleven read-only questions about its settings. That check never
          changes a setting.
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong className="text-foreground">Compatible</strong>: could be managed. It is not managed until a Platform Admin moves it.</li>
          <li><strong className="text-foreground">Upgrade available</strong>: would be compatible after the signed agent or RustDesk is updated. RustDesk older than 1.4.1 is &ldquo;not lab-tested&rdquo;, not known to be broken.</li>
          <li><strong className="text-foreground">Unsupported</strong>: Linux, macOS, the standard agent, or a Sciter build of RustDesk.</li>
          <li><strong className="text-foreground">Unknown</strong>: no current report (offline, not reported yet, over 7 days old, or a check did not answer).</li>
        </ul>
        <p>
          Each device&apos;s state is on its page (Overview), and every device&apos;s on{' '}
          <Link href="/endpoints/remote-readiness" className="underline text-foreground">Remote support → Remote access readiness</Link>.
          Reports appear once a device&apos;s signed agent has updated under the usual automatic update policy.
          More: <Link href="/docs/managed-secure-access" className="underline text-foreground">Managed Secure Access</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'server-setup',
    title: 'Setting up the RustDesk server',
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
            <strong className="text-foreground">Relay host</strong> — the hostname or IP address
            clients use to reach this server. Must be reachable from the internet if you have
            remote devices.
          </li>
          <li>
            <strong className="text-foreground">Public key</strong> — optional but recommended.
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
            Settings → Network / ports
          </Link>{' '}
          for the full list.
        </p>
        <p>
          How big a server to use for 50, 250, 1,000 or 5,000 devices — CPU, memory, disk and PostgreSQL, with the
          measured cost of a heartbeat and how fast the database grows — is in{' '}
          <Link href="/docs/server-sizing" className="underline text-foreground">Server sizing</Link>. In short: 2 vCPU
          and 2–4 GB up to a few hundred devices, 4 vCPU and 8 GB for 1,000, 8 vCPU and 16 GB for 5,000. Since 0.34 a
          heartbeat no longer starts a process to ask the RustDesk ID server about the device, and one API process
          measured roughly twice the rate 5,000 devices need; more than 5,000 has not been measured.
        </p>
        <p>
          From 0.34 old history ages out of the database on its own: finished agent commands and diagnostics after 90
          days, inventory changes and resolved alerts after 400, unused launch tokens 30 days after they expire. Remote
          sessions are kept, and the audit log is never pruned. Each window is a <code>RETENTION_*_DAYS</code> setting in
          the server&apos;s environment, with a floor and a ceiling; <code>RETENTION_SWEEP=off</code> stops the sweep.
          What each table holds now is on{' '}
          <Link href="/admin/status" className="underline text-foreground">Administration → System status</Link> (Platform
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
              is enrolled into a customer. You can connect without asking for the ID each time, and
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
          (the <strong className="text-foreground">Add device</strong> link under Devices in the menu, or the button on the
          Devices page). One page takes you through it:
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Choose the customer, then a site or none, and who may connect. These are fixed into the link: the machine cannot pick another customer or site.</li>
          <li>Choose the operating system. Windows gets the Rem0te agent; Linux and macOS (run with sudo) get a read-only agent that reports inventory and pending updates.</li>
          <li>Make the install command. If a Platform Admin set <em>Install links</em> to Ask, you confirm it&apos;s you first; your choices are kept while you do.</li>
          <li>
            Install it, from one of two tabs. <strong className="text-foreground">Download installer</strong>: on Windows
            a <strong className="text-foreground">Download .exe</strong> button (run it on the machine and accept the
            administrator prompt), with the same link to copy and send; on Linux and macOS the install script as a file,
            run with <code>sudo bash</code>. <strong className="text-foreground">Command</strong>: the one-line command to
            paste. Either way it works once, expires in 24 hours, and is shown only once; downloading does not use it up.
            On Windows there is also <strong className="text-foreground">Download .msi</strong>, a Windows Installer
            package with the token in it, and the silent line <code>msiexec /i rem0te.msi TOKEN=… /qn</code> to copy. It
            installs the same signed agent as SYSTEM, needs this server to publish the signed agent, and uninstalling it
            leaves the agent in place. It has never been run on real Windows. There is no .pkg. For Group Policy or
            Intune, use a deployment key (below) as the TOKEN.
          </li>
          <li>Keep the page open. It checks every few seconds and says the device enrolled only when it has.</li>
          <li>It then shows the first health the server has received: online, the agent and its version, and whether the first inventory has arrived. Anything not yet received says so.</li>
          <li>Open the device, or the customer&apos;s monitoring policies, from the last step.</li>
        </ol>
        <p>
          An unused link can be revoked from the waiting step. For a machine that already runs
          RustDesk and only needs listing, without the agent, use{' '}
          <Link href="/endpoints/new" className="underline text-foreground">Register by RustDesk ID</Link>.
        </p>
        <p className="pt-1 font-medium text-foreground">Many devices at once (Platform Admins)</p>
        <p>
          <Link href="/admin/deploy" className="underline text-foreground">Devices → Deploy agents</Link>{' '}
          makes a deployment key: one key for many devices, for a customer, with a use limit and an expiry of at
          most 90 days, shown once. The page gives ready-to-paste instructions for Group Policy, Intune, an existing
          RMM, the Windows Installer package (.msi, with the key as TOKEN), Linux and macOS, with the key filled in by
          your browser. By default each device then waits under{' '}
          <Link href="/admin/unassigned" className="underline text-foreground">Devices → Unassigned</Link>, where you
          can inspect it and assign it (one or many) to a customer, site and groups. Until it is assigned, nobody in a
          customer can see it and nothing can connect to it or act on it. Assignment rules (deployment key, domain,
          address range, hostname prefix) only suggest a customer; they never assign one by themselves, and never use
          who is signed in.
        </p>
      </div>
    ),
  },
  {
    id: 'installing-permanently',
    title: 'Installing RustDesk permanently on a device',
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
              Quick start → Step 1
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
          with everything the sidebar holds. The customer switcher, Help and your profile menu (theme, Sign out) stay in
          the top bar. Choosing a page closes
          it, as do <strong className="text-foreground">Esc</strong>, tapping outside it and its close button.
        </p>
        <p>
          Wide tables — the device list, the reports, API keys — scroll sideways inside their own box instead of
          widening the page, so swipe the table rather than the page. A device&apos;s tab groups and tabs scroll the same way.
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
          Mac) from anywhere — searches devices, customers, sites, people, open alerts, scripts, patch policies and
          automation schedules at once, and the console&apos;s pages by name. Before you type it offers your recent items
          and quick actions. Type at least two characters; the arrow keys move through the results, Enter opens one, Esc
          closes the box. Each group shows only what its own list page would show you.
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong className="text-foreground">Devices</strong> match by name, hostname, RustDesk ID, serial number,
            signed-in user, IP address, a network adapter&apos;s IPv4 address or alias. A result says which of those
            matched. Archived devices are not included, as in the device list.
          </li>
          <li>
            <strong className="text-foreground">Customers</strong> by name, code, email or city;{' '}
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
          the same rules as its own page: devices need <em>View devices</em> and show only the devices you can see
          (for a Business User, the ones assigned to you or shared company-wide; for a technician, the ones your
          assignment names); sites need <em>View devices</em>; people need <em>View business users</em>; alerts need{' '}
          <em>See and work alerts</em>. A group you have no permission for is left out, not shown as empty. Another
          customer&apos;s device is not found even by its exact hostname or RustDesk ID.
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
    title: 'The device list',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          <Link href="/endpoints" className="underline text-foreground">Devices</Link> lists every device you can
          see — online ones first, then by name. Search, filters, sorting and paging all run on the server, so they
          cover every device, not just the page on screen. Click a column heading to sort by it.
        </p>
        <p>
          <strong className="text-foreground">Green, amber, grey (0.35).</strong> A green dot means the agent is
          checking in. Amber, <em>Reachable (RustDesk) · agent silent 12 d</em>, means the RustDesk server can still
          reach the device — remote control should work — but its agent has not checked in for 30 minutes or more,
          so monitoring, patching and actions are not reporting; try <strong className="text-foreground">Update
          agent</strong> on its Agent card. Grey is offline. The Online filter has all three, the dashboard counts
          agent-silent devices apart from online ones, and the CSV has a Connectivity column. On a phone the
          filters sit behind a <strong className="text-foreground">Filters (n)</strong> button. To be alerted
          when an agent goes silent, add the <em>Agent silent</em> monitor in Monitoring → Monitoring policies (<em>Add recommended</em> includes it).
        </p>
        <p>
          <strong className="text-foreground">Health</strong> is the worst open monitoring alert, in words (0.68):
          Issues for a critical alert, Warning for a warning, Healthy for none (or informational ones only), and
          Unknown when there is no warning or critical alert but the agent is not reporting, since a silent agent
          raises nothing;{' '}
          <strong className="text-foreground">Pending patches</strong> comes from the last update scan; CPU, RAM,
          disk and the logged-in user come from the last heartbeat. Each shows its age, and a value that is stale —
          a resource sample older than 15 minutes, an update scan older than 36 hours — is greyed: it is what the
          device last reported, not what it is doing now. Click a Health label to open that device&apos;s Monitoring tab; Clear, beside Warning or Issues, resolves its open alerts until the next check raises whatever is still wrong. Health and alerts need the monitoring:alerts permission.
        </p>
        <p>
          <strong className="text-foreground">Narrower windows show fewer columns (0.47.1, 0.48.1).</strong> So the
          list fits beside the sidebar without scrolling sideways, each of these columns appears only when the window is
          wide enough for it: Last seen from 1440 pixels, Agent from 1536, OS from 1700, Site from 1860 and Logged-in
          user from 2000, so a 1920-pixel screen shows everything but Logged-in user. The column picker shows each
          one&apos;s width, a column you chose is only hidden while the window is narrower, and the dot beside each
          name still shows whether it is online. Alerts is off by
          default, because Health already shows the worst open alert. Device names never wrap, long customer and site
          names are cut short with the full name on hover, and Connect stays on the right.
        </p>
        <p>
          <strong className="text-foreground">Columns</strong> and row density are remembered in this browser.{' '}
          <strong className="text-foreground">Views</strong> save the current filters, sort, columns and density
          under a name, on your account. A view is personal, or shared with everyone in one customer — sharing is
          for a Business Owner, a technician with computers:edit over the whole customer, or the MSP, and is
          audited. A view stores only the list&apos;s parameters, so opening one shows each person only the devices
          they can see. <strong className="text-foreground">Export CSV</strong> downloads the whole filtered view
          (up to 10,000 devices), contains only what you can see, and is recorded in the audit log.
        </p>
        <p>
          <strong className="text-foreground">Device groups</strong> (Views → Device groups…) are named groups of one
          customer&apos;s devices, for filtering and bulk actions. A device can be in several groups of its
          customer — adding it to one never takes it out of another — and the Groups column lists them all. A device
          moved to another customer leaves the old customer&apos;s groups. Groups grant nothing. They are managed by the
          same people who may share views, and every change is audited.
        </p>
        <p>
          A <strong className="text-foreground">rule group</strong> (Views → Save filters as a rule group…) holds
          whichever devices of its customer match the current filters — online, platform, site, tag, updates,
          alerts, RustDesk version range, last seen (More filters) — worked out each time it is read, so a device
          that goes offline (or whose agent goes silent) leaves an &ldquo;online&rdquo; group at once. Nobody adds to it by hand. Everyone sees only
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
    title: 'Connecting to a device',
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
            If the connection uses the device&apos;s password, you are asked to confirm it&apos;s you first (once
            every 10 minutes). The password goes into the file below and nowhere else.
          </li>
          <li>
            Your browser downloads a small file named for that machine. Run it. It uses the
            RustDesk already on your own computer — or fetches a portable copy once — points it at
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
          <em>&ldquo;the target device is offline or does not exist&rdquo;</em> about a device
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
    title: 'Chatting with the person at a device',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Open a device and choose the <strong className="text-foreground">Chat</strong> tab. <strong className="text-foreground">Start chat</strong>{' '}
          puts a badge on the Rem0te icon in the device&apos;s notification area. The chat opens in a small window,
          titled with the customer name and headed with your name, saying the customer will never ask for a password and
          that links are never opened. A device on the signed agent picks the chat up at its next check-in, normally
          within three minutes. A standard agent&apos;s tray asks within ten. After that, messages arrive within seconds.
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-foreground">Windows only, with either agent.</strong> Linux and macOS cannot chat,
            and the tab says so for those devices. A standard agent needs its installer re-run from this version so that
            its tray is installed. The tray has not yet been run on real Windows.
          </li>
          <li>
            The person can also <strong className="text-foreground">start a chat from the tray</strong>. It appears as open
            on the Chat tab and as a request in the support queue.
          </li>
          <li>
            Each message shows <em>Sent</em>, <em>Delivered</em>, <em>Shown</em> or <em>Read</em>, and only what the device
            has confirmed. The panel also says what the device last reported.
          </li>
          <li>
            <strong className="text-foreground">Recording</strong> is set per customer, under{' '}
            <em>Settings → General → Chat recording</em>. Changing it asks you to confirm it is you, and the change is
            audited. Each chat says whether it is recorded. In a chat that is not recorded, each message is deleted from
            the server once both sides have it, and anything left is deleted when the chat ends.
          </li>
          <li>
            Up to 2,000 characters a message and 20 messages a minute. Text is shown as plain text on both sides.
          </li>
          <li>
            <strong className="text-foreground">Emoji, files and pictures.</strong> Both sides have an emoji picker
            and can send a file with the paperclip, or by pasting. Each file can be up to 10 MB, with up to 20 files
            (50 MB) in a chat. PNG, JPEG, GIF and WebP pictures are shown in the chat. Whether a file counts as a
            picture is decided by its contents, not its name. Every other file is offered only as a download and is
            never opened in the browser. Anyone who can read the transcript can open its files. A{' '}
            <em>remote connections</em> pause stops files too. In a chat that is not recorded, files are deleted when
            the chat ends.
          </li>
          <li>
            <strong className="text-foreground">New messages reach you anywhere in the console.</strong> The chat icon
            in the header counts unread replies and lists the open chats. A new reply shows a notification with the
            device&apos;s name and an <em>Open</em> button, and the tab title shows the count. A sound can be
            switched on in that panel. Read marks are your own.
          </li>
          <li>
            Starting and writing need the <em>Chat with the person at a device</em> permission. Anyone who can see the
            device can read a recorded transcript, which is deleted 400 days after the chat ends. A{' '}
            <em>remote connections</em> containment pause stops new chats and messages. The audit log records each start
            and end, never the text.
          </li>
        </ul>
        <p>
          See <Link href="/docs/chat" className="underline text-foreground">Chat</Link> and{' '}
          <Link href="/docs/tray" className="underline text-foreground">The tray icon</Link> for the details.
        </p>
      </div>
    ),
  },
  {
    id: 'tray',
    title: 'The tray icon on Windows devices',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Every managed Windows device has a Rem0te icon in the notification area for each person signed in. Its menu
          has four items: <em>Chat with support</em>, <em>Open a support request</em>, <em>Self-help tools</em> and{' '}
          <em>About</em>. <em>Open a support request</em> appears only when the customer, or the platform default, has
          a PSA / ticketing connector switched on.
        </p>
        <p>
          The menu starts with who the device is for (0.53.1): the customer&apos;s name, <em>supported by</em> your
          account&apos;s name, and the support phone and e-mail from your branding, as lines that cannot be clicked.
          The chat item, the tooltip, the chat window&apos;s title and the tray&apos;s messages use the same names. All of
          them come from the portal&apos;s records. Anything not set is left out, and the tray says <em>support</em> or{' '}
          <em>your IT provider</em> instead. The tray remembers the last names per Windows account and shows them until
          the portal answers.
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-foreground">Support requests</strong> from the tray become a ticket in your PSA
            (the person is shown its reference) and also arrive in the support queue, already linked to the device.
            The screenshot and usage stay in Rem0te; the ticket links to them. A <em>notifications</em> containment pause
            stops them. The person may attach their resource usage and a screenshot; both are off until they tick
            them. Attachments are shown only to someone who can see the device, and are deleted after 45
            days.
          </li>
          <li>
            <strong className="text-foreground">Self-help tools:</strong> check DNS, test the connection and show
            network details, with either agent. Flush DNS, renew the IP address and restart the remote support service
            run as the system, so they are available on the signed agent only, and an <em>actions</em> containment pause
            stops them. Each run is listed on the device&apos;s <em>History</em> tab under <em>Tray</em>.
          </li>
          <li>
            On a standard agent, the Windows account the tray reports is not proven. Treat the name on a chat or a
            request from a standard device as what the device said.
          </li>
          <li>
            <strong className="text-foreground">The icon</strong> (0.51) is a white speech bubble on a navy disc inside a
            bright ring: cyan normally, green while a chat is open, amber with a red dot for an unread message, and grey
            when the portal cannot be reached. It follows the light or dark taskbar.
          </li>
          <li>Not yet run on real Windows. Linux and macOS have no tray.</li>
        </ul>
        <p>
          See <Link href="/docs/tray" className="underline text-foreground">The tray icon</Link> for the details.
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
          Want to look at the device rather than connect to it? Add a second action
          with <code className="text-foreground">&amp;action=open</code> on the end —
          that lands on the device&apos;s page in Rem0te instead.
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
          already have and only reaches devices you can already see. If you are not
          signed in, Rem0te asks, then carries on to the device. There is
          deliberately no key in that address: a URL Action is visible to everyone in
          TRMM who can right-click an agent.
        </p>
        <p className="font-medium text-foreground">If two devices have the same name</p>
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
          A managed device&apos;s page shows what it has reported about itself:
          hardware, storage, network adapters, who is signed in, how long it has been
          up, and how many Windows updates it is waiting on. Open it from{' '}
          <Link href="/endpoints" className="underline text-foreground">Devices</Link> and
          look at the <strong className="text-foreground">Overview</strong> tab.
        </p>
        <p className="font-medium text-foreground">The device page</p>
        <p>
          The top of the page says whether the device is online (or offline since
          when, or — in amber — reachable through RustDesk with its agent silent), its customer and site, and when its agent last checked in, marked
          stale when it has missed check-ins. From 0.35 the Overview&apos;s Assignment card lists every group it is
          in, static and rule, each a link to the list filtered by it. Restart and update wording names the
          device&apos;s own system: a Linux server&apos;s restart comes from its package manager, not Windows. The strip under it lists what needs
          attention: open alerts, a pending restart, pending updates with the age of
          the scan, and which agent it runs. Each opens the tab that explains it.
          Connect, Tools, Diagnose, Run action and Patch sit beside it; Archive and the other
          rare actions are under More, each with a confirmation. The tabs are
          Overview, Performance, Monitoring, Software, Processes, Services, Network, Patches, Event logs,
          Diagnostics, Actions, Terminal (Windows, 0.77), Files (Windows, 0.78) and History (sessions, notes, the AI-written summary and who
          can connect), and
          each can be linked with <code>?tab=</code>.
        </p>
        <p className="font-medium text-foreground">Tools (0.75)</p>
        <p>
          <strong className="text-foreground">Tools</strong>, beside Connect, lists what can be done to the device in
          nine groups — Diagnostics, Terminal and files, PowerShell / Scripts, Services &amp; Processes, Software, Windows
          Updates, Networking, Security and Maintenance — and opens the flow that already does each one: a Diagnostics check
          with its row marked, an approved action already picked on Actions, the Services, Processes, Network,
          Software or Patches tab, the Security log on Event logs, or the script library. Nothing runs from the
          panel; the tab&apos;s own button and confirmation do that, and the server checks your access, containment
          and the approval signer again.
        </p>
        <p>
          Each tool says whether it can work here: <em>Available</em>, <em>Needs approval</em> (two approvers on the
          approval page; in direct mode it is signed when you ask, after a fresh sign-in), <em>Needs a newer
          agent</em> (including the standard agent, where an action needs the full agent), <em>Unsupported here</em>{' '}
          (Linux, macOS, RustDesk only), <em>Paused</em> (containment), <em>Not reporting</em> (the request waits for
          a check-in), <em>Not permitted</em> (shown without a button), <em>Not set up</em> (no approval signer) or{' '}
          <em>Unavailable</em> (archived, not enrolled, unassigned). Flush DNS / renew DHCP is listed as{' '}
          <em>Coming later</em>: no approved action does it yet. Since 0.76 the Security, Networking and Maintenance
          groups also list the read-only palette checks below, each opening its row on Diagnostics.
        </p>
        <p className="font-medium text-foreground">Terminal (0.77, Platform Admins)</p>
        <p>
          The <strong className="text-foreground">Terminal</strong> tab opens a cmd or PowerShell prompt on a Windows
          device running the signed agent 0.77 or later, with no screen sharing and nothing shown on its screen. It
          runs as <strong className="text-foreground">SYSTEM — full control of this device</strong>, so only a
          Platform Admin can open one; a Business Owner cannot, and no grant gives it. You give a reason and confirm it
          is you (on by default for this one function). The device reaches out for it on its next heartbeat, so the
          prompt can take up to about three minutes to appear; after that, typing is close to live. A session ends
          after 15 minutes without your input and 60 minutes in all, whatever happens; reading the output or
          reloading the page does not extend it. The technician, a Platform Admin or the customer&apos;s own member
          with Edit devices can end it, and a <em>remote</em> containment pause ends it. The audit log records who,
          why, how long and how many bytes, never what was typed or shown; transcripts are kept only if a Platform
          Admin turned them on for the customer. More in{' '}
          <Link href="/docs/remote-terminal" className="underline text-foreground">Background terminal</Link>.
        </p>
        <p className="font-medium text-foreground">Files (0.78, Platform Admins)</p>
        <p>
          The <strong className="text-foreground">Files</strong> tab sends a file to a Windows device running the
          signed agent 0.78 or later, or fetches one from it, with no screen sharing. The agent reads and writes as{' '}
          <strong className="text-foreground">SYSTEM — full control of this device</strong>, so only a Platform Admin
          can do either, and sending and fetching are separate permissions. Give an absolute local path
          (<code>C:\…</code>; no network paths, <code>..</code>, links or junctions) and a reason. An existing file
          is never replaced unless you tick it. Your browser hashes the file (SHA-256) and the agent checks the hash
          before the file is put in place; a fetched file is checked in your browser before you can save it. A
          transfer starts at the device&apos;s next heartbeat (up to about three minutes), moves through this tab
          (keep it open), and ends after 10 minutes without progress or 60 in all. Up to 100 MB by default; a
          Platform Admin can set a customer up to 2 GB. The audit log records the path, size and hash, never the
          content, and the server keeps no copy. More in{' '}
          <Link href="/docs/file-transfer" className="underline text-foreground">Background file transfer</Link>.
        </p>
        <p className="font-medium text-foreground">Nothing here is live</p>
        <p>
          Apart from the Terminal and Files, Rem0te has no channel to reach into a device. Everything on that tab arrived
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
          no samples arrived, because the device was offline or its agent was not reporting — and nothing is drawn
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
          device for a page of one Windows log — Application, System, Security, Setup
          or Windows PowerShell. Pick a time range, the levels and how many of the most
          recent events you want; the table fills in when the machine answers, up to
          three minutes later. If it is offline the request waits half an hour and then
          expires.
        </p>
        <p>
          Reading event logs is a separate permission from viewing devices, because a
          machine&apos;s Security log is a different kind of access from its name and an
          online dot. A Business Owner has it; a Business User is granted it under{' '}
          <Link href="/users" className="underline text-foreground">Users</Link>. Every
          request is recorded in the audit log with the log name, the window and who
          asked.
        </p>
        <p className="font-medium text-foreground">One-click diagnostics</p>
        <p>
          A Windows device&apos;s <strong className="text-foreground">Diagnostics</strong> list
          has nine read-only checks — disk space, service health, recent system errors, top
          processes, network connectivity, DNS, pending updates, reboot status and a fresh
          inventory. Press <strong className="text-foreground">Run</strong>: the device picks the
          request up on its next heartbeat, runs the fixed check its agent carries, and the result
          appears with its age. Nothing on the device is changed and nothing you type reaches it —
          there is nothing to type. If the device does not check in within fifteen minutes the run
          expires and says so. <em>Recent system errors</em> needs the event-log permission; every
          other check needs only to see the device. Every run is in the audit log. More in{' '}
          <Link href="/docs/diagnostics" className="underline text-foreground">One-click diagnostics</Link>.
        </p>
        <p className="font-medium text-foreground">Security, networking and maintenance checks (0.76)</p>
        <p>
          The list is grouped into <strong className="text-foreground">Security</strong> (Microsoft Defender,
          Windows Firewall, BitLocker, Secure Boot and TPM, local administrators, and whether this Windows build
          still gets security updates), <strong className="text-foreground">Networking</strong> (a DNS lookup, a TCP
          port test and the routing table, beside the older connectivity and DNS checks),{' '}
          <strong className="text-foreground">Maintenance</strong> (time sync, activation, unexpected shutdowns,
          scheduled tasks and who is signed in, beside pending updates and reboot status) and General.{' '}
          <strong className="text-foreground">Run all security checks</strong> queues every security check you may
          run, one request each. Every check only reads: no recovery key, product key or the command a task runs is
          ever collected.
        </p>
        <p>
          Each result is read for you as <em>Healthy</em>, <em>Warning</em>, <em>Critical</em>, <em>Unknown</em> or{' '}
          <em>Unsupported</em>, finding by finding, with the worst one as the check&apos;s. <em>Unknown</em> means it
          could not be read and is never shown as healthy. The Windows support row is worked out on the server from
          the last inventory and a table of end-of-servicing dates; nothing is sent to the device, and a table more
          than a year old says <em>Unknown</em> rather than <em>Supported</em>.
        </p>
        <p>
          <em>DNS lookup</em> takes a host name, and <em>TCP port test</em> a host, a port and a timeout of 1, 2, 3, 5
          or 10 seconds: letters, digits, hyphens and dots only, checked here, again on the server and again on the
          device. They make the device reach a host you name, so they need the <em>Remote connect</em> permission. The
          new checks need agent 0.76.0 or later; an older agent shows <em>Needs a newer agent</em> and no Run. They
          are marked <em>Tested only on GitHub&rsquo;s Windows Server runner</em>: they have run on Windows Server in the lab, not yet on a Windows
          desktop or a customer&apos;s device.
        </p>
        <p className="font-medium text-foreground">Processes, Services and Network</p>
        <p>
          These three tabs list every running process (with its user and start time), every
          service (with its start mode and the account it runs as) and every network connection
          (addresses, gateway, DNS, DHCP and MAC). Each is a snapshot: it says when it was taken
          and how old it is, and <strong className="text-foreground">Refresh</strong> asks the
          device for a new one on its next heartbeat, exactly like a diagnostic. Command lines
          and file paths are never collected. There are no end-task, stop or start buttons —
          restarting a service is a signed maintenance action on the Actions tab. Windows devices
          with the standard agent only; the Linux agent does not collect them. More in{' '}
          <Link href="/docs/diagnostics#the-processes-services-and-network-tabs" className="underline text-foreground">One-click diagnostics</Link>.
        </p>
        <p>
          Since 0.35 the server also takes them on its own: every 6 hours, and every 5 minutes
          while you have the tab open, on the device&apos;s own check-in. The tab updates itself —
          no reload — and says when the next automatic refresh is due. When nothing can arrive it
          says why: the agent has not checked in (even if RustDesk can still reach the device),
          the agent is older than 0.33, the device is not Windows, or automatic snapshots are
          off. A Platform Admin sets the intervals in Settings → Monitoring &amp; API. See{' '}
          <Link href="/docs/diagnostics#automatic-snapshots" className="underline text-foreground">Automatic snapshots</Link>.
        </p>
        <p className="font-medium text-foreground">The AI-written summary</p>
        <p>
          <em>History</em> ends with an <strong className="text-foreground">AI-written summary</strong> of the
          device&apos;s notes and remote sessions. Rem0te holds no AI provider key: from 0.34 the summary is written by
          ClientSt0r&apos;s AI, through the same signed connection as ticket analysis, for the ClientSt0r organization
          the customer is mapped to. <strong className="text-foreground">What is sent to ClientSt0r</strong> lists every
          field, what is never sent (the device&apos;s name and hostname, the customer, addresses, who wrote a note,
          the RustDesk ID) and how many passwords, tokens, e-mail and IP addresses were removed first; <em>Show the
          exact text</em> shows it word for word. Generating one needs Rename/edit devices and Ticket analysis
          (ClientSt0r); every request is in the audit log, without the text, and an integration pause stops it.
        </p>
        <p>
          ClientSt0r does not offer this yet: the panel says <em>Needs ClientSt0r support for
          device_timeline_v1</em> and the button stays off until ClientSt0r advertises it. A summary already written
          can still be edited by hand. More in{' '}
          <Link href="/docs/integration-clientst0r#the-device-pages-ai-summary-034" className="underline text-foreground">ClientSt0r integration</Link>.
        </p>
        <p className="font-medium text-foreground">If a device reports nothing</p>
        <p>
          Re-run the managed installer on it. The agent that collects all of this is
          written to disk at install time, so a machine runs whatever version its last
          install left behind — and anything enrolled before per-device secrets existed
          is not trusted to report at all. The Overview tab says which of the two is
          the case.
        </p>
        <p className="font-medium text-foreground">If a device went offline after an update</p>
        <p>
          Its installer re-ran and it is now calling in with a new device secret, which
          the server refuses. The Overview tab shows the address those heartbeats come
          from. If that address is right, press <strong>Accept this device</strong> and
          the device reports in on its next heartbeat. Accepting also adopts the new
          RustDesk password the reinstall reported, so Connect keeps working. If it is not calling in at
          all, an installer from before 0.19.2 left its heartbeat script unreadable:
          re-run the installer on the machine itself, since <strong>Update</strong>{' '}
          cannot reach it, then accept it as above. A device archived by mistake
          comes back with <strong>Restore</strong> on the same page.
        </p>
        <p className="font-medium text-foreground">Reinstalling a device that is already here (0.48.2)</p>
        <p>
          Update agent and Reinstall agent at next check-in wait for the agent to check in, so they cannot reach a device whose
          agent stopped, was removed or was rebuilt. Use <strong>More → Reinstall manually (download link)…</strong> on the
          device (or the line under its buttons when it is not checking in, or the row&apos;s menu in Devices). It opens Add
          device bound to that device, with its current access filled in. Run the download on that device as an
          administrator: it re-attaches to the same record and keeps history, site, groups and settings. The link works once
          and expires after 24 hours.
        </p>
        <p className="font-medium text-foreground">Updating or upgrading a device&apos;s agent</p>
        <p>
          From 0.34 the <strong>Agent</strong> card on a device&apos;s Overview tab says which agent it runs, its
          version and whether that is current, its update channel and the portal&apos;s update mode.{' '}
          <strong>Update agent</strong> re-runs the current installer on a standard agent (the same as Reinstall
          agent); on a signed agent it is <strong>Check for update now</strong>, which installs only what the signed
          repository lists. Linux and macOS agents act on nothing the console sends, so the card gives the command to
          re-run on the device. <strong>Upgrade to full agent</strong> moves one Windows device to the full
          agent (the signed agent) at its next check-in, after a reason and a fresh sign-in. From 0.37 the same
          buttons sit at the top of the device&apos;s page for anyone with computers:edit, beside Connect, and the
          <strong> Agent out of date</strong> chip opens them. On every standard Windows agent Upgrade to full agent is
          always a button: when it can&apos;t be used it is greyed out with the reason beside it, such as a signed release
          that has not been published yet, what to do, and a link to Devices → Full agent. While a request is open it
          says where it is (0.50.2): <strong>waiting for check-in</strong>, <strong>on hold</strong>,{' '}
          <strong>handed out — installing</strong>, <strong>downloaded</strong> (waiting for the full agent to report), or{' '}
          <strong>not confirmed</strong> (handed out over two hours ago with no full agent reporting: check the device). From 0.38 the Agent card also has{' '}
          <strong>Upgrade on the device itself</strong>: one line to paste into PowerShell as administrator on the
          device, which downloads the published full agent, checks its digest and upgrades. It opens by itself when a
          device downloaded its upgrade and stopped checking in, because then nothing sent from the console reaches
          it. A signed agent shows <strong>Full agent</strong>
          instead, and Linux and macOS show the command to re-run on the device. It is refused while the portal is
          in <em>Signed only</em> mode and held while updates are paused for the customer. Several devices can be
          moved at once from the device list, and{' '}
          <Link href="/endpoints/agent-migrations" className="underline">Agent migrations</Link> (a Devices tab for
          whoever may request one) lists what is pending,
          held, not confirmed or done. More in{' '}
          <Link href="/docs/update-signing#moving-existing-agents" className="underline">Update signing</Link>.
        </p>
        <p className="font-medium text-foreground">Moving to the signed agent, automatically (0.37)</p>
        <p>
          <Link href="/endpoints/full-agent" className="underline">Devices → Full agent</Link> shows the whole move to the
          signed agent as four steps — signing set up on this server, a signed agent published, the timestamp kept
          fresh, devices moved — each with its live state and, when it is not done, the command to run
          (<code>sudo ./deploy/release/rem0te-signed-setup.sh</code> once, then <code>sudo rem0te-signed-publish</code>{' '}
          with each release). Once a signed agent is published, the portal moves standard Windows devices by itself:
          one device first, the canary, and the rest only after it has reported the published build for an hour with
          no failed update, paced like automatic updates. A failure halts it, with the reason on the page, until a
          Platform Admin resumes it or picks another canary. Devices set to Off on their Agent card, or whose update policy opts out, that are paused,
          in a staged rollout or not checking in are skipped, and nothing moves in <em>Signed only</em>. The signed
          agent has not run on real Windows yet: the canary is the first time. More in{' '}
          <Link href="/docs/update-signing#moving-devices-automatically-037" className="underline">Update signing</Link>.
        </p>
        <p className="font-medium text-foreground">Agents keep themselves up to date (0.36)</p>
        <p>
          You don&apos;t need to click Update agent after a release. When a Windows device&apos;s agent is older than
          this server&apos;s version, its next check-in re-runs the installer by itself (a signed agent runs its own
          verified update instead). It is paced across the platform, never runs during a remote session, and waits
          while updates are paused or a rollout owns the device. A device gets at most three attempts per
          release, spaced hours apart. After that its Agent card says <strong>Auto-update failing</strong>, and
          clicking Update agent tries again. The <strong>Automatic updates</strong> part of the card says which
          state it&apos;s in: up to date, queued (with the window it waits for), updating, failing, opted out, or{' '}
          <strong>update manually</strong>. Update manually covers Linux and macOS agents, which act on nothing the
          server sends, and agents older than 0.13. For those the card gives the exact command. A customer, site or
          device group can opt out, or limit it to its update window, in{' '}
          <Link href="/settings/client-updates" className="underline">Patching → Client updates</Link>. A Platform
          Admin sets the platform switch, the hourly pace and the attempts there. The device list&apos;s{' '}
          <em>Agent outdated</em> filter shows every device still behind. More in{' '}
          <Link href="/docs/updates#the-rem0te-agent-automatic-updates-036" className="underline">Updates</Link>.
        </p>
        <p className="font-medium text-foreground">Which version a signed agent shows (0.70.1)</p>
        <p>
          A signed device is current when it runs the published agent binary, whatever release label it last
          recorded. Releases that change nothing in the agent publish the same binary under a new label, and a
          device that already runs it records nothing new, so before 0.70.1 a fully current fleet could read
          0.64.0, 0.67.0 and 0.68.0. The console now shows such a device at the published release, with
          &ldquo;installed as &hellip;; the same agent&rdquo; on its Agent card. A signed device on another binary
          shows its own label and <em>update due</em>. Automatic updates were always decided by the binary, and
          are unchanged.
        </p>
        <p className="font-medium text-foreground">Turning automatic agent updates on or off for one device or one customer (0.46)</p>
        <p>
          <strong>It is on by default.</strong> If nothing is set anywhere, every device updates its agent. To change
          that for one device, use <strong>For this device</strong> under Automatic updates on its Agent card. It
          has three choices: <em>Inherit</em>, which shows what the device currently gets and from where, <em>On</em>
          and <em>Off</em>. The device&apos;s own setting beats every policy. Off never updates that agent
          automatically. On overrides an opt-out, but still waits for a maintenance window its policy sets. To change
          it for a whole customer, use the <strong>Automatic agent updates</strong> card on that customer&apos;s page:
          Inherit global (On), On, Off or In maintenance window. That card leaves RustDesk client updates as they are.
          Only the platform switch in Patching → Client updates beats a device&apos;s On. The order is: device, then
          device group, then site, then customer, then the platform default. Turning something Off never asks you to
          confirm it is you. Turning it On, or back to Inherit, does ask. Every change goes in the audit log.
        </p>
      </div>
    ),
  },
  {
    id: 'backups',
    title: 'Backups',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          From 0.81, <Link href="/backups" className="underline text-foreground">Backups</Link> shows what a backup provider
          reports about the machines it protects. It is read-only: nothing there starts a backup, a restore, a drill or a failover.
        </p>
        <p>
          Each job has three separate facts: whether it <strong className="text-foreground">completed</strong>, whether its
          <strong className="text-foreground"> integrity check</strong> passed, and whether a <strong className="text-foreground">restore
          was tested</strong>. A restore counts as verified only when a real (not simulated) restore drill of that job&apos;s own recovery
          point passed and checked what it restored. <strong className="text-foreground">A successful backup is never shown as verified.</strong>
          The last verified restore shows its recovery point, scope and how long it took.
        </p>
        <p>
          Until a Platform Admin connects a provider for the customer, the page says <em>Requires setup</em>. St0r pushes its status
          to Rem0te with a per-customer token (shown once); the St0r side of that push is not written yet. Comet is planned. RPO is
          measured from the newest recovery point and RTO only from a verified drill, against targets set on the page by someone
          with <em>Monitoring: configure</em>.
        </p>
        <p>
          From 0.82, a Platform Admin sets St0r up in <Link href="/settings/backups" className="underline text-foreground">Administration → Backup connections</Link>,
          step by step: create the connection and copy its token, give St0r the push address and headers, and have St0r send a
          test push (<code>?dryRun=1</code>), which writes nothing. <strong className="text-foreground">Rotating a token stops the old one at once.</strong>{' '}
          When St0r&apos;s name for a machine matches no device, someone with <em>Monitoring: configure</em> links it by hand in the
          asset&apos;s Device column; reports never undo that. St0r&apos;s developers build to the{' '}
          <Link href="/docs/st0r-push-contract" className="underline text-foreground">St0r push contract</Link>.
        </p>
        <p>
          Business Users need <em>See backup status</em> (<code>backups:view</code>), which is not a default, and see only assets on
          devices they can see. Four monitors — <em>Backup stale</em>, <em>Backup failed</em>, <em>Restore drill failed</em> and
          <em> RPO exceeded</em> — and templates for the UrBackup and Comet agents&apos; Windows services are in Monitoring → Monitoring policies.
          None is added for you. <Link href="/docs/backups" className="underline text-foreground">Backups</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'hardware-warranty',
    title: 'Hardware warranty and support links',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          From 0.56, a device&apos;s page has a <strong className="text-foreground">Warranty &amp; support</strong> card
          beside Hardware. It links to the manufacturer&apos;s support, warranty and driver pages for Dell, Lenovo, HP,
          HPE, Microsoft Surface, Apple, ASUS and Acer. Each link opens in a new tab. Only Dell&apos;s link carries the
          serial (the service tag); for the others, use <em>Copy serial</em> and paste it on their page. Virtual machines
          say <em>no hardware warranty</em>.
        </p>
        <p>
          Anyone who may edit the device can <strong className="text-foreground">enter the warranty dates by hand</strong>.
          The change is audited, and a vendor lookup never overwrites it. A Platform Admin can switch on an automatic
          lookup for <strong className="text-foreground">Dell</strong>, <strong className="text-foreground">Lenovo</strong>,{' '}
          <strong className="text-foreground">HP</strong> (from 0.61) or <strong className="text-foreground">Apple</strong> (from 0.61, Macs in
          your Apple Business Manager) under{' '}
          <Link href="/settings/warranty" className="underline text-foreground">Administration → Warranty</Link>. It is off by
          default, and when it is on, each device&apos;s serial number is sent to that vendor (nothing else is).
          The lookup checks each device at most every 30 days, with an hourly limit, and stops under an
          <em> integration</em> containment pause. HPE, Microsoft Surface, ASUS and Acer publish no warranty API, so their
          dates are entered by hand.
        </p>
        <p>
          <strong className="text-foreground">HP credentials:</strong> create an account at developers.hp.com, submit the CSS API
          enrolment form, wait for HP to confirm the Warranty API is enabled on your account, then create an app and paste its
          API key and secret into Administration → Warranty.
        </p>
        <p>
          <strong className="text-foreground">Why is there no date?</strong> From 0.61 every device without one says why, on its
          card and in the report: the vendor has no lookup, the lookup is not switched on, the serial is missing, the vendor has
          not been asked yet, the vendor had no record, or the lookup failed (with the reason).
        </p>
        <p>
          The device list has a Warranty column and filter (expired, ends within 30/60/90 days, unknown).{' '}
          <Link href="/reports/warranty" className="underline text-foreground">Reports → Warranty</Link> and the dashboard tile count
          them. To be alerted, add a <em>Warranty expiring</em> monitor in Monitoring → Monitoring policies. It is not added for you. The Dell, Lenovo,
          HP and Apple lookups have been tested only against a stand-in, never the real vendor APIs.{' '}
          <Link href="/docs/warranty" className="underline text-foreground">Hardware warranty</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'mobile-devices',
    title: 'Mobile Devices (MDM)',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          From 0.80, <Link href="/mobile-devices" className="underline text-foreground">Devices → Mobile devices</Link> shows
          iPhones, iPads and Android devices as a mobile-device-management (MDM) provider reports them: model, OS, whether the
          device is the company&apos;s or the person&apos;s own, what is managed (the whole device, an Android work profile, or
          Apple&apos;s managed apps and data), whether the provider finds it compliant and why not, and the commands the provider
          has run. Rem0te installs nothing on a phone or tablet. From 0.86 it can lock a device or put it in lost mode (below);
          nothing can be erased or wiped from here.
        </p>
        <p>
          <strong className="text-foreground">Requires setup.</strong> Rem0te is becoming its own MDM: the MDM server for iPhones and
          iPads (iOS/iPadOS 16 or later) and the EMM for Android. Until devices can be enrolled, the page says so and points to
          setup.
        </p>
        <p>
          From 0.83, a Platform Admin prepares it in{' '}
          <Link href="/settings/mobile-devices" className="underline text-foreground">Administration → Mobile device setup</Link>, step by step.
          For Apple: what to obtain first (a D-U-N-S number, an Apple Developer organization, Apple&apos;s MDM CSR permission, a
          company Apple Account); generating the push request, whose key never leaves Rem0te; signing it with your MDM vendor
          certificate; uploading the push certificate Apple gives you, which Rem0te checks against its key and shows with its topic
          and expiry; and renewing it every year <strong className="text-foreground">with the same Apple Account</strong>, with
          reminders 30, 14 and 3 days before. For Android: Google&apos;s rules for who may use it, and the service-account key, whose
          project and e-mail are shown. The Apple steps never contact Apple. Each change asks you to confirm it is you
          when <em>Mobile device management setup</em> asks; deleting never does.
        </p>
        <p>
          From 0.84, step 6 enrolls iPhones and iPads with Rem0te as the MDM server. Install the device CA on the server and upload
          its public certificates and the profile-signing certificate; then create a <strong className="text-foreground">one-time
          enrollment link</strong> for a customer (an hour by default) and open it in Safari on the device. Every message the device
          sends is checked against its own certificate before Rem0te reads it. Rem0te asks enrolled devices only for inventory
          (model, storage, security state, and how many apps, profiles and certificates), once a day; it sends no wipe (from 0.86, a lock or lost mode only when someone asks, below).
          Creating a link asks you to confirm it is you when <em>Mobile enrollment links and tokens</em> asks. This has been tested only
          against a simulated device: no real iPhone or iPad has enrolled from this server yet.
        </p>
        <p>
          From 0.85, Android steps 3 to 6 make Rem0te the EMM for Android through Google&apos;s Android Management API, called from
          the server. Test the connection (Rem0te signs a token request with the key and makes one read call), record the device
          quota Google granted, then <strong className="text-foreground">bind each customer to its own Android enterprise</strong>:
          Rem0te gets a one-time sign-up link from Google, which you open or send to the customer&apos;s admin to sign in, ideally
          with a work account (a managed Google domain). Apply the default policy, which turns on only software and app reports and
          never network info, and make a <strong className="text-foreground">one-time enrollment token</strong> (an hour by
          default), shown once as a QR code and a link: a work profile on a personal phone, which Rem0te keeps as personal and never
          with its serial number, or a fully managed company phone. Devices then appear under Mobile devices after the next sync.
          Until 0.86 Rem0te sent no command to an Android device. This has been tested only against a stand-in for Google: no real Google API
          has been called, no enterprise has been created and no device has enrolled.
        </p>
        <p>
          <strong className="text-foreground">Lost or stolen (0.86).</strong> On an enrolled device&apos;s page, someone with the{' '}
          <strong className="text-foreground">Lock mobile devices and use lost mode</strong> permission can <em>Lock</em> it, or{' '}
          <em>Start</em> and <em>Stop lost mode</em>. An iPhone or iPad lock can show a message and a phone number on the lock screen.
          Lost mode shows them until it is stopped; it needs a supervised iPhone or iPad, or a company-owned Android device, and is
          refused on a personal phone. A button the device cannot take is shown disabled with the reason. An <em>approved
          actions</em> pause refuses every command. Each one is audited with who asked; the message and phone number are not kept.
          Re-authentication is asked when <em>Mobile device lock and lost mode</em> asks. This has been tested only against a
          simulated device and a stand-in for Google: no real device has received a command.
        </p>
        <p>
          <strong className="text-foreground">Accepted is not completed.</strong> On a device&apos;s page each command shows two
          separate facts: when the provider <em>accepted</em> it, and when the device reported it <em>completed</em>. A lock the
          provider accepted has not locked anything until the phone says so.
        </p>
        <p>
          Seeing mobile devices needs the <strong className="text-foreground">View mobile devices</strong> permission. A Customer
          Owner has it; a Business User does not unless the owner grants it; a technician needs it on an assignment covering the
          whole customer. A personal device&apos;s serial number is never kept, and no IMEI or phone number is kept for any device.{' '}
          <Link href="/docs/mobile-devices" className="underline text-foreground">Mobile devices (MDM)</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'monitoring-and-alerts',
    title: 'Monitoring and alerts',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Rem0te watches managed devices and raises an alert when one needs a person: offline, a
          system disk nearly full, the processor or memory pinned, a Windows service stopped, matching
          events in an event log, or a restart pending for days. Alerts are under{' '}
          <Link href="/alerts" className="underline text-foreground">Alerts</Link> in the sidebar, and
          each device has a <strong className="text-foreground">Monitoring</strong> tab with its own
          alerts, the monitors in effect, its change history and installed software.
        </p>
        <p className="font-medium text-foreground">Monitoring only reads</p>
        <p>
          A monitor never changes a device. It uses what the agent already sends on its heartbeat,
          plus the services and event-log queries a monitor asks about.
        </p>
        <p className="font-medium text-foreground">Setting it up</p>
        <p>
          <Link href="/settings/monitoring" className="underline text-foreground">Monitoring → Monitoring policies</Link>.
          Start with <strong className="text-foreground">Add recommended</strong>. Monitors are inherited:
          global, then customer, then site, then device group, then device; a monitor with the same key lower down replaces
          the one above it, and a disabled one switches it off there.
        </p>
        <p className="font-medium text-foreground">Agent silent (0.36)</p>
        <p>
          The Offline monitor does not fire for a device RustDesk can still reach, even when its agent has
          stopped checking in. The <em>Agent silent</em> monitor does: under <em>New monitor</em>, pick
          <em> Agent silent (RustDesk still reachable)</em> — 60 minutes by default, anything from 30 minutes to
          7 days — or press <em>Add recommended</em>, which includes it from 0.36.1. It is on only where someone adds it. Its alert says
          remote control should still work and suggests <strong className="text-foreground">Update agent</strong>{' '}
          or re-running the installer, it clears when the agent checks in again, and the device&apos;s page
          and Agent card link to it. It is not offered to ClientSt0r for a ticket.
        </p>
        <p className="font-medium text-foreground">Drives, uptime and updates (0.55)</p>
        <p>
          Four monitors read what Rem0te already stores, with no agent update. <em>Drive space (every fixed drive)</em>
          raises one alert per drive from the inventory, which is about six-hourly. The recommended one leaves C: out,
          because <em>Disk space</em> already watches it on every heartbeat. <em>Not restarted</em> uses the heartbeat&apos;s
          boot time. <em>Security updates outstanding</em> counts from when Rem0te first saw each update offered, and
          needs the signed agent&apos;s patch scan. <em>Update install failed</em> reads Windows Update&apos;s history and
          Rem0te&apos;s own patch deployments. Add recommended includes all but <em>Not restarted</em>.
        </p>
        <p className="font-medium text-foreground">Automatic tickets (0.55)</p>
        <p>
          Monitoring → Monitoring policies → <em>Automatic tickets</em> opens a ticket in your PSA (Administration → PSA / ticketing)
          when an alert of at least the chosen severity opens. It sends the same ticket <em>Create ticket</em> would,
          once per alert, and only alerts that open after you switch it on. It waits for the alert&apos;s hold. It never
          sends in a maintenance window or while notifications are paused, and sends at most 10 per customer an hour.
          A failed send is tried three more times. The reference shows on the alert, the device&apos;s Monitoring tab
          and the dashboard&apos;s <em>Recent alerts</em>. Changing the rule asks you to confirm it is you.
        </p>
        <p className="font-medium text-foreground">Monitors for a device group</p>
        <p>
          Under <em>New monitor</em>, pick a group and give it a priority. It applies to the devices in the
          group right now — a rule group&apos;s members are worked out each time, so a device that stops
          matching drops the monitor at the next check and its open alert closes. A device in two groups
          with a monitor of the same key follows the lower number (1 first); two cannot share a number. A
          device&apos;s Monitoring tab says where each monitor came from and what it beat. See{' '}
          <Link href="/docs/group-policies" className="underline text-foreground">Device-group policies</Link>.
        </p>
        <p className="font-medium text-foreground">How Rem0te judges an event (0.66)</p>
        <p>
          Every event an event-log monitor matches is classified before anything is raised: <em>known failure</em> (a disk bad
          block, a controller error, the disk&apos;s own SMART prediction, NTFS corruption), <em>known warning</em>,{' '}
          <em>informational</em> (Windows logged it as Information), <em>known harmless</em> (never raised, only recorded) or{' '}
          <em>unverified</em> (Rem0te does not know it, so the monitor&apos;s own severity stands). Nothing is raised above the
          severity you set on the monitor, the Security log is never lowered, and a harmless event cannot hide a real one sent
          with it. The first known-harmless pattern is Kernel-General event 11 at Information level with status 0xC00000A2
          for a registry hive inside a read-only shadow copy; disk and storage controller event 11 still alert. The
          recommended <em>disk errors</em> monitor now asks only for Critical, Error and Warning events, and adds 52 (SMART)
          and 55 (NTFS). On upgrade, a disk-errors monitor still exactly as recommended is corrected and audited; one someone
          edited is left alone.
        </p>
        <p>
          Open an alert for <strong className="text-foreground">What happened?</strong>,{' '}
          <strong className="text-foreground">Why was this alert generated?</strong>,{' '}
          <strong className="text-foreground">How serious is it?</strong>, a recommended action and how sure Rem0te is, then{' '}
          <em>View raw event</em>, <em>View similar alerts</em> (the same event fingerprint) and <em>View matching monitor rule</em>.
          Rem0te has no SMART polling and no backup-product integration: a backup failure is watched only by an event-log
          monitor you add. See{' '}
          <Link href="/docs/monitoring" className="underline text-foreground">Monitoring and alerts</Link>.
        </p>
        <p className="font-medium text-foreground">False positives and alert quality rules (0.67)</p>
        <p>
          On an alert, <em>Report false positive</em> records that it was not a real problem: a reason, an optional comment,
          and optionally <em>Also resolve this alert</em> and <em>Recommend preventing similar alerts</em>. A report never
          turns a monitor off and never creates a rule; repeated reports only raise a recommendation&apos;s priority.{' '}
          <Link href="/alerts/quality" className="underline text-foreground">Monitoring → False positives &amp; rules</Link>{' '}
          shows the reports, the recommendations and the <em>alert quality rules</em>. A rule suppresses, lowers, or waits
          for a count or for repeated reports, for one device, a group, a customer, one monitor or an operating system
          (every customer is a Platform Admin&apos;s). It is tested against the last 90 days of stored alerts and approved
          before it applies; a high-risk rule (a critical, Security-log, backup or storage monitor, or one with dangerous
          matches) needs two different people. Temporary rules end by themselves; permanent ones carry a review date. Roll
          back at any time. A suppressed event is still recorded. See{' '}
          <Link href="/docs/monitoring" className="underline text-foreground">Monitoring and alerts</Link>.
        </p>
        <p className="font-medium text-foreground">One alert per problem</p>
        <p>
          A repeat raises the count on the open alert instead of making another. When three or more
          devices at a site are offline and they are at least half of it, one site-outage alert gathers
          them. <strong className="text-foreground">Acknowledge</strong> stops escalation;{' '}
          <strong className="text-foreground">Resolve</strong> closes it with a note. Most alerts also
          resolve themselves when the problem clears.
        </p>
        <p className="font-medium text-foreground">Maintenance windows are not containment</p>
        <p>
          A maintenance window holds notifications for planned work — alerts are still recorded. To stop
          changes reaching devices during an incident, use{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Containment</Link>.
        </p>
        <p className="font-medium text-foreground">Who is told</p>
        <p>
          Up to four escalation levels, each with webhook or (0.34) email destinations — email only to confirmed addresses, saying only the alert, device, customer and a link — under the Notifications tab, and
          optionally a ticket in ClientSt0r. Changing who is notified asks you to confirm it is you.
          See <Link href="/docs/monitoring" className="underline text-foreground">Monitoring and alerts</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'client-updates',
    title: 'Automatic RustDesk client updates',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          A customer can let the server update outdated RustDesk clients by itself, at a time nobody is
          using the devices. Set it in{' '}
          <Link href="/settings/client-updates" className="underline text-foreground">Patching → Client updates</Link>.
          It is off until someone turns it on.
        </p>
        <p className="font-medium text-foreground">The update window</p>
        <p>
          Pick the days and times, and the time zone they are in — for example every night 22:00–05:00
          Europe/London. An end earlier than the start runs past midnight and belongs to the day it starts
          on. Daylight-saving changes are handled: on the night the clocks go forward a window that starts in
          the missing hour opens when the clock reaches the next real time. The page shows when the window
          next opens. A site can have its own policy, which replaces the customer one for that site.
        </p>
        <p className="font-medium text-foreground">Policies for device groups</p>
        <p>
          A device group can have its own policy too, with a priority (1 first). A group policy beats a site
          override, which beats the customer policy; a device in several groups with a policy follows the
          lowest number. The Devices table and the device&apos;s own page say which policy governs it and
          why. Turning a group policy on, or removing one, asks you to confirm it is you, and a group that has
          a policy cannot be deleted until the policy is removed. See{' '}
          <Link href="/docs/group-policies" className="underline text-foreground">Device-group policies</Link>.
        </p>
        <p>
          Every sweep re-checks updates already queued automatically (0.36): if a device has left the group
          whose policy queued it — or that policy was switched off or removed — the update is withdrawn, or kept
          under the policy that governs the device now if that one is on. Both are in the audit log with the
          reason.
        </p>
        <p className="font-medium text-foreground">What happens</p>
        <p>
          While the window is open, the server queues outdated Windows devices that are online, in batches
          (25 per two-minute sweep by default), and each is told to re-run its installer on its next heartbeat. Outside the window nothing
          is queued, and anything already queued automatically waits. By default a device with an open
          remote session is skipped (the install restarts RustDesk and would end the session); you can also
          skip devices someone is logged on to. Updates paused by{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Containment</Link>{' '}
          stop all of this.
        </p>
        <p className="font-medium text-foreground">Clicking Update still goes at once</p>
        <p>
          An update someone queues by hand on the Updates page is sent on the next heartbeat, whatever the
          window. The Updates page and the device&apos;s page say which kind each queued update is, and who
          queued a manual one. Clicking Update on one that is waiting for the window sends it now.
        </p>
        <p className="font-medium text-foreground">Devices that will never update automatically</p>
        <p>
          The Devices list says why: not Windows, never authenticated with a device secret (re-run the
          installer on the machine once), or an agent so old it has never reported a RustDesk version. An
          offline device is queued when it is next online inside the window.
        </p>
        <p className="font-medium text-foreground">Who can change it</p>
        <p>
          A Business Owner for their own customer, a technician whose assignment gives{' '}
          <em>Rename/edit devices</em> over the whole customer, or the MSP. Turning it on asks you to confirm
          it is you; turning it off never does. Every change, and every device queued automatically, is in
          the audit log.
        </p>
        <p className="font-medium text-foreground">&ldquo;Two agents are reporting from this device&rdquo; (0.51)</p>
        <p>
          Once a device&apos;s signed agent has reported, it stays signed for seven days after its last signed
          heartbeat. Nothing meant for the standard agent is handed to it: no standard update, no queued reinstall,
          no old migration. Reports from the installer and from a leftover standard heartbeat change nothing on its
          record. When a leftover has reported in the last day, the Agent card says so and gives the one command to run
          on the device, in PowerShell as administrator. A leftover from 0.51 or later hands over by itself. The
          signed agent removes the standard agent&apos;s leftover task, files and tray entry each time it installs or
          updates. Not yet run on real Windows.
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
          <Link href="/settings/api-keys" className="underline text-foreground">Administration → API keys</Link>.
        </p>
        <p>
          A key belongs to one customer and can do only what its scopes allow — tick only what the
          integration needs. It is shown once, when it is created; only a hash is kept, so a lost key is
          revoked and replaced. Revoking takes effect at once. Keys are managed by a Business Owner, or by a
          Platform Admin for any customer.
        </p>
        <p>
          Creating a key asks you to <strong className="text-foreground">confirm it&apos;s you</strong> (unless a Platform
          Admin set <em>API keys</em> to Don&apos;t ask under Settings → Confirm it is you), whatever its
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
    title: 'Connect says the device is offline',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          That message comes from RustDesk, not Rem0te, and it usually means the client{' '}
          <em>you are connecting from</em> is asking a different rendezvous server — not that
          anything is wrong with the device you are connecting to.
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
              Remote support → Technician client
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
    title: 'Test connection and session status',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Every device&apos;s page has a <strong className="text-foreground">Test connection</strong> panel, on its
          Diagnostics tab (the Diagnose button opens it). It
          checks the server, the device and — with <em>Check my device</em> — the RustDesk on your own machine,
          and says which one is wrong. Fixes that change something are labelled; the test itself changes nothing.
          <em> Download report</em> gives a redacted copy safe to attach to a ticket.
        </p>
        <p>
          A session&apos;s status names the evidence behind it. <strong className="text-foreground">Client opened</strong>{' '}
          means RustDesk started on your own computer — not that you connected.{' '}
          <strong className="text-foreground">Connection confirmed</strong> comes from the remote device&apos;s agent
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
          A technician can be given access to a customer without belonging to it: chosen capabilities, optionally
          only some devices, optionally only until a date or during set hours. If you have such access, the
          customer switcher at the top of the menu chooses which customer you are working in, and{' '}
          <Link href="/technician" className="underline text-foreground">All assigned</Link> shows them all — including
          access that is not active right now and why.
        </p>
        <p>
          Most technician access is now an <strong className="text-foreground">access level</strong>: L1 Help Desk,
          L2 Technician or L3 Senior. No level gives Remote connect or a device&apos;s password. View-only works only
          where the device can enforce it, and interactive control needs a{' '}
          <strong className="text-foreground">temporary grant</strong>: request it from the device&apos;s page, have
          someone else approve it, then activate it with a fresh sign-in. If Connect is refused, the message says why.
          Domain controllers, hypervisors, backup servers and the Rem0te host are refused to everyone. Unusually broad
          activity pauses your privileged access until someone else clears it. More in{' '}
          <Link href="/docs/technician-access" className="underline text-foreground">Technician access</Link>.
        </p>
        <p>
          From 0.24, Windows agents can update through a <strong className="text-foreground">signed update chain</strong>:
          they run only files signed with your release keys, so this portal cannot make them install anything
          else. Platform Admins see which devices are still on the older update path, and can stop the portal handing
          those anything to run, under{' '}
          <Link href="/settings/security/update-signing" className="underline text-foreground">Security → Update signing</Link>.
          More in <Link href="/docs/update-signing" className="underline text-foreground">Update signing</Link>.
        </p>
        <p>
          From 0.37 the keys can live on this server, the easy way, under a separate <code>rem0te-release</code> user that
          the portal itself cannot read. On the server, from the source checkout, once:{' '}
          <code>sudo ./deploy/release/rem0te-signed-setup.sh --apply-env</code>, then{' '}
          <code>sudo systemctl restart reboot-remote-api</code>. Setup creates the keys and the repository, installs a daily{' '}
          <code>rem0te-timestamp-refresh.timer</code> and publishes the first signed release; the restart lets the portal
          see it. Then move the root keys off the server: <code>sudo rem0te-signed-export-root &lt;dir&gt;</code> (for
          example a USB stick; they are deleted from the server only after you type <em>yes</em>). After every deploy run{' '}
          <code>sudo rem0te-signed-publish</code>, which builds and signs what is committed; <code>sudo rem0te-signed-status</code>{' '}
          shows the keys, the published build and when the timestamp expires. Nothing is sent to GitHub. The trade-off:
          root on this server can sign a release, so export the root keys.{' '}
          <Link href="/endpoints/full-agent" className="underline text-foreground">Devices → Full agent</Link> shows each
          step live. More in{' '}
          <Link href="/docs/update-signing#the-easy-way-single-host-037" className="underline text-foreground">Update signing → The easy way</Link>.
        </p>
        <p>
          From 0.26, one change can be made on a Windows device without a remote session:{' '}
          <strong className="text-foreground">starting the Print Spooler, once</strong>, from the device&apos;s{' '}
          <em>Actions</em> tab. Nothing runs until people on the approval roster approve that exact plan with a passkey,
          on a separate approval page this portal does not serve; servers need two approvers, and some customers also
          require their own sign-off. The device checks the approvals itself and runs it at most once. Documents
          already in the print queue may print immediately and cannot be recalled. A result says whether the service
          was running, never that anything printed; an uncertain outcome must be reconciled before you can ask again.
          From 0.47.1 the action shows the Spooler&apos;s last known state and how old it is, with{' '}
          <strong className="text-foreground">Refresh</strong> to ask the device again; when it is already running
          the button reads <em>Nothing to do</em>. More in{' '}
          <Link href="/docs/approved-actions" className="underline text-foreground">Approved actions</Link>.
        </p>
        <p data-help="direct-mode">
          <strong className="text-foreground">Direct mode (0.40), for a single operator.</strong> If you run this portal
          alone, the approval signer&apos;s operator can turn approvals off for a customer, or for every customer, with
          one command on the signer:{' '}
          <code className="text-foreground">policy set --business default --approval direct</code>. A request is then
          signed as soon as you make it, and runs when the device next checks in — the
          Actions tab, patching, software and scripts say <em>Approved automatically (direct mode)</em>, and there is no
          approval page. What it gives up: a second person. Anyone who fully takes over this portal can then run
          catalog actions on those devices, as with most RMMs. What still holds: signing in, permissions, the
          audit log, containment pauses, revocations, maintenance windows and session rules, and the device checking
          the signer&apos;s signature. Whether a request also asks you to confirm it is you is set under{' '}
          <Link href="/settings?tab=confirm" className="underline text-foreground">Settings → Confirm it is you</Link>{' '}
          (0.49, <em>Direct-mode requests</em>): Ask, or Don&apos;t ask, when signing in is enough. Direct mode cannot be combined with customer sign-off, ClientSt0r proposals are
          refused under it, and devices need the 0.40 agent (an older one refuses direct plans). More in{' '}
          <Link href="/docs/approved-actions#direct-mode-the-default-for-a-single-operator" className="underline text-foreground">Approved actions → Direct mode</Link>.
        </p>
        <p>
          From 0.32, the same <em>Actions</em> tab (or <strong className="text-foreground">Run action</strong> at the top of
          a device&apos;s page) offers four <strong className="text-foreground">maintenance actions</strong>: restart one
          service from a fixed list (Print Spooler, Windows Update, BITS, Windows Time, WinRM, RustDesk), schedule a
          restart after a warning of 5 minutes to 24 hours, cancel a pending restart, and collect a fixed set of logs.
          Each one always needs two different approvers, whatever the device. A scheduled restart shows the person at
          the device a fixed warning and closes unsaved programs when it ends; it is never immediate, and the device
          skips it, like a RustDesk restart, while a technician is connected through RustDesk. A signed-in user does not
          stop the restart: they see the warning, and unsaved work is lost. Collected logs are bounded, redacted twice
          and shown only to people who may read the device&apos;s event logs. Like every approved action, these do
          nothing until an approval signer is installed and the device runs a 0.32+ signed agent; until then the tab
          says why. They have been tested against a simulated Windows only.{' '}
          More in <Link href="/docs/approved-actions#maintenance-actions-032" className="underline text-foreground">Approved actions</Link>.
        </p>
        <p data-help="rollback-repeat">
          <strong className="text-foreground">Undoing an action, and running it again (0.79).</strong> Every approved
          action says how it is undone and whether a second run is harmless, before you request it on the{' '}
          <em>Actions</em> tab, beside it in <em>Tools</em>, and on every job in the history. Some are undone by another
          action: a scheduled restart by <em>Cancel a scheduled restart</em>, an install by its uninstall, a service
          change by the opposite change on the Services tab. Some can&apos;t be undone from here: an installed Windows
          update, a removed program, an ended process, a script. Collecting logs only reads. Two actions are{' '}
          <strong className="text-foreground">not safe to repeat</strong>: scheduling a restart (a second run restarts
          the device again) and running a script (the catalog can&apos;t know what a script does twice); the rest
          change nothing the second time. Nothing is retried automatically. When one plan names several devices, the
          job also counts how all of them stand and says <em>Partial</em> when some succeeded and some did not. The full
          table is in{' '}
          <Link href="/docs/approved-actions#rollback-and-repeating-an-action-079" className="underline text-foreground">Approved actions → Rollback and repeating an action</Link>.
        </p>
        <p>
          From 0.62, a patch policy, a company-wide policy or a deployment on{' '}
          <Link href="/patching" className="underline text-foreground">Patching</Link> installs{' '}
          <strong className="text-foreground">all at once</strong> by default: tick the devices, and every one installs
          together in the window, with no test device and nothing waiting for another. More than 25 devices go out as
          plans of up to 25 (at most 125), still all at the same time. Tick{' '}
          <strong className="text-foreground">Test on one device first</strong> for the staged rollout described below.
          The choice is signed into the policy, so the approval signer holds it to it; a policy made before 0.62 keeps its
          test device. In direct mode the forms say <em>Create policy</em> and <em>Install</em>, ask for no reason, and
          what you create is active at once.
        </p>
        <p>
          From 0.27, Windows updates can be installed in stages from{' '}
          <Link href="/patching" className="underline text-foreground">Patching</Link>: one{' '}
          <strong className="text-foreground">canary</strong> device first, then rings. Each ring is one plan that two
          people on the approval roster approve with a passkey, and the next ring cannot be requested until the canary
          reports every update <em>effective</em> (installed, no longer offered, no restart pending). Unless the plan&apos;s
          restart rule says otherwise (below), Rem0te never restarts a device, so &ldquo;restart required&rdquo; waits
          for someone to restart it. Only security,
          critical, rollup, ordinary Microsoft updates and, from 0.42, drivers and definition updates are installed;
          feature upgrades, optional updates, anything needing a licence and devices managed by WSUS, Intune or
          Configuration Manager are refused. Patch policies never pick drivers unless you tick them, and an agent older
          than 0.42 refuses drivers and definition updates until it is updated. Each device&apos;s{' '}
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
          RustDesk on a Linux device means re-running the installer there; it has no software list or event logs. Remove
          it with the installer&apos;s <code>--uninstall</code>. More in{' '}
          <Link href="/docs/inventory#linux-devices-032" className="underline text-foreground">Inventory</Link>.
        </p>
        <p>
          From 0.33 the macOS installer does the same when it is run with <code>sudo</code>: a read-only agent in{' '}
          <code>/Library/Rem0te</code>, run by a LaunchDaemon every 3 minutes, shown as <em>Standard (macOS)</em>. It reports
          the macOS version, kernel, uptime, CPU, memory, volumes, the console user, the model and serial, the RustDesk
          version, and the updates macOS itself last found. It never runs <code>softwareupdate</code>: if macOS has not
          checked in the last 36 hours the scan says <em>unknown</em> rather than showing an old list, and restart pending
          is always unknown on a Mac. Like the Linux agent it acts on nothing the console sends. It has been tested
          against recorded macOS output, not yet on a Mac. More in{' '}
          <Link href="/docs/inventory#macos-devices-033" className="underline text-foreground">Inventory</Link>.
        </p>
        <p>
          From 0.32, a device&apos;s <em>Patches</em> tab has <strong className="text-foreground">Install updates</strong>{' '}
          when it can be patched: pick updates and give a reason, and it becomes a one-device deployment that two
          approvers still approve on the approval signer. When it cannot be patched there is no button; the tab says why
          (for example, the standard agent) and what to do instead.{' '}
          <strong className="text-foreground">Patch policies</strong> on the Patching page are approved once, by two
          people on the approval signer, and then run inside their maintenance window: from 0.62 every device together,
          or, with <em>Test on one device first</em>, the canary first and the next ring only once the canary is
          confirmed effective. The approval signer, not this portal, signs each ring, and only if
          it stays inside the policy&apos;s devices, update classes, excluded KBs and window. Revoking one is
          one-way. Platform Admins see a pre-flight listing what a production
          install still lacks. Fixture-tested only so far. More in{' '}
          <Link href="/docs/patching-setup" className="underline text-foreground">Patching setup</Link> and{' '}
          <Link href="/docs/staged-patching" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.50, a customer can have a <strong className="text-foreground">company-wide patch policy</strong>:
          the portal names every Windows device of the customer on the signed agent and, from 0.62, installs on them all
          together; with <em>Test on one device first</em> it picks a canary (yours, or the one that checks in most
          reliably) and puts the rest in rings of at most 25. Each set of devices is still an
          ordinary signed policy, a revision, approved like any other. When devices join or leave, the next revision
          is proposed after the change has held a few minutes, at most once an hour per customer and never during a
          deployment; in signed mode the old revision keeps running until the new one is approved. Each
          device&apos;s <strong className="text-foreground">Patch policy</strong> setting, on its <em>Patches</em>{' '}
          tab, is <em>Inherit</em>, <em>Exclude</em> or <em>Use policy X</em> (an assignable policy of the same
          customer). A device is in one policy at a time; the tab shows which one patches it and why. Changing the
          setting needs Edit devices and a fresh sign-in, and is audited. Fixture-tested only. More in{' '}
          <Link href="/docs/staged-patching" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.52, every task you send has <strong className="text-foreground">progress you can watch</strong>:
          scheduled, pending approval, queued for the device&apos;s next check-in (about every 3 minutes), handed
          out (with how many times), running, and done with a result per item. The device page shows a{' '}
          <em>Tasks</em> panel, <Link href="/automation/tasks" className="underline text-foreground">Automation → Tasks</Link>{' '}
          lists them for every device you can see, and a toast tells you when one of yours finishes. A task that has
          been handed out for a long time without an answer says so, and what that usually means. On the{' '}
          <em>Patches</em> tab the latest install shows its progress and then each update&apos;s result with Windows&apos;
          error text; when Windows wants a restart, a banner says how many were installed and offers{' '}
          <em>Schedule restart</em> (an ordinary <em>Schedule a restart</em> action, approved like any other) and{' '}
          <em>Scan now</em>. Updates already installed show as &ldquo;installed, waiting for restart&rdquo; until a scan
          after the restart.
        </p>
        <p>
          From 0.52, <em>Install updates</em> and a deployment&apos;s next ring can be{' '}
          <strong className="text-foreground">scheduled</strong>: a date and time, in the device&apos;s site time zone,
          your profile&apos;s or this browser&apos;s (the form says which), up to 14 days ahead. The time is signed into the
          plan as the start of its window; nothing is handed to the device before it, and the agent itself refuses the
          plan until then. Until it starts it can be canceled from the task, the Tasks page or the ring. Patch policies
          show their next install window. Scheduling has been tested against a simulated agent only, not yet on a real
          Windows device. More in{' '}
          <Link href="/docs/staged-patching#scheduled-installs" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.58, an approved library script or a software catalog package can run{' '}
          <strong className="text-foreground">on a schedule</strong>:{' '}
          <Link href="/automation/schedules" className="underline text-foreground">Automation → Schedules</Link>. A
          schedule names the task (the script&apos;s exact hash and arguments, or the package version), named devices
          or a device group with a cap of 25, every few hours or a daily, weekly or monthly window, and what happens to a
          device that is offline. Two approvers who are not its author (and did not write the script) approve it once
          on the approval signer; the signer then signs each run and holds it to the schedule. Runs never overlap.
          Pausing stops it at once; resuming and revoking ask you to confirm it is you. Revoking the script, archiving
          the package or a containment pause on actions stops every later run, and changing a schedule is a revision,
          approved again. A single script run or software install can also be scheduled once, up to 14 days ahead.
          Tested against a simulated agent only. More in{' '}
          <Link href="/docs/automation" className="underline text-foreground">Automation schedules</Link>.
        </p>
        <p>
          From 0.60, a <strong className="text-foreground">restart window</strong> says when a device may be restarted
          automatically: &ldquo;restart if Windows needs it (or every time), nightly 02:00&ndash;04:00&rdquo; in one time
          zone. Set it on a customer (its overview), on a device group, or on one device (its Patches tab), which can
          instead say <em>No automatic restarts</em>; the device&apos;s own setting wins, then a group&apos;s, then the
          customer&apos;s. With nothing set, nothing restarts a device automatically. A window is approved once on the
          approval signer by two people with passkeys (or is in force at once in direct mode) and says{' '}
          <em>Pending approval</em> until then. Each restart is its own signed plan with the 15-minute warning; a
          signed-in user does not stop it, a technician connected through RustDesk does (unless the window says otherwise),
          and a deferred restart is tried again 15 minutes later and in the next window. Tested against a simulated agent
          only. More in{' '}
          <Link href="/docs/restart-windows" className="underline text-foreground">Restart windows</Link>.
        </p>
        <p>
          From 0.63, <strong className="text-foreground">approved policies do not expire</strong>: patch policies,
          company-wide policy revisions, automation schedules and restart windows stand until they are revoked, paused
          or replaced. The forms no longer ask for an expiry and nothing warns that one is coming. Each new document
          says so in a signed field (<code>expiry: &quot;never&quot;</code>) that the approval page shows, so the approvers
          know what they approve. A policy approved before 0.63 keeps its expiry and stops on that date as before; to
          replace it with one that does not expire, use <em>Change</em> then <em>Save</em> (a restart window), make a
          revision (a schedule), or make the policy again. A company-wide policy&apos;s running revision is renewed one
          last time, into one that does not expire. The approval signer must be 0.63 before anyone saves one.
        </p>
        <p>
          From 0.53, a patch policy&apos;s maintenance window can be{' '}
          <strong className="text-foreground">monthly</strong> as well as weekly: the first, second, third, fourth or
          last weekday of each month plus 0–14 days (Patch Tuesday is the second Tuesday, so &ldquo;second Tuesday + 2&rdquo;
          is the Thursday after it), or a day of the month from 1 to 28, so it opens in every month. The start, end and
          time zone work as for a weekly window, across midnight and daylight-saving time. The policy form and the
          company-wide policy form show the next three openings; a window that never opens is refused. Policies approved before 0.53 are weekly and keep working unchanged. The approval
          signer must be updated to 0.53 before it accepts a monthly policy. On the <em>Patches</em> tab, a scheduled
          install can start at the next opening of the device&apos;s policy window. More in{' '}
          <Link href="/docs/staged-patching#monthly-windows-053" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.34, a deployment, an <em>Install updates</em> request and a patch policy each have a{' '}
          <strong className="text-foreground">restart rule</strong>: <em>Never restart</em> (the default) or{' '}
          <em>Restart if required, inside the window</em>. With the second, a device that Windows says needs a restart
          after the install shows the same fixed warning as a scheduled restart and restarts 15 minutes later. It does not
          restart while a technician is connected through RustDesk (or when it cannot tell), or if the restart would fall after the
          plan&apos;s window; then the deployment shows the restart as <em>deferred</em>, with why, and the update stays
          &ldquo;restart required&rdquo;. The approvers see and sign the rule, and a plan under a policy may never ask for
          more than the policy allows. After the restart a new scan confirms the update effective. The in-window restart
          has been tested against a simulated Windows only; it has not yet run on a real Windows computer. More in{' '}
          <Link href="/docs/staged-patching#restarting-after-updates" className="underline text-foreground">Staged patching</Link>.
        </p>
        <p>
          From 0.54, a <strong className="text-foreground">restart can be scheduled</strong> for a date and time up to 14
          days ahead, in a named zone, from the Actions tab, the Patches tab&apos;s restart banner, or{' '}
          <em>Schedule restart…</em> in the Devices list (a selection or a device group, at most 200, one approved plan
          each). <em>Only if a restart is required</em> leaves the decision to the device, which reads Windows&apos; own
          pending-restart state when the plan runs. A patch policy (or a company-wide one) can have a{' '}
          <strong className="text-foreground">restart window</strong>: <em>restart if required</em> or a{' '}
          <em>maintenance restart</em> of every device. The approval signer signs each restart only inside that window,
          with the fixed 15-minute warning; a restart held back because a technician was connected through RustDesk is
          asked for again 15 minutes later (up to three times) and in the next window. A signed-in user does not stop the
          restart. They see the 15-minute warning, and unsaved work is lost. The checkbox{' '}
          <em>Restart even if a technician is connected through RustDesk (their session is dropped)</em> is never ticked
          by default; it needs the 0.54 agent, and on a policy the approvers see it. Tested against a simulated agent only.
          More in{' '}
          <Link href="/docs/staged-patching#restart-windows-054" className="underline text-foreground">Staged patching → Restart windows</Link>.
        </p>
        <p>
          From 0.34, devices <strong className="text-foreground">sign their own patch results</strong> with a key
          they generate and never send. A policy names each device&apos;s key, and the approval signer checks the
          canary&apos;s signed results and scan before it opens the next ring, so a result this portal altered or made
          up is refused. Every ring of a policy except the last needs devices running the 0.34 agent. From 0.62 this
          applies only with <em>Test on one device first</em>: a policy that installs all at once opens no ring on
          anyone&apos;s results, so it needs no result keys. Before approving
          a device&apos;s first policy, compare the key fingerprint on the approval page with{' '}
          <code>rem0te-agent.exe status</code> on the device. Policies approved before 0.34 can still run their
          canary, but no later ring. More in{' '}
          <Link href="/docs/staged-patching#signed-results-034" className="underline text-foreground">Signed results</Link>.
        </p>
        <p>
          From 0.87 the menu is nine groups: <strong className="text-foreground">Dashboard</strong>,{' '}
          <strong className="text-foreground">Devices</strong> (all devices, your own, customers, adding one),{' '}
          <strong className="text-foreground">Remote support</strong>, <strong className="text-foreground">Monitoring</strong>{' '}
          (alerts, monitoring policies, backups), <strong className="text-foreground">Patching</strong>,{' '}
          <strong className="text-foreground">Automation</strong>, <strong className="text-foreground">Reports</strong>,{' '}
          <strong className="text-foreground">Security</strong> (containment, the audit log, server security, access
          control) and <strong className="text-foreground">Administration</strong> (settings, users, technicians,
          integrations). <em>Standard</em> mode, the default, lists the everyday pages; the rest are tabs on those pages
          and in Ctrl+K, and <em>Advanced</em> in your profile menu lists them all. The toggle at the top left collapses
          the menu to icons. Help is the <strong className="text-foreground">?</strong> in the top bar; your theme
          (Light, Dark or System), density, mode and Sign out are in the profile menu at the top right. Star a device or
          customer to keep it under the star in the top bar. Nothing moved address:{' '}
          <Link href="/docs/navigation_migration" className="underline text-foreground">where things moved</Link>.
        </p>
        <p>
          <Link href="/automation/scripts" className="underline text-foreground">Automation → Script library</Link> holds
          PowerShell scripts for one customer, or global ones a Platform Admin writes. Every edit is a new version with its
          own SHA-256. A version goes from draft to review to approved or rejected, and someone other than everyone who
          wrote it must approve it, with a fresh sign-in. Before you approve, the page shows warnings for things like{' '}
          <code>Invoke-Expression</code>, downloads, encoded commands, credentials and disabling Defender. They&apos;re
          warnings, not a verdict. <strong className="text-foreground">Running a script (0.34)</strong>: on an approved
          version, <em>Run this version</em> first proposes it to the approval signer, where two approvers who didn&apos;t
          write it add its exact SHA-256 to the signer&apos;s own allowlist. Then you can request a run on up to 25 Windows
          devices, with typed arguments and a timeout of 1 to 30 minutes; two more approvers approve each run on the
          signer&apos;s page. The signed agent checks the hash before it runs anything, as SYSTEM, and each device&apos;s
          Actions tab shows the exit code and the first 64 KB of output, redacted, for 90 days. Revoking is permanent,
          and from 0.36 it also stops a run that was already signed: the signer publishes a signed list of revoked
          scripts and archived software, and a device on the 0.36 signed agent refuses a revoked run before it starts
          (<em>Refused by the device · revoked</em>). Such a device runs nothing signed after the newest list it
          has, so a run can wait a moment for a fresh one; it isn&apos;t failed.
          On a server with no approval signer the panel says so and offers nothing to propose, request or revoke.
          It has been tested with PowerShell 7 on Linux, <strong className="text-foreground">not yet on a real Windows
          device</strong>. Writing needs <em>Write scripts</em>; reviewing, proposing and revoking need <em>Review
          scripts</em>; requesting a run also needs <em>Request approved actions</em>. More in{' '}
          <Link href="/docs/script-library" className="underline text-foreground">Script library</Link>.
        </p>
        <p>
          The <Link href="/dashboard" className="underline text-foreground">Dashboard</Link> (0.31) says what is broken,
          which customers it affects, which devices need attention, what is already being worked on, and what to
          do next — only for what you can see. From 0.35 it fits the window on a desktop screen: figures first, then
          the lists and the map, each long list scrolling inside its own card — and from 0.36 it still fits with a
          containment strip at the top. <strong className="text-foreground">Work on next</strong> is a ranked
          list and each item says why it is there: site outages, then critical alerts, actions whose outcome is
          unknown, failed actions, warnings, approval requests, restarts pending and info alerts, oldest first.
          Acknowledged alerts and alerts in a maintenance window are left out. <em>Patch compliance</em> counts only
          devices with an update scan under 36 hours old and shows the coverage beside it; with no such scan it says{' '}
          <em>No data</em>. Server health moved to Administration → System status. More in{' '}
          <Link href="/docs/technician-guide" className="underline text-foreground">Technician guide</Link>.
        </p>
        <p>
          <Link href="/reports" className="underline text-foreground">Reports</Link> (0.32) answer four questions from
          stored data, per customer and site: <strong className="text-foreground">Patch compliance</strong> (the
          dashboard&apos;s definition; devices with a stale scan or none are coverage gaps, never counted as
          compliant), <strong className="text-foreground">Agent coverage</strong> (agent type and version, devices
          without a device secret, devices not heard from in a chosen number of days, non-Windows devices with no
          inventory), <strong className="text-foreground">Alert frequency</strong> over a period, with time to resolve,
          and <strong className="text-foreground">Offline time</strong>, measured from the Offline monitor&apos;s alerts
          because the online flag keeps no history. There is no availability percentage: which devices were
          monitored, and when, is not recorded. Each report shows only what you can already see and needs the
          permission of its data (View devices, or monitoring:alerts). <em>Export CSV</em> is capped at 10,000
          rows and recorded in the audit log before the file is sent. More in{' '}
          <Link href="/docs/reports" className="underline text-foreground">Reports</Link>.
        </p>
        <p>
          From 0.35 each schedulable report has <strong className="text-foreground">Schedule this report</strong>{' '}
          beside Export CSV, which opens the schedule form prefilled with the report and its filters; it is shown to
          a Platform Admin or a Business Owner, who may own a schedule.{' '}
          From 0.34 a report can be <Link href="/reports/schedules" className="underline text-foreground">scheduled</Link>:
          weekly or monthly (days 1–28), at a time in a time zone, emailed to confirmed addresses with a link and,
          optionally, the CSV — the same audited export, with the same row limit. It is computed with its owner&apos;s
          access when it is sent; if the owner has lost access, nothing of the report is sent, the recipients are told
          it did not come, and the schedule switches itself off. Each period is sent at most once, even across a restart.
          Outbound email is set up by a Platform Admin under{' '}
          <Link href="/settings/email" className="underline text-foreground">Administration → Email</Link>. Mail only ever
          goes to addresses whose owner clicked a confirmation link. See{' '}
          <Link href="/docs/email" className="underline text-foreground">Email and scheduled reports</Link>.
        </p>
        <p>
          From 0.48 every event-log entry and alert on a device has <strong className="text-foreground">Ask AI</strong>{' '}
          and <strong className="text-foreground">Create ticket</strong>. Ask AI explains the entry using the provider a
          Platform Admin set under <Link href="/settings/ai" className="underline text-foreground">Administration → AI</Link>{' '}
          (Anthropic, OpenAI or an OpenAI-compatible service). The entry is redacted on this server first, so names, addresses,
          accounts and serials are removed, and the provider never learns which device or customer it came from.
          <strong className="text-foreground"> Show what was sent</strong> displays the exact text. Create ticket sends the
          entry to the PSA connected under{' '}
          <Link href="/settings/psa" className="underline text-foreground">Administration → PSA / ticketing</Link>, by email-to-ticket,
          a signed webhook, or ClientSt0r once it supports it. A customer&apos;s own connector wins over the platform default.
          It needs the <em>Create PSA tickets</em> permission. AI can be wrong, so check its suggestions before acting. See{' '}
          <Link href="/docs/ai-and-tickets" className="underline text-foreground">AI and tickets</Link>.
        </p>
        <p>
          From 0.28, writes can be <strong className="text-foreground">paused</strong> while an incident is looked at:
          approved actions, remote connections, agent updates and ClientSt0r jobs — and, from 0.34, outbound email — for every customer or for one. A red
          strip at the top of the page says what is stopped and why; a refused click says <em>CONTAINED</em>. A Customer
          Owner can suspend their own customer, and only they can lift that. A pause set by the MSP is lifted by someone
          other than whoever set it, with a fresh sign-in unless <em>Lifting a containment pause</em> is set to Don&apos;t ask. The audit log is now tamper-evident: every entry is
          chained to the one before it and checked hourly. See{' '}
          <Link href="/settings/security/containment" className="underline text-foreground">Security → Containment</Link>{' '}
          and <Link href="/docs/containment" className="underline text-foreground">Containment</Link>.
        </p>
        <p>
          <strong className="text-foreground">The server itself.</strong> Platform Admins see the server&apos;s security
          posture under <Link href="/admin/security" className="underline text-foreground">Security → Server security</Link> (0.74): a
          score over SSH, the firewall, listening ports, pending updates and restarts, fail2ban, certificates, security
          headers, MFA coverage, API keys, the audit chain and the API&apos;s own off switches. A check that could not be
          read says <em>Unknown</em>, never OK. Bans, never-ban entries, jail settings, installing fail2ban and OS upgrades
          are audited and may ask you to confirm it is you. A deliberate decision (SSH behind your own firewall, no second
          disk for the audit export) can be <em>accepted</em> with a reason and an optional expiry (0.75.1): it moves to
          Accepted risks, is never shown as OK, and re-opens on its own when its evidence changes or it expires. A
          Platform Admin without MFA, test switches and certificates cannot be accepted. See{' '}
          <Link href="/docs/server-security" className="underline text-foreground">Server security</Link>.
        </p>
        <p>
          <strong className="text-foreground">What Connect does and does not control.</strong> Rem0te decides who may
          launch a session to which device and records it; RustDesk carries the session. Once connected, clipboard,
          file transfer and RustDesk&apos;s in-session chat are RustDesk&apos;s own defaults (the Chat tab is separate), a device installed by Rem0te accepts its password
          without asking the person at it, and nothing ends a session from the portal. <em>Client opened</em> is not a
          connection; <em>Connection confirmed</em> comes from the device&apos;s agent or from you. Platform Admins,
          technician managers and Business Owners can see every control and its effective state under Settings →
          Security → Security Features. More in{' '}
          <Link href="/docs/security-model" className="underline text-foreground">Security model</Link>.
        </p>
        <p>
          Customers can ask for help through their customer&apos;s support link, without an account. Requests appear
          under <Link href="/support-requests" className="underline text-foreground">Remote support → Support requests</Link>: claim
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
          holds the software Rem0te may install on Windows devices: winget packages, each pinned to one exact version,
          one installer SHA-256 and a <strong className="text-foreground">detection rule</strong> that says how a device
          tells whether it is installed. A customer&apos;s Business Owner keeps its own entries; a Platform Admin keeps the
          global ones. Every change needs a fresh sign-in and is recorded in the audit log with the hash and rule before and
          after. The hash comes from the package&apos;s installer manifest in the public winget-pkgs repository, which the
          server reads when you save, or is pasted by you and recorded as pasted.
        </p>
        <p>
          <strong className="text-foreground">The hash check.</strong> Nothing is uploaded to Rem0te and the portal serves no
          installer. Each device downloads the installer with winget from winget&apos;s own source, hashes the downloaded
          file itself and refuses it — installing nothing — unless it matches the pinned SHA-256 and the hash in the manifest
          winget downloaded beside it. winget&apos;s own hash check then applies when it installs.{' '}
          <strong className="text-foreground">The gap that remains:</strong> the install step downloads the installer again,
          so the bytes actually installed are verified by winget against the source manifest, not hashed again by the agent.
        </p>
        <p>
          <strong className="text-foreground">Approval, canary and rings.</strong> Installing and uninstalling are always high
          risk: every plan needs two approvers on the approval signer with a passkey, you cannot approve your own request,
          and nothing in this portal can approve. Software plans are not offered to ClientSt0r. A deployment starts with one{' '}
          <em>canary</em> device and then up to four rings of 25. The next ring can be requested only once the one before
          it has passed: the canary&apos;s detection rule must confirm the change (a canary that already had it proves
          nothing), failures must stay within the threshold you set, and the soak time must have passed. A deployment
          keeps the entry as it was; if the entry is changed or archived, no further ring is requested. Devices are never
          restarted. On one device, the <em>Software</em> tab&apos;s <strong className="text-foreground">Managed software</strong>{' '}
          offers Install and Uninstall when the server allows them — a one-device deployment, approved the same way — and
          otherwise says why not and what to do.
        </p>
        <p>
          <strong className="text-foreground">Detection rules and compliance.</strong> A rule is one of three kinds: a
          Programs and Features display name (exact or starting with), an uninstall registry key, or the version of a file
          under Program Files — each with a version that must be <em>at least</em> or <em>exactly</em> a value. The{' '}
          <Link href="/reports/software-compliance" className="underline text-foreground">Software compliance</Link> report
          counts each entry on each Windows device it applies to as compliant, outdated, missing or unknown, from the
          newest evidence: the inventory&apos;s installed-software list (display-name rules only) or what the device
          reported when a software plan ran there. Evidence older than the report&apos;s limit is unknown, never compliant.
        </p>
        <p>
          <strong className="text-foreground">When a device refuses.</strong> A device whose software is managed by
          Configuration Manager or Intune refuses software plans (<em>managed elsewhere</em>), and the portal stops offering
          them there. A device without a usable winget — App Installer missing, or older than 1.7 — reports{' '}
          <em>winget unavailable</em> or <em>winget too old</em> and runs nothing; its Software tab then warns before the
          next request. Software plans need the signed agent and the approval signer.{' '}
          <strong className="text-foreground">Archiving an entry (0.36)</strong> revokes it on the approval signer for good,
          so a device on the 0.36 signed agent refuses an install from it even if that install was approved before the
          archive. Uninstalls still run. If the signer doesn&apos;t confirm, nothing is archived.
        </p>
        <p data-help="winget-catalog">
          <strong className="text-foreground">Search and one-click install (0.41).</strong> The server keeps a copy of
          the winget community catalog&apos;s package index, read at most daily from winget&apos;s own source (no
          credentials, no redirects, size-capped). Search it on a device&apos;s Software tab or on the catalog page and
          click <em>Install</em>: the server reads that version&apos;s manifest, picks the machine-wide installer winget
          would choose for the device&apos;s architecture, pins its hash, derives the detection rule from what the
          installer registers, adds the package to the customer&apos;s catalog if it is not there (Business Owner or
          Platform Admin, fresh sign-in, audited) and requests the install. Anything it cannot decide is refused with the
          reason rather than guessed. From 0.42 both search boxes show when the index was last read, how many packages it
          holds, its last error and when it is next read; an index never read says it is empty rather than finding
          nothing, and a Platform Admin can read it now from either place. Results put an exact name first, then a name
          starting with the word you typed (<em>Notepad++</em> for &ldquo;notepad&rdquo;), then the word anywhere in the
          name, shorter names first.
        </p>
        <p data-help="winget-browse">
          <strong className="text-foreground">Build a catalog by picking packages (0.43).</strong> The catalog page lists
          the whole winget index as a table, 50 a page, as soon as it opens: name, publisher, package id, latest version
          and which catalog already holds it, at what version. Type to filter it (best match first, or click
          <em> Name</em> to sort by name), pick a letter, or click a publisher to see only theirs. Choose the catalog to
          build (a Platform Admin: global or any customer; a Business Owner: their own), tick packages, and{' '}
          <em>Add N selected</em> adds up to 25 in one go, after a fresh sign-in. Each goes through the same manifest
          read, installer choice and detection rule as one, is audited, and its row says whether it was added, was
          already there, or was refused and why. <em>Remove</em> archives the ticked rows&apos; entries in that catalog.
          A device&apos;s Software tab lists its customer&apos;s and the global catalog first, each with{' '}
          <em>Install</em>, and the winget search below it.
        </p>
        <p data-help="remove-program">
          <strong className="text-foreground">Uninstall anything installed (0.41).</strong> Each program in a
          device&apos;s <em>Installed software</em> list has <em>Uninstall</em> when it can be removed with no one at the
          device. A program a catalog entry describes is uninstalled through that entry; any other is removed by its
          uninstall key: the device reads the key itself, refuses if it now names another program, and runs only
          Windows Installer (<code className="text-foreground">msiexec /x</code>) for an MSI product or the silent
          uninstall command the program registered — never an interactive one, a shell or a script host. It succeeds only
          if the key is gone afterwards. It is high risk, one device at a time, approved like any software plan (or
          signed at once in direct mode). From 0.42 the device also recognises the silent form of the common installer
          types when only an interactive uninstaller is registered: Windows Installer for the key&apos;s own product code,
          Inno Setup, NSIS (checked by the uninstaller&apos;s own header) and Chromium-based browsers. Microsoft 365
          Click-to-Run and driver packages stay refused, with the reason, and RustDesk and Rem0te are never removed from
          here. When a device&apos;s inventory predates this, one banner offers <em>Refresh inventory</em> instead of
          the same reason on every row.
        </p>
        <p>
          <strong className="text-foreground">None of this has run on real Windows yet.</strong> It has been tested against
          a simulated winget, a simulated uninstall registry and simulated devices only. More in{' '}
          <Link href="/docs/software-deployment" className="underline text-foreground">Software deployment</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'services-and-task-manager',
    title: 'Services and Task Manager',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          From 0.45 a Windows device&apos;s <strong className="text-foreground">Services</strong> tab can start, stop
          or restart a service, or change its <em>Startup type</em> (Automatic, Automatic (delayed start), Manual or
          Disabled). Its <strong className="text-foreground">Processes</strong> tab is a task manager — name, process
          id, user, CPU time, memory and start time, sortable and filterable — with <em>End process</em> on each row,
          optionally with the processes it started. Each is an approved action on that one device: high risk, signed
          by the approval signer, two approvers in signed mode, and in direct mode signed as soon as you confirm it is
          you. The containment <em>actions</em> pause stops both.
        </p>
        <p data-help="service-not-editable">
          <strong className="text-foreground">Editing a service means its startup type only.</strong> Its program
          (binary path), the account it runs as and its password, its recovery actions and its dependencies are never
          changed from here: each would let whoever changes it run a program as SYSTEM. Do those in a remote session.
        </p>
        <p>
          <strong className="text-foreground">What is protected.</strong> Security and core Windows services (Defender,
          the firewall, the event log, RPC, WMI, Task Scheduler, DHCP and DNS Client, and the rest), Rem0te&apos;s own
          service, and the core Windows, security, Rem0te and RustDesk processes have no buttons, and the device
          refuses them again. RustDesk can be restarted (only with no remote session open) or set to start
          automatically, never stopped or set to Manual or Disabled; Windows Update can be stopped but not disabled.
          <code className="text-foreground">svchost</code> says <em>stop the service instead</em>: it hosts several
          services at once.
        </p>
        <p>
          <strong className="text-foreground">What the device checks.</strong> A service must still have the display
          name the list showed, and drivers are never touched. A process must still have the same id, name and start
          time — Windows reuses process ids, so a different process that now has the id is never ended. The device
          uses only the service control manager and Windows&apos; own process calls (no <code className="text-foreground">sc.exe</code>,{' '}
          <code className="text-foreground">taskkill</code> or PowerShell), reads the result back and reports it; the tab
          then refreshes its list.
        </p>
        <p>
          <strong className="text-foreground">None of this has run on real Windows yet.</strong> It has been tested
          against a simulated service manager and process table only. More in{' '}
          <Link href="/docs/approved-actions#services-and-task-manager-045" className="underline text-foreground">Approved actions</Link>.
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
          Some actions — revealing a device password (including a Connect that uses it), changing permissions,
          managing technicians, SSO and passkey changes, making an install link, creating an API key, security settings
          and more — ask you to{' '}
          <strong className="text-foreground">confirm it&apos;s you</strong> with your password, an authenticator code
          or a passkey, even though you are signed in. If you have an authenticator, its code or a passkey is required —
          your password alone is not enough. It lasts 10 minutes for that sign-in.
        </p>
        <p>
          <strong className="text-foreground">Choosing which ones ask (0.49).</strong> A Platform Admin sets each function
          to <em>Ask</em> or <em>Don&apos;t ask</em> under{' '}
          <Link href="/settings?tab=confirm" className="underline text-foreground">Settings → Confirm it is you</Link>,
          in groups (software, patching, approved actions, agents, devices and enrolment, monitoring, reports and email,
          integrations, security and access), with <em>Don&apos;t ask for any</em> and <em>Ask for all</em>. Signing in is
          still required, permissions are still checked, and every change is still in the audit log. From 0.64 every
          function starts at <em>Don&apos;t ask</em>: you confirm it is you when you sign in, and only the list below asks
          again. Press <em>Ask for all</em> to have every function ask. Turning a confirmation off asks you once; turning one back on never does; every change of
          the setting is audited. These always ask, whatever is set: changing your own password or authenticator, adding
          or removing your passkeys, a protected-device exception (a passkey only), and turning a confirmation off.
        </p>
        <p>
          Making an install link and creating an API key can ask for every role, and are worth setting to Ask (from 0.64
          they start at Don&apos;t ask, like everything else). A link puts a device into a customer, and a key keeps
          working after you sign out: while either is Don&apos;t ask, an unattended or stolen session is enough. API keys that already have the enrolment scope
          keep working: a key cannot confirm anything, and is itself the second proof.
        </p>
        <p>
          You can add passkeys and link a single sign-on provider from{' '}
          <Link href="/account" className="underline text-foreground">My account</Link>. Password sign-in remains
          available unless your customer requires single sign-on and your account is linked to the provider.
        </p>
        <p>
          With single sign-on, a Platform Admin decides on{' '}
          <Link href="/admin/sso" className="underline text-foreground">Single sign-on</Link> how far each provider is
          trusted: whether its MFA counts as your second factor, whether its passkeys count as a passkey, and whether
          Platform Admins may use it (only with a passkey there). Signing out of the provider signs you out here, and
          signing out here signs you out there. If you sign in only through a provider, &quot;Confirm it is you&quot; offers
          <strong className="text-foreground"> Confirm with</strong> the provider; it asks you to sign in there again, and
          you then repeat what you were doing. A customer can be set to <strong className="text-foreground">Required</strong>{' '}
          once everyone in it is linked; up to two <strong className="text-foreground">break-glass</strong> Platform Admin
          accounts can always sign in with a password, an authenticator code and a passkey, and every such sign-in raises
          an alert. See Sign-in, SSO and passkeys, Single sign-on with Keycloak and Break-glass accounts in{' '}
          <Link href="/docs" className="underline text-foreground">Docs</Link>.
        </p>
        <p>
          When someone leaves, <strong className="text-foreground">Offboarding</strong> removes their access and lists
          which RustDesk passwords they had. Removing access does <strong className="text-foreground">not</strong>{' '}
          change a password someone already saw — rotate those devices&apos; credentials. A rotation stays pending until
          the device checks in and confirms it.
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
          redirect URI at each SSO provider. Enrolled devices are not affected.
        </p>
        <p>
          More in <Link href="/docs/setup#public-address" className="underline text-foreground">Setup → Public address</Link>.
        </p>
      </div>
    ),
  },
  {
    id: 'access-control',
    title: 'Access control',
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Rem0te has exactly three access levels. There is no reseller hierarchy and no separate
          role for billing, read-only or portal access.
        </p>
        <p className="font-medium text-foreground">Platform Admin</p>
        <p>
          The Rem0te operator. Creates and manages every customer, sees every device, and owns all
          platform settings and infrastructure.
        </p>
        <p className="font-medium text-foreground">Business Owner</p>
        <p>
          Full administrative control of one customer — its devices, its people, its sessions and
          its audit history. A Business Owner can never see another customer.
        </p>
        <p className="font-medium text-foreground">Business User</p>
        <p>
          Access is determined by permissions assigned by the Business Owner. New Business Users
          start with <strong className="text-foreground">View devices</strong> and{' '}
          <strong className="text-foreground">Remote connect</strong>; everything more
          administrative is off until granted.
        </p>
        <p>
          Manage all of this from{' '}
          <Link href="/users" className="underline text-foreground">Users</Link>, or from{' '}
          <Link href="/admin/access" className="underline text-foreground">Access control</Link> if
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
          Quick Connect is for helping someone whose device is{' '}
          <strong className="text-foreground">not</strong> an enrolled managed device — a one-off
          support call rather than a machine you look after.
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>Send them to <code className="rounded bg-muted px-1 py-0.5 text-xs">/quick</code>.</li>
          <li>They download and run the Quick Connect client. Nothing is installed as a service.</li>
          <li>It shows a Remote ID and a password; they read both to you.</li>
          <li>
            You enter them under{' '}
            <Link href="/quick-connect" className="underline text-foreground">Remote support → Quick Connect</Link>{' '}
            and connect.
          </li>
          <li>They close the client when you are done, which ends their availability.</li>
        </ol>
        <p>
          No permanent managed device is created, and the password is never stored by Rem0te — the
          fact that the remote person read it out to you is what authorises the session.
        </p>
        <p>
          Three switches have to line up: the platform master switch (Settings → Quick Connect), the
          per-customer switch, and the individual&apos;s{' '}
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
          Run the Quick start wizard
        </Link>
        .
      </p>
    </div>
  );
}
