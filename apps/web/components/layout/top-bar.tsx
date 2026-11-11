'use client';

/**
 * The bar above every signed-in page (0.33). It holds global search: the
 * button opens the command palette, and so does Ctrl+K (⌘K on a Mac) from
 * anywhere in the app.
 */
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { CommandPalette } from '@/components/search/command-palette';
import { usePermissions } from '@/lib/auth';

export function TopBar() {
  const { user } = usePermissions();
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(false);

  useEffect(() => {
    try { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); } catch { /* unknown platform */ }
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!user) return null;
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6" data-testid="top-bar">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="global-search-trigger"
        className="flex h-8 w-full max-w-md items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate sm:hidden">Search</span>
        <span className="hidden truncate sm:inline">Search devices, businesses, people…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] sm:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </header>
  );
}
