'use client';

import { useEffect, useState } from 'react';
import type { DocTocEntry } from '@/lib/docs-content.generated';

/** "On this page", following the heading currently in view. */
export function DocToc({ toc }: { toc: DocTocEntry[] }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = toc.map((t) => document.getElementById(t.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: '0px 0px -70% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [toc]);
  return (
    <nav className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto text-xs" aria-label="On this page" data-testid="docs-toc">
      <div className="mb-2 font-semibold uppercase tracking-wider text-muted-foreground/80">On this page</div>
      <ul className="space-y-1 border-l">
        {toc.map((t) => (
          <li key={t.id}>
            <a href={`#${t.id}`}
              className={`-ml-px block border-l py-0.5 ${t.depth === 3 ? 'pl-6' : 'pl-3'} ${active === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
