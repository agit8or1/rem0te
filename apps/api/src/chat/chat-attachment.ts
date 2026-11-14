/**
 * Chat attachments (0.44): the rules, as pure functions. No Nest, no Prisma,
 * so scripts/unit-chat.mjs exercises exactly what the services run.
 *
 * A file either side sends is untrusted bytes with an untrusted name. What it
 * IS is decided here from its first bytes — never from the type or the name
 * the sender declared:
 *
 *   - PNG, JPEG, GIF and WebP, by their magic numbers, are `image`: served
 *     inline as exactly that type, so a browser draws them and nothing else.
 *   - Everything else is `file`: served only as a download,
 *     application/octet-stream, `Content-Disposition: attachment`. That
 *     includes SVG (it can carry script) and HTML, whatever they are called.
 *
 * Every response carries nosniff and a sandboxing CSP as well (attachmentHeaders),
 * so even a browser that ignored the type could run nothing from it.
 */
import { createHash } from 'crypto';

/** One file, at most. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments in one chat, both sides together. */
export const MAX_ATTACHMENTS_PER_CONVERSATION = 20;
/** Bytes in one chat, both sides together. */
export const MAX_ATTACHMENT_BYTES_PER_CONVERSATION = 50 * 1024 * 1024;
/** The longest stored file name, in characters. */
export const MAX_NAME_CHARS = 120;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const FILE_TYPE = 'application/octet-stream';

export type Sniffed = { kind: 'image'; contentType: ImageType; ext: string } | { kind: 'file'; contentType: typeof FILE_TYPE; ext: null };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes are, from their magic numbers alone. A file that merely
 * starts like an image but is too short to be one is a `file`.
 */
export function sniff(b: Buffer): Sniffed {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_MAGIC) && b.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { kind: 'image', contentType: 'image/png', ext: 'png' };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { kind: 'image', contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (b.length >= 10 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return { kind: 'image', contentType: 'image/gif', ext: 'gif' };
  }
  if (b.length >= 16 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
    && /^VP8[ LX]$/.test(b.subarray(12, 16).toString('latin1'))) {
    return { kind: 'image', contentType: 'image/webp', ext: 'webp' };
  }
  return { kind: 'file', contentType: FILE_TYPE, ext: null };
}

// C0 and C1 controls, DEL, the line/paragraph separators, bidi overrides and
// isolates (chat-policy.ts CONTROL_RANGES), and the zero-width and BOM
// characters that hide an extension.
const NAME_CONTROL: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
// Path separators and every character Windows refuses in a file name.
const NAME_RESERVED = /[/\\:*?"<>|]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// An image extension on a file that is not that image gets a second one, so
// the computer it is saved on does not open it as one.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svgz?|bmp|ico|html?|xhtml|mht(ml)?|xml)$/i;

/**
 * The name an attachment is stored and offered under: NFC, one line, no
 * controls, bidi or zero-width characters, no path separators or Windows-
 * reserved characters, no leading or trailing dots and spaces, not a Windows
 * device name, at most 120 characters with its extension kept. An image's
 * extension is its real type's; a file whose name claims an image or a web
 * page gets `.bin` added. Never empty.
 */
export function attachmentName(raw: unknown, sniffed: Sniffed): string {
  let s = typeof raw === 'string' ? raw.normalize('NFC') : '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += NAME_CONTROL.some(([a, z]) => c >= a && c <= z) ? ' ' : ch;
  }
  // Only the last path segment: a browser sends a bare name, but nothing makes it.
  s = out.split(/[/\\]/).pop() ?? '';
  s = s.replace(NAME_RESERVED, '_').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (WINDOWS_DEVICE.test(s)) s = `_${s}`;
  const dot = s.lastIndexOf('.');
  let base = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,10}$/.test(ext)) { base = s; ext = ''; }
  if (sniffed.kind === 'image') {
    // The extension it really has: a JPEG named .png is saved as .jpg.
    const same = ext === sniffed.ext || (sniffed.ext === 'jpg' && ext === 'jpeg');
    if (!same) { if (ext) base = `${base}.${ext}`; ext = sniffed.ext; }
  } else if (ext && IMAGE_EXT.test(`.${ext}`)) {
    base = `${base}.${ext}`;
    ext = 'bin';
  }
  if (!base.replace(/[\s._-]/g, '')) base = sniffed.kind === 'image' ? 'image' : 'file';
  const tail = ext ? `.${ext}` : '';
  const room = MAX_NAME_CHARS - [...tail].length;
  const chars = [...base];
  if (chars.length > room) base = chars.slice(0, room).join('').replace(/[\s.]+$/, '') || 'file';
  return `${base}${tail}`;
}

