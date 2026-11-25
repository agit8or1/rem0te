import { Sidebar } from '@/components/layout/sidebar';
import { NavDrawer, NavDrawerProvider } from '@/components/layout/nav-drawer';
import { StepUpDialog } from '@/components/auth/step-up-dialog';
import { ContainmentBanner } from '@/components/containment/containment-banner';
import { SectionTabs } from '@/components/layout/section-tabs';
import { TopBar } from '@/components/layout/top-bar';
import { ShellEffects } from '@/components/layout/shell-effects';

/**
 * The signed-in shell. From `md` up the sidebar sits beside the page; below
 * it the sidebar is an off-canvas drawer opened from the top bar (0.34).
 *
 * `min-w-0` on <main> is what keeps a wide table from widening the page: a
 * flex child's minimum width is its content's by default, so without it one
 * long row pushed the whole page sideways at phone width instead of
 * scrolling inside its own container.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <NavDrawerProvider>
      <a href="#main-content" className="sr-only z-[100] rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:outline-none focus:ring-2 focus:ring-ring" data-testid="skip-link">Skip to content</a>
      <div className="flex h-screen overflow-hidden">
        <div className="hidden md:flex">
          <Sidebar />
        </div>
        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto bg-muted/20 focus:outline-none" tabIndex={-1}>
          <TopBar />
          <ContainmentBanner />
          <SectionTabs />
          {children}
        </main>
        <NavDrawer />
        <StepUpDialog />
        <ShellEffects />
      </div>
    </NavDrawerProvider>
  );
}
