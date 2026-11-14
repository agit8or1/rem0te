'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { aiApi, type AiAuthStyle, type AiProvider, type AiSettingsView } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Settings → AI (0.48): the one provider "Ask AI" uses on event-log entries
 * and alerts. Platform Admin only; saving asks for fresh authentication (never
 * skipped as an everyday change). The key is write-only: the page shows only
 * that one is set and its last four characters.
 */
const PROVIDERS: { id: AiProvider; label: string; hint: string }[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'api.anthropic.com, with your Anthropic API key.' },
  { id: 'openai', label: 'OpenAI', hint: 'api.openai.com, with your OpenAI API key.' },
  { id: 'openai_compatible', label: 'OpenAI-compatible (Azure, OpenRouter, Groq, Mistral…)', hint: 'Any service with an OpenAI-style /chat/completions endpoint at a public HTTPS address.' },
];
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const OTHER = '__other__';

type Form = { enabled: boolean; provider: AiProvider; modelPick: string; model: string; baseUrl: string; authStyle: AiAuthStyle; apiKey: string; clearKey: boolean };

function formFrom(d: AiSettingsView): Form {
  const provider = d.provider ?? 'anthropic';
  const model = d.model ?? d.defaults[provider] ?? '';
  const pick = provider === 'anthropic' ? (ANTHROPIC_MODELS.includes(model) ? model : OTHER) : OTHER;
  return { enabled: d.enabled, provider, modelPick: pick, model, baseUrl: d.baseUrl ?? '', authStyle: d.authStyle ?? 'bearer', apiKey: '', clearKey: false };
}

