import { PageHeader } from '@/components/common/page-header';
import { DocsBrowser } from '@/components/docs/docs-browser';
import { DocArticle } from '@/components/docs/doc-article';

export const metadata = { title: 'Documentation' };

export default function DocsIndexPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentation"
        description="Everything about running and using Rem0te. Search across every page."
      />
      <DocsBrowser>
        <DocArticle slug="readme" />
      </DocsBrowser>
    </div>
  );
}
