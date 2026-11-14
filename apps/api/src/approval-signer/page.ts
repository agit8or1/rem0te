/**
 * The approval page (v0.26), rendered by the signer from the plan it will
 * sign — not by the portal. Self-contained: no external scripts, styles,
 * fonts or images, a nonce CSP, and every value HTML-escaped.
 */
import { REBOOT_UNPROVEN, UPDATE_RESTART_WARNING_MINUTES, type Plan } from '../actions/catalog';
import { CLASSIFICATIONS as CLASS_NAME, type PolicyDoc } from '../actions/patch-policy';
import { resultKeyFingerprint } from '../actions/device-result';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface View {
  jobId: string; status: string; digest: string; plan: Plan;
  action: { title: string; description: string; warnings: string[]; verification: string; doesNotProve: string[] };
  decisions: { name: string; role: string; decision: string; at: string }[];
  /** windows.script.run (0.34): the content from this signer's allowlist; null when the entry is gone. */
  scriptContent?: string | null;
}

export function renderApprovalPage(v: View, nonce: string): string {
  const p = v.plan;
  const t = p.targets[0];
  const row = (k: string, val: string) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  const fmt = (iso: string) => `${esc(new Date(iso).toUTCString())}`;
  const computers = p.targets.length === 1
    ? `${esc(t.hostname)} <span class="mut">(${esc(t.deviceClass.toLowerCase())}, RustDesk ID ${esc(t.rustdeskId)})</span>`
    : `<strong>${p.targets.length} computers</strong><ul>${p.targets.map((x) => `<li>${esc(x.hostname)} <span class="mut">(${esc(x.deviceClass.toLowerCase())}, RustDesk ID ${esc(x.rustdeskId)})</span></li>`).join('')}</ul>`;
  const dep = p.display?.deployment;
  const updates = p.display?.updates?.length
    ? `<table class="inner"><tr><th>Update</th><th>Classification</th><th>Severity</th></tr>${p.display.updates.map((u) => `<tr><td>${u.kb ? `<strong>${esc(u.kb)}</strong> ` : ''}${esc(u.title)}<br><code>${esc(u.updateId)} rev ${esc(u.revision)}</code></td><td>${esc(u.className ?? 'unknown')}</td><td>${esc(u.severity ?? '—')}</td></tr>`).join('')}</table><p class="mut">Titles and KBs are as the computers reported them. Each computer installs an update only if Windows Update itself offers it as a security, critical, rollup, ordinary, driver or definition update.</p>`
    : '';
  const restarts = (p.params as { reboot?: unknown }).reboot === 'if_required_in_window'
    ? `<strong>restarting if Windows requires it</strong>, after a fixed ${UPDATE_RESTART_WARNING_MINUTES}-minute warning, only inside the window below and never while a RustDesk session is open. <span class="mut">${esc(REBOOT_UNPROVEN)}</span>`
    : 'never restarting';
  // 0.34: what a software plan installs. The params are what the computer
  // acts on; the name and publisher are the catalog's labels for them.
  const software = (pl: typeof p) => {
    const sw = pl.display!.software!;
    const pr = pl.params as { packageId?: string; version?: string; installerSha256?: string; detection?: unknown };
    return `<strong>${esc(sw.name)}</strong>${sw.publisher ? ` <span class="mut">(${esc(sw.publisher)})</span>` : ''}<br>winget package <code>${esc(pr.packageId ?? '')}</code> version <code>${esc(pr.version ?? '')}</code>, machine-wide`
      + `<br>Installer SHA-256 <code>${esc(pr.installerSha256 ?? '')}</code> — ${sw.hashSource === 'winget_pkgs' ? `read from the winget-pkgs manifest (manifest SHA-256 <code>${esc((sw.manifestSha256 ?? '').slice(0, 16))}…</code>)` : '<strong>typed in by the catalog\'s editor</strong>, not read from a manifest'}`
      + `<br><span class="mut">Each computer hashes the installer winget downloads and installs nothing unless it is exactly this hash. Detection rule: <code>${esc(JSON.stringify(pr.detection ?? null))}</code></span>`;
  };
  const needs = [`${p.policy.approvalsRequired} approver${p.policy.approvalsRequired > 1 ? 's' : ''} (${p.policy.risk} impact)`]
    .concat(p.policy.customerSignoff ? ['customer sign-off from this business'] : []).join(' + ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve: ${esc(v.action.title)}</title>
<style nonce="${nonce}">${STYLE}table.inner{margin:6px 0} table.inner th{width:auto}
</style></head><body>
<p class="mut">Rem0te approval — this page is served by the approval signer, not the portal.</p>
<h1>${esc(v.action.title)}</h1>
<p>${esc(v.action.description)}</p>
<div class="warn"><strong>Before you approve</strong><ul>${v.action.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
<table>
${row('Customer', esc(t.businessName))}
${dep ? row('Deployment', `${esc(dep.name)} — <strong>${dep.ring === 0 ? 'canary (ring 0)' : `ring ${esc(dep.ring)}`}</strong> of ${esc(dep.rings)}`) : ''}
${row(p.targets.length === 1 ? 'Computer' : 'Computers', computers)}
${p.script ? scriptRows(p, v.scriptContent ?? null, row) : ''}
${row('Action', p.script ? `<code>${esc(p.action.id)}@${esc(p.action.version)}</code>` : updates || p.action.id === 'windows.update.install' ? `<code>${esc(p.action.id)}@${esc(p.action.version)}</code>, ${restarts}${updates || `<br><code>${esc(JSON.stringify(p.params))}</code>`}` : `<code>${esc(p.action.id)}@${esc(p.action.version)}</code> with <code>${esc(JSON.stringify(p.params))}</code>`)}
${p.display?.software ? row('Software', software(p)) : ''}
${p.display?.policy ? row('Signed under', `patch policy <strong>${esc(p.display.policy.name)}</strong> <span class="mut">(${esc(p.display.policy.digest.slice(0, 16))}…)</span>, approved once by the people listed below; this signer checked the plan is inside it`) : ''}
${row('Requested by', `${esc(p.requestedBy.name)} <span class="mut">via ${esc(p.requestedBy.via)}</span>`)}
${row('Origin', p.origin.kind === 'ai_suggestion' ? `<strong>AI suggestion</strong>${p.origin.ticketRef ? ` from ticket ${esc(p.origin.ticketRef)}` : ''} — nothing runs without your explicit approval` : 'Technician')}
${row('Reason', esc(p.reason))}
${row('May run', `${fmt(p.window.notBefore)} → ${fmt(p.window.notAfter)}`)}
${row('Needs', esc(needs))}
${row('Afterwards', `${esc(v.action.verification)} It does <em>not</em> show ${v.action.doesNotProve.map(esc).join(', ')}.`)}
${row('Agent build', `<code>${esc(p.artifact.sha256)}</code>`)}
${row('Plan digest', `<code>${esc(v.digest)}</code>`)}
${row('Status', `<strong id="status">${esc(v.status.replace(/_/g, ' ').toLowerCase())}</strong>`)}
${row('Decisions', v.decisions.length ? v.decisions.map((d) => `${esc(d.name)} — ${esc(d.decision)} as ${esc(d.role)}, ${fmt(d.at)}`).join('<br>') : '<span class="mut">none yet</span>')}
</table>
${v.status === 'AWAITING_APPROVAL' ? `
<p>Deciding asks for your passkey. Your decision is bound to the digest above and to nothing else.</p>
<label>Decide as <select id="role"><option value="approver">approver</option>${p.policy.customerSignoff ? '<option value="customer">customer sign-off</option>' : ''}</select></label>
<p><button class="primary" id="approve">Approve with passkey</button><button id="reject">Reject</button></p>` : ''}
<div id="msg" role="status"></div>
${decideScript(nonce, `/approve/${v.jobId}`, 'plan')}</body></html>`;
}

/** What a script-run plan names: the allowlisted version, its hash, the arguments, the timeout and the content. */
function scriptRows(p: Plan, content: string | null, row: (k: string, v: string) => string): string {
  const s = p.script!;
  const params = p.params as { parameters?: Record<string, unknown>; timeoutMinutes?: number };
  const args = Object.entries(params.parameters ?? {});
  const lines = content === null ? '' : content.split(/\r?\n/).map((l, i) => `<span class="mut">${String(i + 1).padStart(4, ' ')}</span>  ${esc(l)}`).join('\n');
  return [
    row('Script', `<strong>${esc(s.name)}</strong> v${esc(s.version)} <span class="mut">(${s.businessId ? 'this business\'s script' : 'global script'}, declared ${esc(s.risk)} risk)</span>`),
    row('Content SHA-256', `<code>${esc(s.contentSha256)}</code><br><span class="mut">On this signer's allowlist (entry ${esc(s.allowlistId)}). Each computer refuses bytes that do not hash to it.</span>`),
    row('Arguments', args.length ? `<ul>${args.map(([k, v]) => `<li><code>-${esc(k)}</code> = <code>${esc(JSON.stringify(v))}</code></li>`).join('')}</ul><span class="mut">Checked against the declared parameters here and on each computer; passed as data, never as command text.</span>` : '<span class="mut">none</span>'),
    row('Timeout', `${esc(params.timeoutMinutes)} minute${params.timeoutMinutes === 1 ? '' : 's'}, then everything the script started is stopped`),
    row('Wrote the script', `${s.contributors.length} person(s) <span class="mut">— none of them can approve this run</span>`),
    content === null ? row('The script', '<strong>This signer no longer holds this script\'s content.</strong> Do not approve.')
      : `<tr><td colspan="2"><details open><summary>The script (${esc(s.contentBytes)} bytes)</summary><pre data-script>${lines}</pre></details></td></tr>`,
  ].join('\n');
}

/** The passkey decision script, shared by the plan and policy pages. `base` is built from a validated hex id. */
function decideScript(nonce: string, base: string, noun: string): string {
  return `<script nonce="${nonce}">
(function(){
  var base=${JSON.stringify(base)};
  var b64u=function(buf){var s='',a=new Uint8Array(buf);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
  var fromB64u=function(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer};
  var msg=function(t,ok){var m=document.getElementById('msg');m.textContent=t;m.className=ok?'ok':''};
  function post(p,body){return fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||j.error);return j})})}
  function decide(decision){
    var role=document.getElementById('role').value;
    post('/challenge',{decision:decision,role:role}).then(function(c){
      return navigator.credentials.get({publicKey:{challenge:fromB64u(c.options.challenge),rpId:c.options.rpId,timeout:c.options.timeout,userVerification:'required',allowCredentials:[]}}).then(function(cred){
        var r=cred.response;
        return post('/decide',{challengeId:c.challengeId,assertion:{id:cred.id,rawId:b64u(cred.rawId),type:cred.type,clientExtensionResults:{},response:{clientDataJSON:b64u(r.clientDataJSON),authenticatorData:b64u(r.authenticatorData),signature:b64u(r.signature),userHandle:r.userHandle?b64u(r.userHandle):undefined}}});
      });
    }).then(function(v){msg('Recorded. Status: '+v.status.replace(/_/g,' ').toLowerCase()+'.',true);setTimeout(function(){location.reload()},1500)}).catch(function(e){msg('Not recorded: '+e.message)});
  }
  var a=document.getElementById('approve'),r=document.getElementById('reject');
  if(a)a.addEventListener('click',function(){decide('approve')});
  if(r)r.addEventListener('click',function(){if(confirm(${JSON.stringify(`Reject this ${noun}? It cannot then be approved.`)}))decide('reject')});
})();
</script>`;
}

const STYLE = `
:root{--bg:#fff;--fg:#111;--mut:#555;--bd:#ddd;--warn:#7a4b00;--warnbg:#fff4dc;--ok:#0a6b2e}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--mut:#aaa;--bd:#333;--warn:#ffd28a;--warnbg:#3a2a08;--ok:#6fdc97}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:760px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px} .mut{color:var(--mut)} table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-top:1px solid var(--bd)} th{width:34%;color:var(--mut);font-weight:500}
.warn{background:var(--warnbg);color:var(--warn);border-radius:6px;padding:10px 12px;margin:12px 0} .warn li{margin:4px 0}
code{font-size:12px;word-break:break-all} ul{margin:4px 0;padding-left:20px} button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);cursor:pointer;margin-right:8px}
button.primary{background:var(--fg);color:var(--bg)} #msg{margin-top:12px} .ok{color:var(--ok)} select{font:inherit;padding:6px}
pre{overflow:auto;font-size:12px;line-height:1.45;white-space:pre}
`;


interface PolicyView {
  policyId: string; status: string; digest: string; doc: PolicyDoc;
  decisions: { name: string; role: string; decision: string; at: string }[];
  revokedAt: string | null; revokeReason: string | null; signedPlans: number;
  /** v0.34, by endpoint id: 'none', 'first_sight', 'changed' or 'pinned <iso>'. */
  keyStatus?: Record<string, string>;
}

/** The approval page for a patch policy (0.32). Approving it is approving every plan inside it, so it says so first. */
export function renderPolicyApprovalPage(v: PolicyView, nonce: string): string {
  const d = v.doc;
  const row = (k: string, val: string) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  const fmt = (iso: string) => `${esc(new Date(iso).toUTCString())}`;
  const key = (c: PolicyDoc['rings'][number][number]) => {
    if (!c.resultKey) return ' <span class="mut">— no result key (its results cannot open a later ring)</span>';
    const st = v.keyStatus?.[c.endpointId] ?? '';
    const note = st === 'changed' ? ' <strong>— NOT the key pinned for this computer: plans under this policy will be refused</strong>'
      : st === 'first_sight' ? ' <span class="mut">— first time this signer sees it: compare with <code>rem0te-agent.exe status</code> on the computer</span>'
        : st.startsWith('pinned ') ? ` <span class="mut">— pinned ${esc(new Date(st.slice(7)).toUTCString())}</span>` : '';
    return ` <span class="mut">result key</span> <code>${esc(resultKeyFingerprint(c.resultKey))}</code>${note}`;
  };
  const pc = (c: PolicyDoc['rings'][number][number]) => `${esc(c.hostname)} <span class="mut">(RustDesk ID ${esc(c.rustdeskId)})</span>${key(c)}`;
  const rings = d.rings.map((r, i) => `<li><strong>${i === 0 ? 'Ring 0 — canary' : `Ring ${i}`}</strong>: ${r.map(pc).join(', ')}</li>`).join('');
  const days = d.window.days.map((x) => x[0].toUpperCase() + x.slice(1)).join(', ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve patch policy: ${esc(d.name)}</title>
<style nonce="${nonce}">${STYLE}</style></head><body>
<p class="mut">Rem0te approval — this page is served by the approval signer, not the portal.</p>
<h1>Patch policy: ${esc(d.name)}</h1>
<p>Approve this once, and the approval signer signs each ring of Windows updates for these computers by itself, inside the window below, until the policy expires or is revoked. It does not ask you again for each ring.</p>
<div class="warn"><strong>Before you approve</strong><ul>
<li>Your approval stands in for yours on every ring plan signed under this policy. The signer refuses any plan outside it: another computer, another class of update, a KB excluded here, outside the window, after expiry, a ring out of order, or a later ring before the canary has confirmed every update took effect.</li>
<li>Installing updates changes computers. An update can break a driver or an application, and some cannot be uninstalled.</li>
${d.reboot === 'if_required_in_window'
    ? `<li>Computers restart. After installing, a computer Windows says needs a restart shows a fixed warning and restarts ${UPDATE_RESTART_WARNING_MINUTES} minutes later, closing programs still open without saving. It does not restart while a RustDesk session is open (or when it cannot tell), or after the window ends; then it stays "restart required" until someone restarts it, and the next ring waits for that. ${esc(REBOOT_UNPROVEN)}</li>`
    : '<li>Computers are never restarted. An update that needs a restart is reported as "restart required" until someone restarts it, and the next ring waits for that.</li>'}
<li>Each computer signs its own results with its result key, shown below. Approving binds that key to the computer: the signer opens a later ring only on results that key signed, so a portal cannot forge a canary success. A key shown as "first time" is trusted because you approve it here; to be sure it is the computer's, compare its fingerprint with <code>rem0te-agent.exe status</code> on that computer.</li>
</ul></div>
<table>
${row('Customer', esc(d.businessName))}
${row('Computers', `<ul>${rings}</ul><span class="mut">Bound to each computer's enrolled identity and result key. A re-enrolled computer is not covered.</span>`)}
${row('Installs', esc(d.allow.classifications.map((c) => CLASS_NAME[c] ?? c).join(', ')) + (d.allow.severities ? ` — severity ${esc(d.allow.severities.join(', '))} only` : '') + '<br><span class="mut">Only updates Windows Update itself offers each computer. Drivers and definition updates only if listed above. Never feature upgrades, feature or service packs, tools, optional updates, or anything needing a licence or (drivers excepted) someone at the keyboard.</span>')}
${row('Never installs', d.allow.excludeKbs ? esc(d.allow.excludeKbs.join(', ')) : '<span class="mut">no KBs excluded</span>')}
${row('Window', `${esc(days)}, ${esc(d.window.start)}–${esc(d.window.end)} <strong>${esc(d.window.timezone)}</strong> local time`)}
${row('Between rings', `soak ${esc(d.soakHours)} h; at most ${esc(d.failureThreshold)} failed computer(s) per ring before the deployment pauses itself`)}
${row('Restarts', d.reboot === 'if_required_in_window' ? `<strong>if Windows requires one</strong>, after a ${UPDATE_RESTART_WARNING_MINUTES}-minute warning, inside the window only, never with a RustDesk session open` : 'never')}
${row('Proposed by', `${esc(d.createdBy.name)} <span class="mut">(cannot approve it)</span>`)}
${row('Reason', esc(d.reason))}
${row('Expires', `${fmt(d.expiresAt)} <span class="mut">(then approved again)</span>`)}
${row('Needs', '2 approvers, other than the person who proposed it, plus customer sign-off where this business requires it')}
${row('Policy digest', `<code>${esc(v.digest)}</code>`)}
${row('Status', `<strong id="status">${esc(v.status.replace(/_/g, ' ').toLowerCase())}</strong>${v.revokedAt ? ` — revoked ${fmt(v.revokedAt)}: ${esc(v.revokeReason ?? '')}` : ''}`)}
${row('Plans signed under it', esc(v.signedPlans))}
${row('Decisions', v.decisions.length ? v.decisions.map((x) => `${esc(x.name)} — ${esc(x.decision)} as ${esc(x.role)}, ${fmt(x.at)}`).join('<br>') : '<span class="mut">none yet</span>')}
</table>
${v.status === 'AWAITING_APPROVAL' ? `
<p>Deciding asks for your passkey. Your decision is bound to the digest above and to nothing else.</p>
<label>Decide as <select id="role"><option value="approver">approver</option><option value="customer">customer sign-off</option></select></label>
<p><button class="primary" id="approve">Approve with passkey</button><button id="reject">Reject</button></p>` : ''}
<div id="msg" role="status"></div>
${decideScript(nonce, `/approve/policy/${v.policyId}`, 'policy')}</body></html>`;
}

interface ScriptView {
  id: string; status: string; contentSha256: string; definitionSha256: string;
  proposal: {
    name: string; version: number; description: string; businessId: string | null; businessName: string | null; risk: string; content?: string;
    parameters: { name: string; type: string; required: boolean; description?: string; charset?: string; maxLength?: number; min?: number; max?: number; choices?: string[] }[];
    contributors: { userId: string; name: string }[]; reviewedBy: { name: string; at: string }; proposedBy: { name: string };
  };
  decisions: { name: string; role: string; decision: string; at: string }[];
  revokedAt: string | null; revokeReason: string | null;
}

/**
 * The approval page for adding a script to this signer's allowlist (0.34).
 * It shows the content itself, as this process holds it, and the SHA-256
 * this process computed from it — not anything the portal said about it.
 */
export function renderScriptApprovalPage(v: ScriptView, nonce: string): string {
  const p = v.proposal;
  const row = (k: string, val: string) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  const fmt = (iso: string) => `${esc(new Date(iso).toUTCString())}`;
  const param = (x: ScriptView['proposal']['parameters'][number]) => `<li><code>-${esc(x.name)}</code> ${esc(x.type)}${x.type === 'string' ? `, ${esc(x.charset)} up to ${esc(x.maxLength)}` : x.type === 'integer' ? `, ${esc(x.min)} to ${esc(x.max)}` : x.type === 'choice' ? `: ${esc((x.choices ?? []).join(', '))}` : ''}${x.required ? ', required' : ''}${x.description ? ` — ${esc(x.description)}` : ''}</li>`;
  const lines = (p.content ?? '').split(/\r?\n/).map((l, i) => `<span class="ln">${i + 1}</span>${esc(l) || ' '}`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow script: ${esc(p.name)} v${esc(p.version)}</title>
<style nonce="${nonce}">${STYLE}pre{border:1px solid var(--bd);border-radius:6px;padding:8px;max-height:70vh}
.ln{display:inline-block;width:3em;color:var(--mut);user-select:none}</style></head><body>
<p class="mut">Rem0te approval — this page is served by the approval signer, not the portal.</p>
<h1>Allow script: ${esc(p.name)} <span class="mut">v${esc(p.version)}</span></h1>
<p>Approving adds this exact content to the approval signer's allowlist. Only then can anyone ask to run it, and every run still needs its own two approvals here. Nothing runs when you approve this.</p>
<div class="warn"><strong>Before you approve</strong><ul>
<li>Read the script below. It runs as SYSTEM with full PowerShell on any computer a run names: it can do anything an administrator can. The library review and its static checks are pattern matches and another person's opinion; they do not make it safe.</li>
<li>The SHA-256 below was computed by this signer from the content shown. The agent refuses any bytes that do not hash to it.</li>
<li>Once added it stays until it is revoked, and revocation is permanent: this content can never be added again.</li>
</ul></div>
<table>
${row('Business', p.businessId ? esc(p.businessName ?? p.businessId) : '<strong>Global</strong> — any business\'s computers')}
${row('Description', esc(p.description))}
${row('Declared risk', esc(p.risk))}
${row('Parameters', p.parameters.length ? `<ul>${p.parameters.map(param).join('')}</ul><span class="mut">Arguments are checked against these on the portal, here and on the computer, and passed as data, never as command text.</span>` : '<span class="mut">none</span>')}
${row('Written by', `${p.contributors.map((c) => esc(c.name)).join(', ')} <span class="mut">(none of them can approve this, or a run of it)</span>`)}
${row('Library review', `approved by ${esc(p.reviewedBy.name)}, ${fmt(p.reviewedBy.at)}`)}
${row('Proposed by', `${esc(p.proposedBy.name)} <span class="mut">(cannot approve it)</span>`)}
${row('Content SHA-256', `<code>${esc(v.contentSha256)}</code>`)}
${row('Definition SHA-256', `<code>${esc(v.definitionSha256)}</code>`)}
${row('Needs', '2 approvers for this business (or for every business, for a global script), other than whoever wrote or proposed it')}
${row('Status', `<strong id="status">${esc(v.status.replace(/_/g, ' ').toLowerCase())}</strong>${v.revokedAt ? ` — revoked ${fmt(v.revokedAt)}: ${esc(v.revokeReason ?? '')}` : ''}`)}
${row('Decisions', v.decisions.length ? v.decisions.map((x) => `${esc(x.name)} — ${esc(x.decision)}, ${fmt(x.at)}`).join('<br>') : '<span class="mut">none yet</span>')}
</table>
<h2>The script</h2>
<pre data-script>${lines}</pre>
${v.status === 'AWAITING_APPROVAL' ? `
<p>Deciding asks for your passkey. Your decision is bound to the definition hash above, which binds the content hash.</p>
<input type="hidden" id="role" value="approver">
<p><button class="primary" id="approve">Approve with passkey</button><button id="reject">Reject</button></p>` : ''}
<div id="msg" role="status"></div>
${decideScript(nonce, `/approve/script/${v.id}`, 'script')}</body></html>`;
}
