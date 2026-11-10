'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, FileText, Search, X } from 'lucide-react';
import { DOC_GROUPS, DOCS, type DocPage } from '@/lib/docs-content.generated';
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
 * Deliberately not a dependency. The corpus is a few tens of thousands of
 * words, fixed at build time and already in memory — a scoring pass over it
 * costs less than the index a search library would build to avoid doing it.
 */
function search(query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];

  const hits: Hit[] = [];
  for (const page of DOCS) {
    for (const section of page.sections) {
      const heading = section.heading.toLowerCase();
      const title = page.title.toLowerCase();
      const text = section.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const inHeading = heading.includes(term), inTitle = title.includes(term), inText = text.includes(term);
        if (!inHeading && !inTitle && !inText && !page.summary.toLowerCase().includes(term)) { score = 0; break; }
        // A term in the heading is worth far more than one buried in prose.
        if (inHeading) score += 10;
        if (inTitle) score += 4;
        score += Math.min(text.split(term).length - 1, 5);
      }
      if (!score) continue;

      const at = Math.max(0, text.indexOf(terms.find((t) => text.includes(t)) ?? terms[0]));
      const from = Math.max(0, at - 60);
      hits.push({
        page,
        heading: section.heading,
        id: section.id,
        score,
        snippet: (from > 0 ? '…' : '') + section.text.slice(from, from + 220).trim() + (section.text.length > from + 220 ? '…' : ''),
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 30);
}

/** Wrap each search term in <mark>, without touching anything else. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 === 1
        ? <mark key={i} className="rounded-sm bg-yellow-200 text-foreground dark:bg-yellow-700/60">{part}</mark>
        : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

function Nav({ pathname, onPick }: { pathname: string; onPick?: () => void }) {
  return (
    <nav className="space-y-4" aria-label="Documentation">
      <Link href="/docs" onClick={onPick}
        className={`block rounded-md px-3 py-1.5 text-sm ${pathname === '/docs' ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
        Index
      </Link>
      {DOC_GROUPS.map((g) => (
        <div key={g}>
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g}</div>
          {DOCS.filter((d) => d.group === g).map((d) => {
            const active = pathname === `/docs/${d.slug}`;
            return (
              <Link key={d.slug} href={`/docs/${d.slug}`} onClick={onPick}
                className={`block rounded-md px-3 py-1 text-sm transition-colors ${active ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                {d.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function DocsBrowser({ children }: { children?: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => search(query), [query]);
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter((t) => t.length > 1), [query]);
  const searching = query.trim().length > 1;

  // "/" focuses search from anywhere on the page, as on most documentation sites.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setCursor(0), [query]);

  const go = (h: Hit) => { setQuery(''); router.push(`/docs/${h.page.slug}${h.id ? `#${h.id}` : ''}`); };

  return (
    <div className="flex gap-8">
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pb-6">
          <Nav pathname={pathname} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              else if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); go(hits[cursor]); }
            }}
            placeholder="Search the documentation…"
            className="pl-9 pr-16"
            aria-label="Search the documentation"
            data-testid="docs-search"
          />
          {query ? (
            <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:block">/</kbd>
          )}
        </div>

        {/* Below lg the sidebar is hidden; the same index opens from here. */}
        <div className="mb-4 lg:hidden">
          <button onClick={() => setMenu((m) => !m)} className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm" aria-expanded={menu}>
            All pages <ChevronDown className={`h-4 w-4 transition-transform ${menu ? 'rotate-180' : ''}`} />
          </button>
          {menu && <div className="mt-2 rounded-md border p-2"><Nav pathname={pathname} onPick={() => setMenu(false)} /></div>}
        </div>

        {searching ? (
          <div className="space-y-3" data-testid="docs-results">
            <p className="text-sm text-muted-foreground">
              {hits.length === 0 ? 'Nothing matched. Try fewer or different words.' : `${hits.length}${hits.length === 30 ? '+' : ''} result${hits.length === 1 ? '' : 's'} · ↑↓ to move, Enter to open, Esc to clear`}
            </p>
            {hits.map((h, i) => (
              <Link
                key={`${h.page.slug}-${h.id}-${i}`}
                href={`/docs/${h.page.slug}${h.id ? `#${h.id}` : ''}`}
                onClick={() => setQuery('')}
                onMouseEnter={() => setCursor(i)}
                className={`block rounded-lg border p-4 transition-colors ${i === cursor ? 'border-primary/50 bg-muted/60' : 'hover:bg-muted/50'}`}
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  {h.page.group} › {h.page.title}
                </div>
                <div className="mt-1 text-sm font-medium"><Highlight text={h.heading} terms={terms} /></div>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground"><Highlight text={h.snippet} terms={terms} /></p>
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
