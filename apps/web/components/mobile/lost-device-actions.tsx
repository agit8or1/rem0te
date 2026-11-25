'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, MapPin, MapPinOff } from 'lucide-react';
import { mobileApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiError } from '@/components/security-controls/shared';
import { confirmSentence, reauthSuffix, useAsks } from '@/lib/confirm-policy';

/**
 * Lost-device commands on a mobile device's page (0.86 Lighthouse,
 * docs/own-mdm.md M4, §95): lock, start lost mode, stop lost mode. The
 * server decides which a device can take (`actions`, from the same rule the
 * send path applies again) and whether this person may send at all
 * (`canSend`, mobile:act). Nothing here is decided in the browser: a button
 * the server says is unavailable is shown disabled with its reason.
 *
 * Erase, wipe and retire do not exist here (M5).
 */
export type LostKind = 'lock' | 'lost_mode_start' | 'lost_mode_stop';
export interface LostOption { kind: LostKind; label: string; available: boolean; code: string | null; reason: string | null; takesMessage: boolean }

const MESSAGE_MAX = 160;
const PHONE_RE = /^[+0-9][0-9 ().-]{2,30}$/;
const ICON: Record<LostKind, typeof Lock> = { lock: Lock, lost_mode_start: MapPin, lost_mode_stop: MapPinOff };
const TITLE: Record<LostKind, string> = { lock: 'Lock this device?', lost_mode_start: 'Put this device in lost mode?', lost_mode_stop: 'Take this device out of lost mode?' };
const EXPLAIN: Record<LostKind, string> = {
  lock: 'Locks the screen now. The device needs its passcode to open again. Nothing is erased.',
  lost_mode_start: 'Locks the device and shows your message and phone number until lost mode is stopped. Nothing is erased.',
  lost_mode_stop: 'Ends lost mode, so the device can be unlocked with its passcode again.',
};

export function LostDeviceActions({ deviceId, provider, ownership, actions, canSend }: {
  deviceId: string; provider: string; ownership: 'corporate' | 'byod'; actions: LostOption[]; canSend: boolean;
}) {
  const ask = useAsks('mdm.act');
  const qc = useQueryClient();
  const [open, setOpen] = useState<LostOption | null>(null);
  const [message, setMessage] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const send = useMutation({
    mutationFn: (b: { kind: LostKind; message?: string; phoneNumber?: string }) => mobileApi.send(deviceId, b).then((r) => r.data.data),
    onSuccess: () => {
      setOpen(null); setMessage(''); setPhone('');
      setNote({ ok: true, text: provider === 'apple' ? 'Queued. The device is asked to check in; it is accepted when the device fetches it.' : 'Sent. Google accepted it; it is completed when the device reports so.' });
      qc.invalidateQueries({ queryKey: ['mobile-device-commands', deviceId] });
    },
    onError: (e) => { setNote({ ok: false, text: apiError(e).message }); qc.invalidateQueries({ queryKey: ['mobile-device-commands', deviceId] }); },
  });
  if (!canSend) return null;

  const msgBad = message.length > MESSAGE_MAX;
  const phoneBad = phone.trim() !== '' && !PHONE_RE.test(phone.trim());
  const needsText = open?.kind === 'lost_mode_start' && !message.trim() && !phone.trim();
  const submit = () => {
    if (!open) return;
    const b: { kind: LostKind; message?: string; phoneNumber?: string } = { kind: open.kind };
    if (open.takesMessage && message.trim()) b.message = message.trim();
    if (open.takesMessage && phone.trim()) b.phoneNumber = phone.trim();
    send.mutate(b);
  };

  return (
    <div className="space-y-2" data-testid="mdm-lost-actions">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const Icon = ICON[a.kind];
          return (
            <Button key={a.kind} size="sm" variant={a.kind === 'lost_mode_stop' ? 'outline' : 'default'} disabled={!a.available || send.isPending}
              title={a.reason ?? undefined} onClick={() => { setNote(null); setOpen(a); }} data-testid={`mdm-act-${a.kind}`} data-available={a.available ? 'yes' : 'no'}>
              <Icon className="mr-1 h-4 w-4" aria-hidden />{a.label}
            </Button>
          );
        })}
      </div>
      {actions.filter((a) => !a.available && a.reason).map((a) => (
        <p key={a.kind} className="text-xs text-muted-foreground" data-testid={`mdm-act-reason-${a.kind}`}><span className="font-medium">{a.label}:</span> {a.reason}</p>
      ))}
      {provider === 'android' && ownership === 'byod' && (
        <p className="text-xs text-muted-foreground">On a personal phone with a work profile, a lock locks the work profile when it has its own passcode, and the whole phone when it does not.</p>
      )}
      {note && <p className={`text-sm ${note.ok ? 'text-foreground' : 'text-destructive'}`} data-testid="mdm-act-note" data-ok={note.ok ? 'yes' : 'no'}>{note.text}</p>}

      <Dialog open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <DialogContent data-testid="mdm-act-dialog">
          <DialogHeader>
            <DialogTitle>{open ? TITLE[open.kind] : ''}</DialogTitle>
            <DialogDescription>{open ? EXPLAIN[open.kind] : ''} {confirmSentence(ask)}</DialogDescription>
          </DialogHeader>
          {open?.takesMessage && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="mdm-act-message">Message on the lock screen{open.kind === 'lost_mode_start' ? '' : ' (optional)'}</Label>
                <Input id="mdm-act-message" value={message} maxLength={MESSAGE_MAX} onChange={(e) => setMessage(e.target.value)} data-testid="mdm-act-message" placeholder="This phone belongs to Example Ltd. Please call us." />
                <p className={`text-xs ${msgBad ? 'text-destructive' : 'text-muted-foreground'}`}>{message.length}/{MESSAGE_MAX}. Shown to whoever has the device. Rem0te does not keep it.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="mdm-act-phone">Phone number to call (optional)</Label>
                <Input id="mdm-act-phone" value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} data-testid="mdm-act-phone" placeholder="+44 20 7946 0000" />
                {phoneBad && <p className="text-xs text-destructive">Digits, spaces, +, (, ), . and - only.</p>}
              </div>
              {needsText && <p className="text-xs text-muted-foreground">Lost mode needs a message or a phone number.</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>Cancel</Button>
            <Button onClick={submit} disabled={send.isPending || msgBad || phoneBad || needsText} data-testid="mdm-act-confirm">{`${open?.label ?? 'Send'}${reauthSuffix(ask)}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
