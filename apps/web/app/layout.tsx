import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/providers/query-provider';
import { Toaster } from '@/components/ui/toaster';
import { ThemeProvider } from '@/lib/theme-provider';
import { HydrationMarker } from '@/components/providers/hydration-marker';


// 0.85.1: every tab used to say "Reboot Remote", the product's old name. A
// page that sets its own title (Documentation) now reads "Documentation · Rem0te".
export const metadata: Metadata = {
  title: { default: 'Rem0te', template: '%s · Rem0te' },
  description: 'Remote support and RMM for MSPs',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply stored theme before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){d.classList.add('dark')}}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <QueryProvider>
            {children}
            <Toaster />
            <HydrationMarker />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