export type AttachmentCheck =
  | { ok: true; kind: Sniffed['kind']; contentType: string; fileName: string; sizeBytes: number; sha256: string }
  | { ok: false; code: 'ATTACHMENT_EMPTY' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_MISSING' };

/** One upload, checked: present, 1 byte to 10 MiB, classified by its bytes, named safely. */
export function checkAttachment(file: { buffer?: unknown; originalname?: unknown; size?: unknown } | null | undefined): AttachmentCheck {
  if (!file || !Buffer.isBuffer(file.buffer)) return { ok: false, code: 'ATTACHMENT_MISSING' };
  const b = file.buffer;
  if (b.length === 0) return { ok: false, code: 'ATTACHMENT_EMPTY' };
  if (b.length > MAX_ATTACHMENT_BYTES) return { ok: false, code: 'ATTACHMENT_TOO_LARGE' };
  const s = sniff(b);
  return {
    ok: true, kind: s.kind, contentType: s.contentType, fileName: attachmentName(decodeName(file.originalname), s),
    sizeBytes: b.length, sha256: createHash('sha256').update(b).digest('hex'),
  };
}

/**
 * Multipart file names arrive as latin1-decoded bytes from busboy unless they
 * were sent as UTF-8; a name that round-trips as valid UTF-8 is taken as
 * UTF-8, otherwise as given.
 */
export function decodeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- a byte-range test, not a control-character filter
  if (/^[\x00-\x7f]*$/.test(raw) || /[^\x00-\xff]/.test(raw)) return raw;
  const u = Buffer.from(raw, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? raw : u;
}

/** May one more attachment of this size go into a chat that already holds these? */
export function withinConversationCaps(count: number, bytes: number, size: number): 'ok' | 'ATTACHMENT_COUNT' | 'ATTACHMENT_TOTAL' {
  if (count >= MAX_ATTACHMENTS_PER_CONVERSATION) return 'ATTACHMENT_COUNT';
  if (bytes + size > MAX_ATTACHMENT_BYTES_PER_CONVERSATION) return 'ATTACHMENT_TOTAL';
  return 'ok';
}

/** RFC 6266: an ASCII fallback (anything else, quotes and backslashes as `_`) and the UTF-8 name. */
export function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const ascii = Array.from(fileName, (c) => (/^[\x20-\x7e]$/.test(c) && !/["\\%;]/.test(c) ? c : '_')).join('');
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The headers an attachment is served with, wherever it is served (the
 * console and /assist). An image: its sniffed type, inline. Anything else:
 * application/octet-stream as a download. Both: nosniff, a CSP that
 * sandboxes the response and allows nothing, never cached by anything shared.
 */
export function attachmentHeaders(a: { kind: string; contentType: string; fileName: string; sizeBytes: number }): Record<string, string> {
  const image = a.kind === 'image' && (IMAGE_TYPES as readonly string[]).includes(a.contentType);
  return {
    'Content-Type': image ? a.contentType : FILE_TYPE,
    'Content-Disposition': contentDisposition(image ? 'inline' : 'attachment', a.fileName),
    'Content-Length': String(a.sizeBytes),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** The message body an attachment message carries: its name, so every older reader shows something true. */
export function attachmentBody(fileName: string): string {
  return fileName;
}