export default function AiSettingsPage() {
  const { user, isPlatformAdmin } = usePermissions();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: unknown) => setNotice({ ok: false, text: apiError(e).message });
  const { data, error } = useQuery<AiSettingsView>({ queryKey: ['ai-settings'], queryFn: () => aiApi.settings().then((r) => r.data.data), enabled: isPlatformAdmin, retry: false });
  const [f, setF] = useState<Form | null>(null);
  const askSave = useAsks('ai.settings');
  useEffect(() => { if (data && !f) setF(formFrom(data)); }, [data, f]);

  const effectiveModel = f ? (f.provider === 'anthropic' && f.modelPick !== OTHER ? f.modelPick : f.model.trim()) : '';
  const moved = !!data?.configured && !!f && (f.provider !== data.provider || (f.provider === 'openai_compatible' && (f.baseUrl.trim().replace(/\/+$/, '') !== (data.baseUrl ?? '') || f.authStyle !== data.authStyle)));

  const save = useMutation({
    mutationFn: () => aiApi.saveSettings({
      enabled: f!.enabled, provider: f!.provider, ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(f!.provider === 'openai_compatible' ? { baseUrl: f!.baseUrl.trim(), authStyle: f!.authStyle } : {}),
      ...(f!.apiKey ? { apiKey: f!.apiKey } : f!.clearKey ? { apiKey: null } : {}),
    }).then((r) => r.data.data as AiSettingsView),
    onSuccess: (r) => {
      setNotice({ ok: true, text: r.keyChange === 'cleared_destination_changed' ? 'Saved. The provider or address changed, so the saved key was removed — enter it again.' : 'AI settings saved.' });
      // Put what was saved in the cache before the form is rebuilt from it (as Settings → Email does).
      qc.setQueryData(['ai-settings'], r);
      setF(null); qc.invalidateQueries({ queryKey: ['ai-settings'] }); qc.invalidateQueries({ queryKey: ['ai-status'] });
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => aiApi.test().then((r) => r.data.data as { ok: boolean; status: string; model?: string; latencyMs?: number }),
    onSuccess: (r) => { setNotice({ ok: r.ok, text: r.ok ? `The provider answered (${r.model}, ${r.latencyMs} ms).` : `The test failed: ${r.status}.` }); qc.invalidateQueries({ queryKey: ['ai-settings'] }); },
    onError: fail,
  });

  if (!user) return null;
  if (!isPlatformAdmin) return <div className="p-6 text-sm text-muted-foreground">The AI provider is configured by a Platform Admin.</div>;
  const set = (p: Partial<Form>) => setF((x) => (x ? { ...x, ...p } : x));
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Link href="/settings" className="inline-flex items-center text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 h-4 w-4" />Settings</Link>
      <PageHeader title="AI" description="The model provider behind “Ask AI” on event-log entries and alerts. Off until a provider and key are saved and it is switched on." />
      {notice && <div className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{notice.text}</div>}
      {error ? <p className="text-sm text-muted-foreground">{apiError(error).message}</p> : null}
      {data && f && (
        <Card data-testid="ai-settings">
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Provider {data.configured ? (data.enabled ? <Badge>on</Badge> : <Badge variant="outline">off</Badge>) : <Badge variant="outline">not configured</Badge>}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Before anything is sent, the entry is redacted on this server: the computer&apos;s and business&apos;s names, host names, IP and MAC
              addresses, e-mail addresses, accounts and SIDs, user-profile paths, serial numbers, credentials and tokens are replaced.
              The provider sees the event&apos;s id, source, level, log, time, the redacted message and the Windows version — never which computer or business it came from.
            </p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enable Ask AI</label>
            <div className="space-y-1">
              <Label htmlFor="ai-provider">Provider</Label>
              <select id="ai-provider" className="w-full max-w-full rounded-md border bg-background p-2 md:w-[28rem]" value={f.provider}
                onChange={(e) => { const p = e.target.value as AiProvider; set({ provider: p, modelPick: p === 'anthropic' ? ANTHROPIC_MODELS[0] : OTHER, model: p === 'anthropic' ? ANTHROPIC_MODELS[0] : (data.defaults[p] ?? '') }); }}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{PROVIDERS.find((p) => p.id === f.provider)?.hint}</p>
            </div>
            {f.provider === 'anthropic' && (
              <div className="space-y-1">
                <Label htmlFor="ai-model-pick">Model</Label>
                <select id="ai-model-pick" className="w-full max-w-full rounded-md border bg-background p-2 md:w-96" value={f.modelPick} onChange={(e) => set({ modelPick: e.target.value })}>
                  {ANTHROPIC_MODELS.map((m) => <option key={m} value={m}>{m}{m === 'claude-sonnet-5-5' ? ' (default)' : ''}</option>)}
                  <option value={OTHER}>Other (type the model id)</option>
                </select>
              </div>
            )}
            {(f.provider !== 'anthropic' || f.modelPick === OTHER) && (
              <div className="space-y-1">
                <Label htmlFor="ai-model">Model id</Label>
                <Input id="ai-model" className="font-mono md:w-96" placeholder={f.provider === 'openai' ? 'gpt-5.1-mini' : f.provider === 'anthropic' ? 'claude-…' : 'e.g. llama-3.3-70b-versatile'} value={f.model} onChange={(e) => set({ model: e.target.value })} />
              </div>
            )}
            {f.provider === 'openai_compatible' && (
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1 md:col-span-2">
                  <Label htmlFor="ai-base">Base URL</Label>
                  <Input id="ai-base" className="font-mono" placeholder="https://api.groq.com/openai/v1" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Requests go to this address plus <span className="font-mono">/chat/completions</span>. It must be https on a public host name; it is resolved and checked again on every call, certificates are verified and redirects are not followed.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ai-auth">Key header</Label>
                  <select id="ai-auth" className="w-full rounded-md border bg-background p-2" value={f.authStyle} onChange={(e) => set({ authStyle: e.target.value as AiAuthStyle })}>
                    <option value="bearer">Authorization: Bearer</option>
                    <option value="api-key">api-key (Azure)</option>
                  </select>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="ai-key">API key</Label>
              <Input id="ai-key" type="password" autoComplete="new-password" className="md:w-96" placeholder={data.keySet ? `set · …${data.keyLast4 ?? ''} — leave blank to keep` : 'Not set'} value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value, clearKey: false })} />
              {data.keySet && <p className="text-xs text-muted-foreground">Saved key: set · …{data.keyLast4}</p>}
              {data.keySet && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.clearKey} onChange={(e) => set({ clearKey: e.target.checked, apiKey: '' })} />Remove the saved key</label>}
              {moved && data.keySet && !f.apiKey && <p className="text-xs text-amber-700 dark:text-amber-300">You changed the provider, base URL or key header: the saved key will be removed unless you enter it again, so it is never sent somewhere other than where it was entered for.</p>}
              <p className="text-xs text-muted-foreground">Stored encrypted on this server and never shown again. Changes are audited; the key never is.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={save.isPending || (f.provider === 'openai_compatible' && !f.baseUrl.trim()) || !effectiveModel} onClick={() => save.mutate()}>{`Save${reauthSuffix(askSave)}`}</Button>
              <Button variant="ghost" onClick={() => setF(null)}>Discard changes</Button>
            </div>
            {data.updatedAt && <p className="text-xs text-muted-foreground">Last changed {new Date(data.updatedAt).toLocaleString()}.</p>}
          </CardContent>
        </Card>
      )}
      {data?.configured && (
        <Card data-testid="ai-test">
          <CardHeader><CardTitle className="text-sm">Test the provider</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">Sends a tiny prompt (“Reply with OK”) with the saved settings, whether or not Ask AI is switched on. No event data is sent.</p>
            <Button variant="outline" disabled={test.isPending || !data.keySet} onClick={() => test.mutate()}>Test</Button>
            {!data.keySet && <p className="text-xs text-muted-foreground">Save a key first.</p>}
            <p className="text-xs text-muted-foreground">Last test: {data.lastTestAt ? `${new Date(data.lastTestAt).toLocaleString()} — ${data.lastTestResult}` : 'never'}.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
