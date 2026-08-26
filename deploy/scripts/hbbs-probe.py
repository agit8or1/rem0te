#!/usr/bin/env python3
"""
Ask hbbs directly whether an endpoint is reachable.

Rem0te's own "online" dot is its 3-minute HTTP heartbeat, and RustDesk's is a
separate registration to hbbs — they answer different questions, and when a
Connect fails with "the target device is offline or does not exist" it is
hbbs's answer that decided it. hbbs logs nothing at all on a failed punch-hole,
so this sends it a real PunchHoleRequest and prints what it replies.

    ./hbbs-probe.py 123456789            # native rendezvous, TCP 21116
    ./hbbs-probe.py 123456789 --ws       # wss://<host>/ws/id, the 443 path
    ./hbbs-probe.py 123456789 --host remote.example.net

Verdicts:
    ONLINE            hbbs knows the peer and handed back a connection path
    OFFLINE           registered previously, but no live registration right now
    ID_NOT_EXIST      hbbs has never seen this ID
    LICENSE_MISMATCH  the key does not match the one hbbs was started with

OFFLINE immediately after an hbbs restart is expected and not a fault: the
online-peer map lives in memory only, and clients re-register within ~30s.
"""
import argparse, base64, os, socket, ssl, struct, sys

DEFAULT_PUBKEY = "/var/lib/rustdesk-server/id_ed25519.pub"
FAILURES = {0: "ID_NOT_EXIST", 2: "OFFLINE", 3: "LICENSE_MISMATCH", 4: "LICENSE_OVERUSE"}


# ── Minimal protobuf writer/reader. rendezvous.proto is stable and we need
# four fields of it; a real protobuf dependency is not worth it here.
def _varint(n: int) -> bytes:
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _bytes_field(num: int, data: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(data)) + data


def _varint_field(num: int, value: int) -> bytes:
    return _varint(num << 3 | 0) + _varint(value)


def _read_varint(buf: bytes, i: int):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes):
    """Yield (field_number, wire_type, value) for one protobuf message."""
    i = 0
    while i < len(buf):
        key, i = _read_varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            val, i = _read_varint(buf, i)
        elif wire == 2:
            ln, i = _read_varint(buf, i)
            val, i = buf[i:i + ln], i + ln
        elif wire == 5:
            val, i = buf[i:i + 4], i + 4
        elif wire == 1:
            val, i = buf[i:i + 8], i + 8
        else:
            return
        yield num, wire, val


def punch_hole_request(peer_id: str, key: str) -> bytes:
    """RendezvousMessage{ punch_hole_request = 8 }."""
    body = (
        _bytes_field(1, peer_id.encode())      # id
        + _varint_field(2, 0)                  # nat_type = ASYMMETRIC
        + _bytes_field(3, key.encode())        # licence_key
        + _varint_field(4, 0)                  # conn_type = DEFAULT_CONN
        + _bytes_field(6, b"1.4.9")            # version
    )
    return _bytes_field(8, body)


def verdict(payload: bytes) -> str:
    for num, _wire, val in _fields(payload):
        if num == 19:                          # relay_response
            return "ONLINE (via relay)"
        if num == 9:                           # punch_hole
            return "ONLINE (direct punch)"
        if num == 11:                          # punch_hole_response
            fail, addr = 0, None
            for n2, _w2, v2 in _fields(val):
                if n2 == 1:
                    addr = v2
                elif n2 == 3:
                    fail = v2
            if addr:
                return "ONLINE (direct)"
            return FAILURES.get(fail, f"failure={fail}")
    return f"unrecognised reply: {payload[:16].hex()}"


# ── Transports ─────────────────────────────────────────────────────────────
def _frame(payload: bytes) -> bytes:
    """hbb_common::bytes_codec — length shifted left 2, width in the low bits."""
    n = len(payload)
    if n <= 0x3F:
        return bytes([n << 2]) + payload
    if n <= 0x3FFF:
        return struct.pack("<H", (n << 2) | 1) + payload
    return struct.pack("<I", (n << 2) | 2)[:3] + payload


def probe_native(host: str, port: int, msg: bytes, timeout: float) -> bytes:
    with socket.create_connection((host, port), timeout) as s:
        s.settimeout(timeout)
        s.sendall(_frame(msg))
        data = s.recv(8192)
    if not data:
        raise RuntimeError("hbbs closed the connection without replying")
    n = data[0]
    return data[1:] if n & 3 == 0 else data[2:] if n & 3 == 1 else data[3:]


def probe_ws(host: str, port: int, path: str, msg: bytes, timeout: float, tls: bool) -> bytes:
    sock = socket.create_connection((host, port), timeout)
    if tls:
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
    sock.settimeout(timeout)
    nonce = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
    )
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("connection closed during WebSocket handshake")
        head += chunk
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101 " not in status:
        raise RuntimeError(f"WebSocket upgrade refused: {status}")

    mask = os.urandom(4)
    n = len(msg)
    hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
    sock.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))

    frame = sock.recv(8192)
    if not frame:
        # 1.1.15 does exactly this: accepts the upgrade, then drops the socket.
        raise RuntimeError("server accepted the upgrade then closed it (hbbs older than 1.1.16?)")
    ln = frame[1] & 0x7F
    return frame[2:2 + ln] if ln < 126 else frame[4:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("id", help="RustDesk peer ID to look up")
    ap.add_argument("--host", default="127.0.0.1", help="hbbs host (default: 127.0.0.1)")
    ap.add_argument("--key", help=f"server public key (default: read {DEFAULT_PUBKEY})")
    ap.add_argument("--ws", action="store_true", help="use the WebSocket path instead of TCP 21116")
    ap.add_argument("--port", type=int, help="override the port")
    ap.add_argument("--path", default="/ws/id", help="WebSocket path (default: /ws/id)")
    ap.add_argument("--no-tls", action="store_true", help="plain ws:// — for hitting 21118 directly")
    ap.add_argument("--timeout", type=float, default=8.0)
    args = ap.parse_args()

    key = args.key
    if key is None:
        try:
            with open(DEFAULT_PUBKEY) as fh:
                key = fh.read().strip()
        except OSError as exc:
            print(f"cannot read {DEFAULT_PUBKEY} ({exc}); pass --key", file=sys.stderr)
            return 2

    msg = punch_hole_request(args.id, key)
    try:
        if args.ws:
            tls = not args.no_tls
            port = args.port or (443 if tls else 21118)
            payload = probe_ws(args.host, port, args.path, msg, args.timeout, tls)
            via = f"{'wss' if tls else 'ws'}://{args.host}:{port}{args.path}"
        else:
            port = args.port or 21116
            payload = probe_native(args.host, port, msg, args.timeout)
            via = f"tcp://{args.host}:{port}"
    except (OSError, RuntimeError) as exc:
        print(f"{args.id}: probe failed via {args.host} — {exc}", file=sys.stderr)
        return 2

    result = verdict(payload)
    print(f"{args.id} via {via}: {result}")
    return 0 if result.startswith("ONLINE") else 1


if __name__ == "__main__":
    sys.exit(main())
