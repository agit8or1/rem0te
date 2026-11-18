/**
 * The Windows Installer package (0.65): `GET /public/install/windows.msi`.
 *
 * What it is. A per-machine MSI that carries the signed agent, byte for byte
 * the published `windows/rem0te-agent.exe` target, in its Binary table, and
 * one deferred custom action that runs it as SYSTEM:
 *
 *     rem0te-agent.exe install --token [TOKEN] --portal [Rem0tePortal]
 *
 * That is exactly what the downloaded .exe does when double-clicked (its
 * bootstrap reads the portal and token from its patched slot and calls the
 * same `install`), so the MSI changes nothing about enrolment: the agent
 * verifies everything it installs against the signed metadata, validates the
 * token's charset itself, and the claim decides where the computer lands.
 *
 * How the token gets in. Either on the msiexec command line
 * (`msiexec /i rem0te.msi TOKEN=<hex> /qn`: Group Policy, Intune, an RMM) or,
 * for the Add device download button, stamped into this one download's
 * Property table. There is no cache: every request builds its package in its
 * own private temporary directory, which is removed before the response is
 * sent, so no token is ever in a shared or long-lived file on this server.
 *
 * Uninstalling it removes only the package's own registration and its one
 * registry marker. The agent is not the MSI's to remove: it updates itself
 * from signed releases, which a Windows Installer repair would roll back, and
 * a computer leaves through the console (offboarding), not through
 * Programs and Features. The custom action runs only on a first install
 * (`NOT Installed AND NOT REMOVE`), never on repair or uninstall.
 *
 * The spawn (§77): two fixed absolute binaries, an argument array, no shell, a
 * bounded time and output, a minimal environment. Every value that reaches an
 * argument is checked against a closed charset first, the token before
 * anything else, and a refused input never spawns anything. An error never
 * carries the command line (which may hold the token) out of this module.
 *
 * It has never run on real Windows.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validPortalHost } from '../update-trust/agent-migration';

export const WIXL_BIN = '/usr/bin/wixl';
export const MSIBUILD_BIN = '/usr/bin/msibuild';
/** The installers' token charset: a single-use claim token or a 96-hex deployment key. */
export const MSI_TOKEN_RE = /^[A-Fa-f0-9]{16,128}$/;
/** Windows Installer's ProductVersion: three numeric fields within its limits. */
export const MSI_VERSION_RE = /^(?:[0-9]|[1-9][0-9]{1,2})\.(?:[0-9]|[1-9][0-9]{1,2})\.(?:[0-9]|[1-9][0-9]{1,4})$/;
export const MSI_MAX_AGENT_BYTES = 64 * 1024 * 1024;
/** Above the agent's size, what the package may add (tables, summary). */
export const MSI_MAX_OVERHEAD_BYTES = 4 * 1024 * 1024;
export const MSI_BUILD_TIMEOUT_MS = 60_000;
export const MSI_MAX_CONCURRENT = 2;
export const MSI_FILENAME = 'rem0te.msi';
export const MSI_CONTENT_TYPE = 'application/x-msi';
/** Fixed for every build, so a newer package replaces an older one's registration. */
export const MSI_UPGRADE_CODE = '{6B0F5E2A-3C1D-4E5F-8A9B-0C1D2E3F4A5B}';
export const MSI_ACTION = 'Rem0teInstall';
/** msidbCustomActionTypeExe + BinaryData (2) | InScript (1024) | NoImpersonate (2048): deferred, as SYSTEM, return checked. */
export const MSI_ACTION_TYPE = 3074;
/** The formatted command line. The token comes first so the portal, last, always wins a repeated flag. */
export const MSI_ACTION_TARGET = 'install --token [TOKEN] --portal [Rem0tePortal]';
export const MSI_ACTION_CONDITION = 'NOT Installed AND NOT REMOVE';
/** After PublishProduct (6400), before InstallFinalize (6600): inside the script, as a deferred action must be. */
export const MSI_ACTION_SEQUENCE = 6500;
export const MSI_SECURE_PROPERTIES = 'TOKEN;WIX_DOWNGRADE_DETECTED;WIX_SAME_VERSION_UPGRADE_DETECTED;WIX_UPGRADE_DETECTED';

export type MsiErrorCode =
  | 'MSI_TOKEN_INVALID' | 'MSI_BAD_INPUT' | 'MSI_BUILDER_UNAVAILABLE' | 'MSI_BUSY' | 'MSI_AGENT_TOO_LARGE' | 'MSI_BUILD_FAILED';

