/**
 * The approval page (v0.26), rendered by the signer from the plan it will
 * sign — not by the portal. Self-contained: no external scripts, styles,
 * fonts or images, a nonce CSP, and every value HTML-escaped.
 */
import type { Plan } from '../actions/catalog';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface View {
  jobId: string; status: string; digest: string; plan: Plan;
  action: { title: string; description: string; warnings: string[]; verification: string; doesNotProve: string[] };
  decisions: { name: string; role: string; decision: string; at: string }[];
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
    ? `<table class="inner"><tr><th>Update</th><th>Classification</th><th>Severity</th></tr>${p.display.updates.map((u) => `<tr><td>${u.kb ? `<strong>${esc(u.kb)}</strong> ` : ''}${esc(u.title)}<br><code>${esc(u.updateId)} rev ${esc(u.revision)}</code></td><td>${esc(u.className ?? 'unknown')}</td><td>${esc(u.severity ?? '—')}</td></tr>`).join('')}</table><p class="mut">Titles and KBs are as the computers reported them. Each computer installs an update only if Windows Update itself offers it as a security, critical, rollup or ordinary update.</p>`
    : '';
  const needs = [`${p.policy.approvalsRequired} approver${p.policy.approvalsRequired > 1 ? 's' : ''} (${p.policy.risk} impact)`]
    .concat(p.policy.customerSignoff ? ['customer sign-off from this business'] : []).join(' + ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve: ${esc(v.action.title)}</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#111;--mut:#555;--bd:#ddd;--warn:#7a4b00;--warnbg:#fff4dc;--ok:#0a6b2e}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--mut:#aaa;--bd:#333;--warn:#ffd28a;--warnbg:#3a2a08;--ok:#6fdc97}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:760px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px} .mut{color:var(--mut)} table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-top:1px solid var(--bd)} th{width:34%;color:var(--mut);font-weight:500}
.warn{background:var(--warnbg);color:var(--warn);border-radius:6px;padding:10px 12px;margin:12px 0} .warn li{margin:4px 0}
code{font-size:12px;word-break:break-all} table.inner{margin:6px 0} table.inner th{width:auto} ul{margin:4px 0;padding-left:20px} button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);cursor:pointer;margin-right:8px}
button.primary{background:var(--fg);color:var(--bg)} #msg{margin-top:12px} .ok{color:var(--ok)} select{font:inherit;padding:6px}
</style></head><body>
<p class="mut">Rem0te approval — this page is served by the approval signer, not the portal.</p>
<h1>${esc(v.action.title)}</h1>
<p>${esc(v.action.description)}</p>
<div class="warn"><strong>Before you approve</strong><ul>${v.action.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
<table>
${row('Customer', esc(t.businessName))}
${dep ? row('Deployment', `${esc(dep.name)} — <strong>${dep.ring === 0 ? 'canary (ring 0)' : `ring ${esc(dep.ring)}`}</strong> of ${esc(dep.rings)}`) : ''}
${row(p.targets.length === 1 ? 'Computer' : 'Computers', computers)}
${row('Action', updates ? `<code>${esc(p.action.id)}@${esc(p.action.version)}</code>, never restarting${updates}` : `<code>${esc(p.action.id)}@${esc(p.action.version)}</code> with <code>${esc(JSON.stringify(p.params))}</code>`)}
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
<script nonce="${nonce}">
(function(){
  var job=${JSON.stringify(v.jobId)};
  var b64u=function(buf){var s='',a=new Uint8Array(buf);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
  var fromB64u=function(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer};
  var msg=function(t,ok){var m=document.getElementById('msg');m.textContent=t;m.className=ok?'ok':''};
  function post(p,body){return fetch('/approve/'+job+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||j.error);return j})})}
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
  if(r)r.addEventListener('click',function(){if(confirm('Reject this plan? It cannot then be approved.'))decide('reject')});
})();
</script></body></html>`;
}
