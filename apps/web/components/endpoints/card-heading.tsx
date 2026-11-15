import * as React from 'react';
import { CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The one card header on a computer's page (0.50.4): an icon, the title and
 * an optional aside (a link, a badge, an age) on one line. `min-h-7` is the
 * height of the small ghost button an aside often is, so a card with a link
 * in its header and one without line their titles up across a row; the aside
 * wraps under the title on a narrow card instead of squeezing it.
 */
export function CardHeading({
  title, icon: Icon, aside,
}: {
  title: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  aside?: React.ReactNode;
}) {
  return (
    <CardHeader className="pb-3">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <CardTitle className="text-sm flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
          {title}
        </CardTitle>
        {aside && <div className="ml-auto flex items-center">{aside}</div>}
      </div>
    </CardHeader>
  );
}
