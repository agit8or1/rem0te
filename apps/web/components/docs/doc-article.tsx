import Link from 'next/link';
import { ArrowLeft, ArrowRight, Clock } from 'lucide-react';
import { DOCS } from '@/lib/docs-content.generated';
import { DocToc } from './doc-toc';

/**
 * Render one page's compiled HTML, with its contents panel and the previous
 * and next pages in reading order.
 *
 * dangerouslySetInnerHTML is safe here in the way the name warns about: the
 * input is this repository's own markdown, converted at build time. No user
 * content reaches it, so there is nothing to sanitise at runtime.
 */
export function DocArticle({ slug }: { slug: string }) {
  const i = DOCS.findIndex((d) => d.slug === slug);
  const page = DOCS[i];
  if (!page) {
    return <p className="text-sm text-muted-foreground">That page does not exist.</p>;
  }
  const prev = DOCS[i - 1], next = DOCS[i + 1];
  return (
    <div className="flex gap-8">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Link href="/docs" className="hover:underline">Documentation</Link><span>›</span><span>{page.group}</span>
          <span className="ml-auto inline-flex items-center gap-1"><Clock className="h-3 w-3" />{page.minutes} min read</span>
        </div>
        {page.toc.length > 2 && (
          <details className="mb-6 rounded-md border p-3 text-sm xl:hidden">
            <summary className="cursor-pointer font-medium">On this page</summary>
            <ul className="mt-2 space-y-1">
              {page.toc.map((t) => (
                <li key={t.id} className={t.depth === 3 ? 'pl-4' : ''}><a href={`#${t.id}`} className="text-muted-foreground hover:text-foreground">{t.text}</a></li>
              ))}
            </ul>
          </details>
        )}
        <article className="docs-prose" dangerouslySetInnerHTML={{ __html: page.html }} />
        <nav className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2" aria-label="Previous and next page">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="rounded-lg border p-4 transition-colors hover:bg-muted/50">
              <div className="flex items-center gap-1 text-xs text-muted-foreground"><ArrowLeft className="h-3 w-3" />Previous</div>
              <div className="mt-1 text-sm font-medium">{prev.title}</div>
            </Link>
          ) : <span />}
          {next && (
            <Link href={`/docs/${next.slug}`} className="rounded-lg border p-4 text-right transition-colors hover:bg-muted/50">
              <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">Next<ArrowRight className="h-3 w-3" /></div>
              <div className="mt-1 text-sm font-medium">{next.title}</div>
            </Link>
          )}
        </nav>
      </div>
      {page.toc.length > 2 && (
        <aside className="hidden w-56 shrink-0 xl:block">
          <DocToc toc={page.toc} />
        </aside>
      )}
    </div>
  );
}
