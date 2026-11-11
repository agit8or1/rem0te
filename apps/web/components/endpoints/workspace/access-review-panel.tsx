'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import { ShieldAlert } from 'lucide-react';

// ─── Access review ───────────────────────────────────────────────────────────

/** Shapes from apps/api/src/offboarding/access-review.service.ts. */
interface AccessEntry {
  userId: string;
  name: string;
  email: string;
  via: 'PLATFORM_ADMIN' | 'BUSINESS_OWNER' | 'COMPUTER_GRANT' | 'COMPANY_WIDE' | 'TECHNICIAN_DIRECT' | 'TECHNICIAN_GROUP';
  detail: string;
  activeNow: boolean;
  inactiveReason?: string;
  startsAt?: string | null;
  expiresAt?: string | null;
  schedule?: string | null;
  temporary: boolean;
}
export interface AccessReview {
  endpoint: { id: string; name: string; accessMode: string; businessId: string | null };
  reviewedAt: string;
  entries: AccessEntry[];
  note: string;
}

const VIA_LABEL: Record<AccessEntry['via'], string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  BUSINESS_OWNER: 'Business Owner',
  COMPUTER_GRANT: 'Granted on this computer',
  COMPANY_WIDE: 'Company-wide',
  TECHNICIAN_DIRECT: 'Technician (direct)',
  TECHNICIAN_GROUP: 'Technician (group)',
};

export function AccessReviewPanel({ review }: { review: AccessReview }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Who can connect to this computer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>{review.note}</p>
        </div>

        <p className="text-xs text-muted-foreground">
          Access mode: {review.endpoint.accessMode === 'COMPANY_WIDE' ? 'company-wide' : 'assigned users only'} ·
          reviewed {formatDate(review.reviewedAt)}
        </p>

        {review.entries.length === 0 ? (
          <p className="text-muted-foreground">Nobody has access.</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-xs">Person</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">How</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">Now</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">Window</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {review.entries.map((e, i) => (
                  <tr key={`${e.userId}-${e.via}-${i}`} className={e.activeNow ? '' : 'text-muted-foreground'}>
                    <td className="px-3 py-2 align-top">
                      <p className="font-medium">{e.name}</p>
                      {e.name !== e.email && <p className="text-xs text-muted-foreground">{e.email}</p>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <p>{VIA_LABEL[e.via] ?? e.via}</p>
                      <p className="text-xs text-muted-foreground">{e.detail}</p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {e.activeNow ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <div className="space-y-0.5">
                          <Badge variant="secondary">Inactive</Badge>
                          {e.inactiveReason && <p className="text-xs">{e.inactiveReason}</p>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs space-y-0.5">
                      {e.temporary && <Badge variant="warning" className="text-[10px]">Temporary</Badge>}
                      {e.startsAt && <p>From {formatDate(e.startsAt)}</p>}
                      {e.expiresAt && <p>Until {formatDate(e.expiresAt)}</p>}
                      {e.schedule && <p>{e.schedule}</p>}
                      {!e.temporary && !e.startsAt && !e.expiresAt && !e.schedule && <span className="text-muted-foreground">No limit</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