export class MsiError extends Error {
  constructor(readonly code: MsiErrorCode, message: string) {
    super(message);
    this.name = 'MsiError';
  }
}

/**
 * The package source. Constant: every value is a preprocessor variable passed
 * as its own argument (`-D Name=value`), so nothing is ever interpolated into
 * XML. The launch condition refuses a TOKEN holding a space, a tab or a quote,
 * so it can only ever be one argument on the custom action's command line
 * (the agent then checks it is hex). It does not refuse a missing TOKEN on
 * uninstall or repair (`Installed`).
 */
export const MSI_WXS = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Rem0te agent installer" Language="1033" Version="$(var.Version)" Manufacturer="Rem0te" UpgradeCode="${MSI_UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="Rem0te agent installer" Comments="Installs the signed Rem0te agent and enrols this computer. Pass TOKEN=enrolment-code-or-deployment-key."/>
    <Property Id="Rem0tePortal" Value="$(var.Portal)"/>
    <Property Id="MsiHiddenProperties" Value="TOKEN"/>
    <Property Id="ARPNOMODIFY" Value="1"/>
    <Property Id="ARPNOREPAIR" Value="1"/>
    <Property Id="Rem0teQuote" Value='"'/>
    <Property Id="Rem0teTab" Value="&#9;"/>
    <Condition Message="Rem0te: pass TOKEN=&lt;enrolment code or deployment key&gt; (hexadecimal, no spaces or quotes), for example msiexec /i rem0te.msi TOKEN=... /qn">Installed OR (TOKEN AND NOT (TOKEN &gt;&lt; " ") AND NOT (TOKEN &gt;&lt; Rem0teTab) AND NOT (TOKEN &gt;&lt; Rem0teQuote))</Condition>
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer Rem0te agent installer is already registered on this computer."/>
    <Binary Id="Rem0teAgent" SourceFile="$(var.AgentExe)"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Component Id="Rem0teInstallerMarker" Guid="{7C1E0D2B-4A3F-4B5C-9D6E-1F2A3B4C5D6E}" Win64="yes">
        <RegistryValue Root="HKLM" Key="SOFTWARE\\Rem0te\\Installer" Name="MsiVersion" Value="$(var.Version)" Type="string" KeyPath="yes"/>
      </Component>
    </Directory>
    <Feature Id="Main" Level="1"><ComponentRef Id="Rem0teInstallerMarker"/></Feature>
  </Product>
</Wix>
`;

export interface MsiInput {
  /** Absolute path of the signed agent target (UpdateTrustService.agentTarget().path). */
  agentPath: string;
  /** host[:port] the agent installs from, the same host the .exe's slot names. */
  portalHost: string;
  /** ProductVersion; anything outside MSI_VERSION_RE becomes 0.0.0. */
  version: string;
  /** Stamped into this download's Property table when given. Never logged. */
  token?: string;
}

/** The runner, replaceable only by the unit test (to count spawns). Always called with a fixed binary. */
export type MsiRunner = (bin: typeof WIXL_BIN | typeof MSIBUILD_BIN, args: string[], cwd: string) => Promise<void>;

const runFixed: MsiRunner = (bin, args, cwd) => new Promise((resolve, reject) => {
  execFile(bin, args, {
    cwd, shell: false, windowsHide: true, timeout: MSI_BUILD_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: cwd, TMPDIR: cwd },
  }, (err) => (err ? reject(new Error('builder exited unsuccessfully')) : resolve()));
});

/** Both builder binaries present and executable. */
export async function msiToolsAvailable(access: (p: string, mode: number) => Promise<void> = fs.promises.access): Promise<boolean> {
  try {
    await access(WIXL_BIN, fs.constants.X_OK);
    await access(MSIBUILD_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every check that comes before a spawn. Throws MsiError; returns the normalised version. */
export function checkMsiInput(input: MsiInput): { version: string } {
  if (input.token !== undefined && !MSI_TOKEN_RE.test(input.token)) {
    throw new MsiError('MSI_TOKEN_INVALID', 'The enrolment token is not a valid hex value.');
  }
  if (typeof input.portalHost !== 'string' || !validPortalHost(input.portalHost)) {
    throw new MsiError('MSI_BAD_INPUT', 'The portal address is not a host name.');
  }
  // The agent path comes from the signed repository's own resolution, but it
  // is still checked: absolute, a plain path charset, no traversal.
  if (typeof input.agentPath !== 'string' || !path.isAbsolute(input.agentPath) || !/^[A-Za-z0-9._/+-]{1,1024}$/.test(input.agentPath)
      || input.agentPath.split('/').includes('..')) {
    throw new MsiError('MSI_BAD_INPUT', 'The agent path is not usable.');
  }
  return { version: MSI_VERSION_RE.test(input.version) ? input.version : '0.0.0' };
}

/** The msibuild queries for one package. The token, already checked against MSI_TOKEN_RE, is the only variable. */
export function msiQueries(token?: string): string[] {
  const q = [
    `INSERT INTO \`CustomAction\` (\`Action\`, \`Type\`, \`Source\`, \`Target\`) VALUES ('${MSI_ACTION}', ${MSI_ACTION_TYPE}, 'Rem0teAgent', '${MSI_ACTION_TARGET}')`,
    `INSERT INTO \`InstallExecuteSequence\` (\`Action\`, \`Condition\`, \`Sequence\`) VALUES ('${MSI_ACTION}', '${MSI_ACTION_CONDITION}', ${MSI_ACTION_SEQUENCE})`,
    `UPDATE \`Property\` SET \`Value\` = '${MSI_SECURE_PROPERTIES}' WHERE \`Property\` = 'SecureCustomProperties'`,
  ];
  if (typeof token === 'string') {
    if (!MSI_TOKEN_RE.test(token)) throw new MsiError('MSI_TOKEN_INVALID', 'The enrolment token is not a valid hex value.');
    q.push(`INSERT INTO \`Property\` (\`Property\`, \`Value\`) VALUES ('TOKEN', '${token}')`);
  }
  return q;
}

