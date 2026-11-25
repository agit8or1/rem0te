/**
 * Deployment instructions (0.57), generated in the browser. `key` is either a
 * deployment key the person typed or pasted on this page, or the literal
 * placeholder `<DEPLOYMENT-KEY>`. Nothing here is fetched from the server, so
 * a key never travels anywhere it was not already.
 *
 * Every recipe runs one of the existing installers with the key as its token:
 * the Windows script (which installs the signed agent when this server
 * publishes one), linux.sh or macos.sh. They are the Add device installers;
 * nothing is installer-specific to deployment keys. The .msi (0.65) runs the
 * signed agent's own `install --token`, the same thing the .exe does.
 */
export interface Recipe {
  id: string;
  label: string;
  intro: string;
  steps: { text: string; code?: string }[];
  note?: string;
}

export function deploymentRecipes(origin: string, key: string): Recipe[] {
  const win = `${origin}/api/v1/public/install/win/${key}`;
  const linux = `${origin}/api/v1/public/install/linux/${key}`;
  const mac = `${origin}/api/v1/public/install/mac/${key}`;
  // Both agents keep this task; its presence means "already installed".
  const guard = `if (Get-ScheduledTask -TaskName 'Rem0teHeartbeat' -ErrorAction SilentlyContinue) { exit 0 }`;
  const ps1 = [
    '# install-rem0te.ps1 - runs as SYSTEM. Exits at once on a device that already has the agent.',
    guard,
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `$log = Join-Path $env:ProgramData 'Rem0te-deploy.log'`,
    `try { Invoke-RestMethod -UseBasicParsing '${win}' | Invoke-Expression *>> $log } catch { "$(Get-Date -Format o) $_" | Out-File -Append $log; exit 1 }`,
  ].join('\n');
  const oneLinerWin = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${guard}; irm '${win}' | iex"`;
  return [
    {
      id: 'gpo', label: 'Group Policy',
      intro: 'A device startup script, which Windows runs as SYSTEM before anyone signs in. Works for every device in the OUs you link it to, through Active Directory.',
      steps: [
        { text: 'Save this as install-rem0te.ps1 in the GPO’s Scripts\\Startup folder (or a share every device account can read):', code: ps1 },
        { text: 'Group Policy Management → create a GPO → Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown) → Startup → PowerShell Scripts → Add install-rem0te.ps1.' },
        { text: 'Link the GPO to the OU holding the devices. They install on their next restart (or after gpupdate /force and a restart).' },
        { text: 'Watch Devices → Unassigned (a review key) or the customer’s device list (a straight-in key).' },
      ],
      note: 'The script is stored in SYSVOL, readable by every device and user in the domain: use a key with a sensible use limit and expiry, and revoke it when the rollout is done. The first line makes it a no-op on every later boot.',
    },
    {
      id: 'intune', label: 'Intune',
      intro: 'Either a platform script (simplest) or a Win32 app (for a detection rule and retries). Both run as SYSTEM.',
      steps: [
        { text: 'Platform script: Devices → Scripts and remediations → Platform scripts → Add → Windows 10 and later. Upload this as install-rem0te.ps1; run as the logged-on user: No; enforce signature check: No; run in 64-bit PowerShell: Yes.', code: ps1 },
        { text: 'Or Win32 app: package install-rem0te.ps1 with IntuneWinAppUtil.exe (on a Windows device), then use this install command:', code: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\install-rem0te.ps1' },
        { text: 'Uninstall command: leave a no-op (remove the agent from the console). Install behaviour: System. Detection rule: custom script —', code: `if (Get-ScheduledTask -TaskName 'Rem0teHeartbeat' -ErrorAction SilentlyContinue) { 'Installed' }` },
        { text: 'Assign to a device group.' },
      ],
      note: 'Intune keeps the script content; anyone who can read the policy can read the key. Same advice: a use limit, an expiry, and revoke it afterwards. For an .msi (a line-of-business app), see the Windows Installer (.msi) tab.',
    },
    {
      id: 'msi', label: 'Windows Installer (.msi)',
      intro: 'One .msi (0.65) that installs the signed agent silently, as SYSTEM, and takes the key as TOKEN. The plain download carries no key, so it can sit on a share or in Intune; the key is given on the command line. It has not yet been run on real Windows: try it on one device first.',
      steps: [
        { text: 'Download the package (no key inside):', code: `${origin}/api/v1/public/install/windows.msi` },
        { text: 'Install silently (as an administrator, or from your RMM as SYSTEM):', code: `msiexec /i rem0te.msi TOKEN=${key} /qn /l*v "%ProgramData%\\Rem0te-msi.log"` },
        { text: 'Intune: Apps → Windows → Add → Line-of-business app → upload rem0te.msi, and put this in Command-line arguments:', code: `TOKEN=${key}` },
        { text: 'Group Policy Software Installation cannot pass TOKEN on a command line. Either use the startup script on the Group Policy tab, or download a package with the key already in it and assign that (the key then lives in the share, like the script):', code: `${origin}/api/v1/public/install/windows.msi?token=${key}` },
      ],
      note: 'Uninstalling the .msi removes only its own entry in Programs and Features, never the agent: remove a device from the console. The .msi needs this server to publish the signed agent. TOKEN is hidden from the installer log; a package with the key built in is kept in Windows\'s installer cache on each device, so revoke the key when the rollout is done.',
    },
    {
      id: 'rmm', label: 'Existing RMM',
      intro: 'Any tool that can run a command as SYSTEM (or root) on its devices: ConnectWise Automate, NinjaOne, Datto, Tactical RMM, PDQ, SCCM and so on.',
      steps: [
        { text: 'Windows (run as SYSTEM):', code: oneLinerWin },
        { text: 'Linux (run as root):', code: `curl -fsSL '${linux}' | bash` },
        { text: 'macOS (run as root):', code: `curl -fsSL '${mac}' | bash` },
      ],
      note: 'The other RMM’s job history will hold the key; revoke it when you are done.',
    },
    {
      id: 'manual', label: 'Manual',
      intro: 'One device at a time, with the same key — for a small office or a handful of stragglers.',
      steps: [
        { text: 'Windows: open PowerShell as Administrator and run', code: `irm '${win}' | iex` },
        { text: 'Or download an installer with the key built in (double-click, accept the UAC prompt):', code: `${origin}/api/v1/public/install/windows.exe?token=${key}` },
      ],
      note: 'For one device, Devices → Add device makes a single-use code instead, which is safer to hand to someone.',
    },
    {
      id: 'linux', label: 'Linux',
      intro: 'Installs RustDesk and the read-only Linux agent (heartbeat, inventory, pending updates). It runs nothing the console sends.',
      steps: [
        { text: 'Quick (as root):', code: `curl -fsSL '${linux}' | sudo bash` },
        { text: 'Checked: download, read and checksum it first, then run the file you read —', code: `curl -fsSLo rem0te-install.sh '${linux}'\nsha256sum rem0te-install.sh\nless rem0te-install.sh\nsudo bash rem0te-install.sh` },
        { text: 'For Ansible, Salt or cloud-init, distribute the file you checked and run it as root; compare its SHA-256 with the one you recorded.' },
      ],
      note: 'The script is generated per key and per server settings, so there is no fixed published checksum: record the one you checked on the day and compare against that.',
    },
    {
      id: 'macos', label: 'macOS',
      intro: 'A shell script run as root — from Terminal, or as a script in your MDM (Jamf Pro, Kandji, Mosyle, Intune for macOS).',
      steps: [
        { text: 'Terminal:', code: `curl -fsSL '${mac}' | sudo bash` },
        { text: 'MDM script payload (runs as root):', code: `#!/bin/bash\nset -euo pipefail\ncurl -fsSL '${mac}' | bash` },
        { text: 'Approve RustDesk’s Screen Recording and Accessibility permissions with a PPPC profile from your MDM, or by hand on each Mac.' },
      ],
      note: 'There is no .pkg: building, signing and notarising a macOS package needs Apple’s tools and an Apple Developer ID, which this Linux server does not have. Use the script above; most MDMs run scripts as root.',
    },
  ];
}
