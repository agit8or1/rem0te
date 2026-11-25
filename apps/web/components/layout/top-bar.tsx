'use client';

/**
 * The bar above every signed-in page (0.33; 0.87 Compass).
 *
 * Left to right: the menu button (below `md` it opens the drawer; from `md`
 * up it collapses the sidebar to its icon rail), breadcrumbs, the customer
 * the person is working in, global search (Ctrl+K / ⌘K from anywhere),
 * quick actions, favourites and recent items, critical alerts, the chat
 * inbox (0.44), task progress (0.52), help and the profile menu.
 *
 * 48 px tall. Below `sm` the search button shrinks to an icon and the
 * breadcrumbs and labels drop out, so nothing wraps at 390 px.
 */
import { useEffect, useState } from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { CommandPalette } from '@/components/search/command-palette';
import { ChatInbox } from '@/components/chat/chat-inbox';
import { TaskWatcher } from '@/components/tasks/task-watcher';
import { usePermissions } from '@/lib/auth';
import { useIsMac, useNavigation } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { NAV_DRAWER_ID, useNavDrawer } from './nav-drawer';
import { AlertsBell, Breadcrumbs, ContextSelector, FavoritesMenu, HelpLink, ProfileMenu, QuickActions, headerButton } from './header-menus';

export function TopBar() {
  const { user } = usePermissions();
  const [open, setOpen] = useState(false);
  const mac = useIsMac();
  const drawer = useNavDrawer();
  const { prefs, setPrefs } = useNavigation();

  useEffect(() => {
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
  const collapsed = prefs.sidebarCollapsed;
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-1.5 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4" data-testid="top-bar">
      <button
        type="button"
        ref={drawer.triggerRef}
        onClick={() => drawer.setOpen(true)}
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={drawer.open}
        aria-controls={drawer.open ? NAV_DRAWER_ID : undefined}
        data-testid="nav-drawer-trigger"
        className={cn(headerButton, 'w-8 px-0 md:hidden')}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => setPrefs({ sidebarCollapsed: !collapsed })}
        aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
        aria-pressed={collapsed}
        title={collapsed ? 'Expand the menu' : 'Collapse the menu'}
        data-testid="sidebar-toggle"
        className={cn(headerButton, 'hidden w-8 px-0 md:flex')}
      >
        {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />}
      </button>
      <Breadcrumbs />
      <ContextSelector />
      <div className="flex min-w-0 flex-1 justify-center px-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="Search"
          data-testid="global-search-trigger"
          className="flex h-8 w-full min-w-0 max-w-md items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          {/* Short below lg: at 820 px the long text was cut to "S…" beside the shortcut. */}
          <span className="hidden truncate sm:inline lg:hidden">Search</span>
          <span className="hidden truncate lg:inline">Search devices, customers, pages…</span>
          <kbd className="ml-auto hidden shrink-0 rounded border bg-background px-1.5 py-0.5 font-mono text-xs lg:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <span className="hidden sm:contents"><QuickActions /></span>
        <FavoritesMenu />
        <span className="hidden sm:contents"><AlertsBell /></span>
        <ChatInbox />
        <TaskWatcher />
        <span className="hidden sm:contents"><HelpLink /></span>
        <ProfileMenu />
      </div>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </header>
  );
}
