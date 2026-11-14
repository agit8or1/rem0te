'use client';

import { useState } from 'react';
import { Download, FileIcon } from 'lucide-react';
import { chatAttachmentUrl } from '@/lib/api-client';

/**
 * A file or image sent in a chat (0.44), on the console. The server decided
 * what it is from its bytes: an `image` (PNG, JPEG, GIF, WebP) is served as
 * that type and shown inline; anything else is served only as an
 * application/octet-stream download, so the link here downloads it and the
 * browser never renders it. The URL is built from ids alone
 * (chatAttachmentUrl); the name is React text.
 */
export type ChatAttachmentMeta = { id: string; fileName: string; kind: 'image' | 'file'; contentType: string; sizeBytes: number };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatAttachment({ endpointId, conversationId, a, mine }: { endpointId: string; conversationId: string; a: ChatAttachmentMeta; mine: boolean }) {
  const [big, setBig] = useState(false);
  const [broken, setBroken] = useState(false);
  const url = chatAttachmentUrl(endpointId, conversationId, a.id);
  return (
    <div className="space-y-1" data-testid="chat-attachment" data-kind={a.kind}>
      {a.kind === 'image' && !broken && (
        <img
          src={url}
          alt={a.fileName}
          onClick={() => setBig((v) => !v)}
          onError={() => setBroken(true)}
          className={`block rounded-md border bg-background ${big ? 'max-h-none max-w-full cursor-zoom-out' : 'max-h-56 max-w-[16rem] cursor-zoom-in'}`}
          data-testid="chat-attachment-image"
        />
      )}
      <a
        href={url}
        download={a.fileName}
        className={`inline-flex max-w-full items-center gap-1.5 text-xs underline-offset-2 hover:underline ${mine ? 'text-primary-foreground' : ''}`}
        data-testid="chat-attachment-download"
      >
        {a.kind === 'image' ? <Download className="h-3.5 w-3.5 shrink-0" /> : <FileIcon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{a.fileName}</span>
        <span className="shrink-0 opacity-75">({formatBytes(a.sizeBytes)})</span>
      </a>
      {broken && <p className="text-[11px] opacity-75">The picture is no longer on the server.</p>}
    </div>
  );
}
