'use client';

import * as React from 'react';
import { StatusIndicator } from '@/components/common/status-indicator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Monitor, Globe, Apple, HelpCircle } from 'lucide-react';

interface Endpoint {
  id: string;
  name: string;
  hostname?: string;
  ipAddress?: string;
  platform?: string;
  status: string;
  rustdeskId?: string;
  customer?: { id: string; name: string };
  site?: { id: string; name: string };
  lastSeenAt?: string;
}

interface EndpointTableProps {
  endpoints: Endpoint[];
  loading?: boolean;
  onConnect: (endpoint: Endpoint) => void;
}

function PlatformIcon({ platform }: { platform?: string }) {
  switch (platform?.toLowerCase()) {
    case 'windows':
      return <Monitor className="h-4 w-4" />;
    case 'linux':
      return <Globe className="h-4 w-4" />;
    case 'macos':
      return <Apple className="h-4 w-4" />;
    default:
      return <HelpCircle className="h-4 w-4" />;
  }
}

export function EndpointTable({
  endpoints,
  loading = false,
  onConnect,
}: EndpointTableProps) {
  if (loading) {
    return (
      <div className="rounded-md border">
        <div className="p-8 text-center text-muted-foreground">
          Loading endpoints...
        </div>
      </div>
    );
  }

  if (endpoints.length === 0) {
    return (
      <div className="rounded-md border">
        <div className="p-8 text-center text-muted-foreground">
          No endpoints found.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="h-12 px-4 text-left font-medium text-muted-foreground">
              Name
            </th>
            <th className="h-12 px-4 text-left font-medium text-muted-foreground">
              Platform
            </th>
            <th className="h-12 px-4 text-left font-medium text-muted-foreground">
              Customer
            </th>
            <th className="h-12 px-4 text-left font-medium text-muted-foreground">
              Status
            </th>
            <th className="h-12 px-4 text-left font-medium text-muted-foreground">
              Last Seen
            </th>
            <th className="h-12 px-4 text-right font-medium text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((endpoint) => (
            <tr
              key={endpoint.id}
              className="border-b transition-colors hover:bg-muted/30 last:border-0"
            >
              <td className="p-4">
                <div className="font-medium">{endpoint.name}</div>
                {endpoint.hostname && (
                  <div className="text-xs text-muted-foreground">
                    {endpoint.hostname}
                    {endpoint.ipAddress && ` · ${endpoint.ipAddress}`}
                  </div>
                )}
                {endpoint.rustdeskId && (
                  <div className="text-xs text-muted-foreground font-mono">
                    ID: {endpoint.rustdeskId}
                  </div>
                )}
              </td>
              <td className="p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <PlatformIcon platform={endpoint.platform} />
                  <span className="capitalize">
                    {endpoint.platform ?? 'Unknown'}
                  </span>
                </div>
              </td>
              <td className="p-4">
                {endpoint.customer ? (
                  <div>
                    <div className="font-medium">{endpoint.customer.name}</div>
                    {endpoint.site && (
                      <div className="text-xs text-muted-foreground">
                        {endpoint.site.name}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="p-4">
                <StatusIndicator status={endpoint.status} />
              </td>
              <td className="p-4">
                {endpoint.lastSeenAt ? (
                  <span className="text-muted-foreground text-xs">
                    {new Date(endpoint.lastSeenAt).toLocaleString()}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="p-4 text-right">
                <Button
                  size="sm"
                  variant={endpoint.status === 'online' ? 'default' : 'outline'}
                  onClick={() => onConnect(endpoint)}
                  disabled={endpoint.status !== 'online'}
                >
                  Connect
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
