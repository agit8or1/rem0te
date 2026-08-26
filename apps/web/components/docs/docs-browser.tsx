'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search, FileText, X } from 'lucide-react';
import { DOCS, type DocPage } from '@/lib/docs-content.generated';
import { Input } from '@/components/ui/input';

interface Hit {
  page: DocPage;
  heading: string;
  id: string;
  snippet: string;
  score: number;
}

/**
 * Search across every section of every page.
 *
 * Deliberately not a dependency. The corpus is around nine thousand words,
 * fixed at build time and already in memory — a scoring pass over it costs less
 * than the index a search library would build to avoid doing it.
 */
function search(query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];

  const hits: Hit[] = [];
  for (const page of DOCS) {
    for (const section of page.sections) {
      const haystack = `${page.title} ${section.heading} ${section.text}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!haystack.includes(term)) { score = 0; break; }
        // A term in the heading is worth far more than one buried in prose.
        if (section.heading.toLowerCase().includes(term)) score += 10;
        if (page.title.toLowerCase().includes(term)) score += 4;
        score += Math.min(section.text.toLowerCase().split(term).length - 1, 5);
      }
      if (!score) continue;

      const at = section.text.toLowerCase().indexOf(terms[0]);
      const from = Math.max(0, at - 60);
      hits.push({
        page,
        heading: section.heading,
        id: section.id,
        score,
        snippet:
          (from > 0 ? '…' : '') +
          section.text.slice(from, from + 200).trim() +
          (section.text.length > from + 200 ? '…' : ''),
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25);
}

export function DocsBrowser({ children }: { children?: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const pathname = usePathname();
  const hits = useMemo(() => search(query), [query]);
  const searching = query.trim().length > 1;

  return (
    <div className="flex gap-8">
      <aside className="hidden w-56 shrink-0 lg:block">
        <nav className="sticky top-6 space-y-1">
          {DOCS.map((d) => {
            const active = pathname === `/docs/${d.slug}`;
            return (
              <Link
                key={d.slug}
                href={`/docs/${d.slug}`}
                className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {d.title}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="relative mb-6">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the documentation…"
            className="pl-9 pr-9"
            aria-label="Search the documentation"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {searching ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {hits.length === 0
                ? 'Nothing matched.'
                : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
            </p>
            {hits.map((h, i) => (
              <Link
                key={`${h.page.slug}-${h.id}-${i}`}
                href={`/docs/${h.page.slug}${h.id ? `#${h.id}` : ''}`}
                onClick={() => setQuery('')}
                className="block rounded-lg border p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  {h.page.title}
                </div>
                <div className="mt-1 text-sm font-medium">{h.heading}</div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{h.snippet}</p>
              </Link>
            ))}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