let building = 0;

/**
 * Build one package. Throws MsiError (never an error naming the command line).
 * `run` and `access` exist only for the unit test.
 */
export async function buildWindowsMsi(
  input: MsiInput,
  deps: { run?: MsiRunner; access?: (p: string, mode: number) => Promise<void> } = {},
): Promise<Buffer> {
  const { version } = checkMsiInput(input);
  const queries = msiQueries(input.token);
  let agentSize: number;
  try {
    const st = await fs.promises.stat(input.agentPath);
    if (!st.isFile()) throw new Error('not a file');
    agentSize = st.size;
  } catch {
    throw new MsiError('MSI_BAD_INPUT', 'The agent binary is not readable.');
  }
  if (agentSize === 0 || agentSize > MSI_MAX_AGENT_BYTES) throw new MsiError('MSI_AGENT_TOO_LARGE', 'The agent binary is empty or too large to package.');
  if (!(await msiToolsAvailable(deps.access))) {
    throw new MsiError('MSI_BUILDER_UNAVAILABLE', 'This server cannot build an .msi: wixl and msibuild (the msitools package) are not installed.');
  }
  if (building >= MSI_MAX_CONCURRENT) throw new MsiError('MSI_BUSY', 'Other .msi downloads are being built; try again in a moment.');
  building++;
  const run = deps.run ?? runFixed;
  let dir: string | null = null;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rem0te-msi-'));
    await fs.promises.chmod(dir, 0o700);
    const wxs = path.join(dir, 'rem0te.wxs');
    const out = path.join(dir, MSI_FILENAME);
    await fs.promises.writeFile(wxs, MSI_WXS, { mode: 0o600 });
    try {
      await run(WIXL_BIN, ['-a', 'x64', '-D', `Version=${version}`, '-D', `Portal=${input.portalHost}`, '-D', `AgentExe=${input.agentPath}`, '-o', out, wxs], dir);
      const args = [out];
      for (const q of queries) args.push('-q', q);
      await run(MSIBUILD_BIN, args, dir);
    } catch {
      throw new MsiError('MSI_BUILD_FAILED', 'The .msi could not be built.');
    }
    let st: fs.Stats;
    try { st = await fs.promises.stat(out); } catch { throw new MsiError('MSI_BUILD_FAILED', 'The .msi could not be built.'); }
    if (!st.isFile() || st.size < agentSize || st.size > agentSize + MSI_MAX_OVERHEAD_BYTES) {
      throw new MsiError('MSI_BUILD_FAILED', 'The built .msi has an unexpected size.');
    }
    return await fs.promises.readFile(out);
  } finally {
    building--;
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
