/**
 * Static checks a reviewer sees before approving a script version.
 *
 * WARNINGS, never a verdict. These are line patterns: they catch the obvious
 * and point a reviewer at the lines worth reading. Obfuscated code passes
 * them, and a script with no findings is not thereby safe. Nothing is
 * blocked by a finding; a person decides. Pure (no Nest, no Prisma) so the
 * unit test and, later, the approval signer can run the same rules.
 */

export const CHECKER_VERSION = 1;
export type Severity = 'caution' | 'danger';

export interface Rule { id: string; severity: Severity; title: string; why: string; pattern: RegExp }
export interface Finding { rule: string; severity: Severity; title: string; why: string; line: number; excerpt: string }

const W = '(?<![\\w-])'; // start of a PowerShell word (not inside Foo-Bar or $x_y)

export const RULES: Rule[] = [
  { id: 'invoke_expression', severity: 'danger', title: 'Invoke-Expression',
    why: 'Runs a string as code. What runs is decided when the script runs, not when it is reviewed.',
    pattern: new RegExp(`${W}(Invoke-Expression|iex)(?![\\w-])`, 'i') },
  { id: 'download', severity: 'danger', title: 'Downloads from the network',
    why: 'Fetched content was never reviewed. Downloading and then running it is the classic way to bypass review.',
    pattern: /\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|bitsadmin|DownloadString|DownloadFile|DownloadData|OpenRead)\b|Net\.WebClient|Net\.Http\.HttpClient|(?<![\w-])(iwr|irm|wget|curl)(?![\w-])|certutil(\.exe)?\s+[^\n]*-urlcache/i },
  { id: 'encoded_command', severity: 'danger', title: 'Encoded command or Base64 code',
    why: '-EncodedCommand and decoded Base64 hide what runs from the reviewer.',
    pattern: /(?<![\w])-(EncodedCommand|enc|ec|e)\s+[A-Za-z0-9+/=]{16,}|-EncodedCommand\b|FromBase64String/i },
  { id: 'credential_material', severity: 'danger', title: 'Credential material',
    why: 'A password or key in a script is readable by anyone who can read the library, and in every place its output goes.',
    pattern: /ConvertTo-SecureString\b[^\n]*-AsPlainText|\$\w*(password|passwd|pwd|secret|apikey|api_key|token)\w*\s*=\s*['"][^'"]{3,}['"]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(mimikatz|sekurlsa|lsadump)\b|\blsass\b|\b(cmdkey|vaultcmd)(\.exe)?\b|Export-PfxCertificate|Get-Credential\b/i },
  { id: 'defender_disabled', severity: 'danger', title: 'Weakens Microsoft Defender',
    why: 'Turning protection off, or excluding paths from it, is what malware does first.',
    pattern: /Set-MpPreference\b[^\n]*-Disable\w*|Add-MpPreference\b[^\n]*-Exclusion\w*|DisableAntiSpyware|DisableRealtimeMonitoring|(Stop|Set)-Service\b[^\n]*WinDefend|sc(\.exe)?\s+(stop|config)\s+WinDefend/i },
  { id: 'execution_policy', severity: 'danger', title: 'Changes the execution policy',
    why: 'Set-ExecutionPolicy and -ExecutionPolicy Bypass switch off a control for everything after this script, not only for it.',
    pattern: /Set-ExecutionPolicy\b|-ExecutionPolicy\s+(Bypass|Unrestricted)|-ep\s+bypass/i },
  { id: 'forced_restart', severity: 'danger', title: 'Forces a restart or shutdown',
    why: 'Someone may be working on the computer, and unsaved work is lost without warning.',
    pattern: /(Restart|Stop)-Computer\b[^\n]*-Force|shutdown(\.exe)?\s+[^\n]*\/[rs]\b[^\n]*\/f\b|shutdown(\.exe)?\s+[^\n]*\/f\b[^\n]*\/[rs]\b/i },
  { id: 'restart', severity: 'caution', title: 'Restarts or shuts down the computer',
    why: 'A restart interrupts whoever is using it. Say so in the description, and prefer scheduling.',
    pattern: /(Restart|Stop)-Computer\b|shutdown(\.exe)?\s+[^\n]*\/[rsg]\b/i },
  { id: 'log_tampering', severity: 'danger', title: 'Clears event logs or audit policy',
    why: 'Removes the evidence of what happened on the computer.',
    pattern: /Clear-EventLog\b|Remove-EventLog\b|wevtutil(\.exe)?\s+(cl|clear-log)\b|auditpol(\.exe)?\s+[^\n]*\/(clear|remove)/i },
  { id: 'backup_deletion', severity: 'danger', title: 'Deletes shadow copies or backups',
    why: 'Ransomware deletes these before encrypting. A legitimate script rarely needs to.',
    pattern: /vssadmin(\.exe)?\s+delete|wbadmin(\.exe)?\s+delete|Win32_ShadowCopy[^\n]*(Delete|Remove)|Remove-CimInstance[^\n]*ShadowCopy|bcdedit[^\n]*recoveryenabled\s+no/i },
  { id: 'local_admin', severity: 'danger', title: 'Adds a local administrator',
    why: 'Grants full control of the computer to an account, outside your normal access process.',
    pattern: /Add-LocalGroupMember\b[^\n]*Administrators|net(\.exe)?\s+localgroup\s+administrators\s+[^\n]*\/add/i },
  { id: 'dynamic_code', severity: 'caution', title: 'Starts processes or loads code at runtime',
    why: 'What runs depends on files or input not in the reviewed text.',
    pattern: /\bAdd-Type\b|\[(System\.)?Reflection\.Assembly\]::Load|\bInvoke-Command\b|\bStart-Process\b|\bStart-Job\b|\bNew-Object\s+-ComObject\b|\[ScriptBlock\]::Create/i },
];

