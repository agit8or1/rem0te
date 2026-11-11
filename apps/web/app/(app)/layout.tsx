import { Sidebar } from '@/components/layout/sidebar';
import { StepUpDialog } from '@/components/auth/step-up-dialog';
import { ContainmentBanner } from '@/components/containment/containment-banner';
import { SectionTabs } from '@/components/layout/section-tabs';
import { TopBar } from '@/components/layout/top-bar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-muted/20">
        <TopBar />
        <ContainmentBanner />
        <SectionTabs />
        {children}
      </main>
      <StepUpDialog />
    </div>
  );
}
