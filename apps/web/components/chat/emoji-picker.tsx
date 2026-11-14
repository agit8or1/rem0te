'use client';

import { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { EMOJI } from '@/lib/emoji';

/**
 * The chat's emoji picker (0.44). Built in: the list is lib/emoji.ts, the
 * glyphs are the system's own emoji font, and choosing one inserts it into
 * the message as text — nothing is loaded from anywhere. The /assist page
 * has the same list (apps/api/src/chat/emoji.ts).
 */
export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Insert an emoji"
        aria-expanded={open}
        data-testid="chat-emoji-open"
        className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        <Smile className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Emoji"
          data-testid="chat-emoji-panel"
          className="absolute bottom-10 left-0 z-40 grid max-h-56 w-72 grid-cols-8 gap-0.5 overflow-y-auto rounded-md border bg-popover p-1.5 shadow-lg"
        >
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={e}
              onClick={() => { onPick(e); setOpen(false); }}
              className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent focus:bg-accent focus:outline-none"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
