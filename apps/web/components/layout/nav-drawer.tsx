'use client';

/**
 * The main menu below Tailwind's `md` breakpoint (0.34).
 *
 * At phone width the sidebar is not drawn beside the page — a 240 px column
 * left 135 px of a 375 px screen for everything else. Instead the top bar's
 * menu button opens the same sidebar as an off-canvas drawer.
 *
 * The drawer is a Radix dialog, which is what makes it accessible rather
 * than merely visible: focus moves into it and is trapped there while it is
 * open, Esc and a tap outside close it, the page behind is inert to a screen
 * reader (aria-modal), and focus returns to the menu button afterwards. It
 * closes on navigation: on any link inside it, and on any route change (the
 * search palette, a redirect, the back button).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { usePathname } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Sidebar } from './sidebar';
import { useBrandAccent } from './brand-accent';
import { cn } from '@/lib/utils';

export const NAV_DRAWER_ID = 'main-menu-drawer';

type Ctx = { open: boolean; setOpen: (open: boolean) => void; triggerRef: RefObject<HTMLButtonElement | null> };
const NavDrawerContext = createContext<Ctx>({ open: false, setOpen: () => {}, triggerRef: { current: null } });
export const useNavDrawer = () => useContext(NavDrawerContext);

export function NavDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((o: boolean) => setOpenState(o), []);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const value = useMemo(() => ({ open, setOpen, triggerRef }), [open, setOpen]);
  return <NavDrawerContext.Provider value={value}>{children}</NavDrawerContext.Provider>;
}

export function NavDrawer() {
  const { open, setOpen, triggerRef } = useNavDrawer();
  const pathname = usePathname();
  const { ink } = useBrandAccent();

  // Any route change closes it, whatever caused it.
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);

  // Widening the window past `md` puts the sidebar back beside the page; a
  // drawer left open there would be a second, modal copy of it.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setOpen]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 md:hidden" />
        <DialogPrimitive.Content
          id={NAV_DRAWER_ID}
          data-testid="nav-drawer"
          aria-describedby={undefined}
          // Radix makes everything else inert (aria-hidden) but does not say
          // so on the dialog itself; screen readers announce it from this.
          aria-modal="true"
          // The menu button opened it, so focus goes back there — Radix
          // returns it only to its own Trigger, which this is not (it lives
          // in the top bar, a different subtree).
          onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}
          // A link to the page already open changes no pathname, so close on
          // the click itself too.
          onClick={(e) => { if ((e.target as HTMLElement).closest('a[href]')) setOpen(false); }}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shadow-xl outline-none md:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Main menu</DialogPrimitive.Title>
          <Sidebar className="h-full w-full" />
          {/* It sits on the sidebar's brand header. On a branding accent its
              ink is black or white by the accent's luminance (always at least
              4.5:1, WCAG AA); without one, the theme's foreground. It was
              text-muted-foreground — grey on the accent (0.35). */}
          <DialogPrimitive.Close
            className={cn(
              'absolute right-2 top-3 rounded-md p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              ink === '#ffffff' ? 'hover:bg-white/15' : ink ? 'hover:bg-black/10' : 'text-foreground hover:bg-accent hover:text-accent-foreground',
            )}
            style={ink ? { color: ink } : undefined}
            aria-label="Close menu" data-testid="nav-drawer-close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
