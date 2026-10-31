import * as net from 'net';
import * as os from 'os';

/**
 * Ask hbbs which RustDesk IDs are registered with it right now.
 *
 * This is the same `OnlineRequest` the RustDesk client sends to colour its
 * address-book dots. hbbs answers it on its NAT-test port (21115) with a
 * bitmask: bit i is set when peer i re-registered within REG_TIMEOUT (30 s).
 * It is the only first-hand liveness signal that does not depend on the
 * Rem0te agent — a machine whose heartbeat task is broken is still reachable
 * through RustDesk, and the console used to call it offline.
 *
 * hbbs treats loopback connections on that port as its text admin console, so
 * the query must arrive from a non-loopback address: by default the host's own
 * first external IPv4 (hbbs runs beside the API), or HBBS_PRESENCE_HOST.
 *
 * Resolves to null — never throws — when hbbs cannot be asked; callers fall
 * back to heartbeat-only liveness.
 */
export async function queryHbbsOnline(
  ids: string[],
  opts: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<Set<string> | null> {
  const valid = ids.filter((id) => /^[0-9]{6,15}$/.test(id));
  if (valid.length === 0) return new Set();
  const host = opts.host || defaultHost();
  if (!host) return null;
  const port = opts.port ?? 21115;
  const timeoutMs = opts.timeoutMs ?? 3000;

  const out = new Set<string>();
  // One request per 500 IDs keeps each frame comfortably small.
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const states = await ask(chunk, host, port, timeoutMs);
    if (!states) return null;
    chunk.forEach((id, k) => {
      if ((states[k >> 3] ?? 0) & (0x80 >> (k & 7))) out.add(id);
    });
  }
  return out;
}

function defaultHost(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// ── minimal protobuf + hbb_common BytesCodec framing ────────────────────────

function varint(n: number): Buffer {
  const b: number[] = [];
  while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7; }
  b.push(n);
  return Buffer.from(b);
}

function field(num: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
}

/** BytesCodec: low two bits of the first byte give the header length - 1. */
function frame(msg: Buffer): Buffer {
  const n = msg.length;
  let h: Buffer;
  if (n <= 0x3f) h = Buffer.from([n << 2]);
  else if (n <= 0x3fff) { h = Buffer.alloc(2); h.writeUInt16LE((n << 2) | 1); }
  else if (n <= 0x3fffff) { h = Buffer.alloc(4); h.writeUInt32LE((n << 2) | 2); h = h.subarray(0, 3); }
  else { h = Buffer.alloc(4); h.writeUInt32LE(((n << 2) | 3) >>> 0); }
  return Buffer.concat([h, msg]);
}

function readVarint(b: Buffer, pos: number): [number, number] {
  let v = 0, shift = 0;
  for (;;) {
    if (pos >= b.length) throw new Error('truncated varint');
    const c = b[pos++];
    v += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) return [v, pos];
    shift += 7;
  }
}

/** Find a length-delimited field's payload at the top level of a message. */
function getField(b: Buffer, num: number): Buffer | null {
  let pos = 0;
  while (pos < b.length) {
    let tag: number;
    [tag, pos] = readVarint(b, pos);
    const wire = tag & 7;
    if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(b, pos);
      if (tag >>> 3 === num) return b.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 0) {
      [, pos] = readVarint(b, pos);
    } else {
      return null;
    }
  }
  return null;
}

function ask(ids: string[], host: string, port: number, timeoutMs: number): Promise<Buffer | null> {
  // RendezvousMessage { online_request(23): OnlineRequest { id(1), peers(2)... } }
  const req = Buffer.concat([
    field(1, Buffer.from('rem0te')),
    ...ids.map((id) => field(2, Buffer.from(id))),
  ]);
  const msg = frame(field(23, req));

  return new Promise((resolve) => {
    let buf: Buffer = Buffer.alloc(0);
    let done = false;
    const finish = (v: Buffer | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    const sock = net.connect({ host, port }, () => sock.write(msg));
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d as Buffer]);
      const hl = (buf[0] & 3) + 1;
      if (buf.length < hl) return;
      let n = 0;
      for (let i = 0; i < hl; i++) n += buf[i] * 2 ** (8 * i);
      n = Math.floor(n / 4);
      if (buf.length < hl + n) return;
      try {
        // online_response(24) -> states(1)
        const resp = getField(buf.subarray(hl, hl + n), 24);
        finish(resp ? (getField(resp, 1) ?? Buffer.alloc(0)) : null);
      } catch {
        finish(null);
      }
    });
  });
}
