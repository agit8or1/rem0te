import { DOCS } from '@/lib/docs-content.generated';

/**
 * Render one page's compiled HTML.
 *
 * dangerouslySetInnerHTML is safe here in the way the name warns about: the
 * input is this repository's own markdown, converted at build time. No user
 * content reaches it, so there is nothing to sanitise at runtime.
 */
export function DocArticle({ slug }: { slug: string }) {
  const page = DOCS.find((d) => d.slug === slug);
  if (!page) {
    return <p className="text-sm text-muted-foreground">That page does not exist.</p>;
  }
  return (
    <article className="docs-prose" dangerouslySetInnerHTML={{ __html: page.html }} />
  );
}
