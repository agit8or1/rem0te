import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { DocsBrowser } from '@/components/docs/docs-browser';
import { DocArticle } from '@/components/docs/doc-article';
import { DOCS } from '@/lib/docs-content.generated';

// Every page is known at build time, so they are all prerendered.
export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = DOCS.find((d) => d.slug === slug);
  if (!page) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={page.title} description={`docs/${page.file}`} />
      <DocsBrowser>
        <DocArticle slug={slug} />
      </DocsBrowser>
    </div>
  );
}