// Characters that make the text a reviewer reads differ from what runs:
// bidirectional overrides/isolates ("Trojan Source"), zero-width characters
// and a byte-order mark anywhere.
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const MAX_FINDINGS = 200;
const excerptOf = (line: string) => {
  const t = line.trim().replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase()}>`);
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};

/** Every finding, line by line, in rule order per line. Capped at MAX_FINDINGS. */
export function staticCheck(content: string, declaredRisk?: string): { checkerVersion: number; findings: Finding[]; truncated: boolean } {
  const findings: Finding[] = [];
  let truncated = false;
  const lines = content.split(/\r?\n/);
  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ruleHits = RULES.filter((r) => r.pattern.test(line));
    // A forced restart is also a restart; report the stronger one only.
    const hits = ruleHits.some((r) => r.id === 'forced_restart') ? ruleHits.filter((r) => r.id !== 'restart') : ruleHits;
    for (const r of hits) {
      if (findings.length >= MAX_FINDINGS) { truncated = true; break outer; }
      findings.push({ rule: r.id, severity: r.severity, title: r.title, why: r.why, line: i + 1, excerpt: excerptOf(line) });
    }
    if (HIDDEN.test(line)) {
      if (findings.length >= MAX_FINDINGS) { truncated = true; break; }
      findings.push({ rule: 'hidden_unicode', severity: 'danger', title: 'Hidden or direction-changing characters',
        why: 'Bidirectional overrides and zero-width characters make the text you read differ from the code that runs.', line: i + 1, excerpt: excerptOf(line) });
    }
  }
  if (declaredRisk === 'low' && findings.some((f) => f.severity === 'danger')) {
    findings.push({ rule: 'risk_understated', severity: 'caution', title: 'Declared risk is low',
      why: 'The author declared this script low risk, but it has danger findings. Check the declared risk before approving.', line: 0, excerpt: '' });
  }
  return { checkerVersion: CHECKER_VERSION, findings, truncated };
}
