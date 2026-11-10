import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { DocsBrowser } from '@/components/docs/docs-browser';
import { DOC_GROUPS, DOCS } from '@/lib/docs-content.generated';

export const metadata = { title: 'Documentation' };

/** The documentation index: every page, grouped, with what it is for. */
export default function DocsIndexPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Documentation"
        description="Everything about running and using Rem0te. Press / to search every page."
      />
      <DocsBrowser>
        <div className="space-y-8" data-testid="docs-index">
          {DOC_GROUPS.map((g) => (
            <section key={g}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{g}</h2>
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {DOCS.filter((d) => d.group === g).map((d) => (
                  <Link key={d.slug} href={`/docs/${d.slug}`} className="rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-muted/40">
                    <div className="text-sm font-medium">{d.title}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{d.summary}</p>
                    <div className="mt-2 text-[11px] text-muted-foreground/80">{d.minutes} min · {d.toc.filter((t) => t.depth === 2).length} sections</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DocsBrowser>
    </div>
  );
}
