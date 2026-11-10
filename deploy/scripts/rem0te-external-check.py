#!/usr/bin/env python3
"""
rem0te external check (0.28). Run it on a machine OTHER than the portal host —
from cron, or any monitor that reads an exit status. Standard library only.

    REM0TE_HEALTH_TOKEN=... python3 rem0te-external-check.py \
        --portal https://remote.example.com \
        --signer https://approve.example.com \
        --hbbs remote.example.com:21116

Checks:
  portal   GET /api/v1/healthz with x-rem0te-health-token: database up, audit
           chain verified and not broken, seal / export lag under the limits,
           and the approval signer answering (as the portal sees it)
  signer   the approval signer's public origin answers HTTP (any non-5xx)
  hbbs     a TCP connection to the RustDesk ID server opens

Exit status: 0 all good, 1 something is wrong (each problem on stderr),
2 usage. With --json, one JSON object on stdout.

A compromised portal can lie to this. It is for the failures that are not an
attack — a stuck sealer, a dead export, a stopped signer — and for noticing
that the portal stopped answering at all. See docs/containment.md.
"""
import argparse
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request


def fetch(url, headers=None, timeout=10.0):
    req = urllib.request.Request(url, headers={"user-agent": "rem0te-external-check/1", **(headers or {})})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:  # noqa: S310 (https by default)
            return r.status, r.read(1 << 20)
    except urllib.error.HTTPError as e:
        return e.code, e.read(1 << 20)


def main(argv):
    ap = argparse.ArgumentParser(description="Check a rem0te deployment from outside.")
    ap.add_argument("--portal", required=True, help="portal origin, e.g. https://remote.example.com")
    ap.add_argument("--signer", help="approval signer public origin")
    ap.add_argument("--hbbs", help="host:port of the RustDesk ID server (TCP)")
    ap.add_argument("--max-seal-lag", type=int, default=120, help="seconds (default 120)")
    ap.add_argument("--max-export-lag", type=int, default=900, help="seconds (default 900)")
    ap.add_argument("--max-verify-age", type=int, default=3 * 3600, help="seconds since the last verify (default 3 h)")
    ap.add_argument("--require-export", action="store_true", help="fail when no export sink is configured")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    token = os.environ.get("REM0TE_HEALTH_TOKEN", "")
    problems, facts = [], {}

    # ── portal ──
    try:
        status, body = fetch(a.portal.rstrip("/") + "/api/v1/healthz", {"x-rem0te-health-token": token} if token else {})
        h = json.loads(body or b"{}")
        facts["portal"] = {"http": status, "status": h.get("status"), "version": h.get("version")}
        if status != 200:
            problems.append(f"portal: /healthz answered HTTP {status}")
        if not token:
            problems.append("portal: REM0TE_HEALTH_TOKEN not set — only up/down was checked")
        elif "database" not in h:
            problems.append("portal: the health token was not accepted (no detail returned)")
        else:
            if h.get("database") != "up":
                problems.append("portal: database down")
            if h.get("signer") == "down":
                problems.append("portal: the approval signer does not answer the portal")
            au = h.get("audit") or {}
            facts["audit"] = au
            if not au:
                problems.append("portal: no audit chain status")
            else:
                if au.get("verifyOk") is False:
                    problems.append("audit: the chain is BROKEN (run rem0te-audit verify --export)")
                if (au.get("sealLagSeconds") or 0) > a.max_seal_lag:
                    problems.append(f"audit: sealing is {au['sealLagSeconds']} s behind")
                if au.get("exportConfigured"):
                    if au.get("exportError"):
                        problems.append("audit: the export is failing")
                    if (au.get("exportLagSeconds") or 0) > a.max_export_lag:
                        problems.append(f"audit: the export is {au['exportLagSeconds']} s behind")
                elif a.require_export:
                    problems.append("audit: no export sink is configured")
                v = au.get("verifiedAt")
                if not v:
                    problems.append("audit: never verified")
                else:
                    from datetime import datetime, timezone
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(v.replace("Z", "+00:00"))).total_seconds()
                    if age > a.max_verify_age:
                        problems.append(f"audit: last verified {int(age)} s ago")
            c = h.get("containment") or {}
            facts["containment"] = c
    except Exception as e:  # noqa: BLE001 — any failure is a finding
        problems.append(f"portal: unreachable ({e.__class__.__name__}: {e})")

    # ── signer ──
    if a.signer:
        try:
            status, _ = fetch(a.signer.rstrip("/") + "/approve/" + "0" * 32 + "/state")
            facts["signer"] = {"http": status}
            if status >= 500:
                problems.append(f"signer: answered HTTP {status}")
        except Exception as e:  # noqa: BLE001
            problems.append(f"signer: unreachable ({e.__class__.__name__}: {e})")

    # ── hbbs ──
    if a.hbbs:
        host, _, port = a.hbbs.rpartition(":")
        try:
            with socket.create_connection((host or a.hbbs, int(port or 21116)), timeout=5):
                facts["hbbs"] = "open"
        except Exception as e:  # noqa: BLE001
            problems.append(f"hbbs: {a.hbbs} not reachable ({e.__class__.__name__})")

    if a.json:
        print(json.dumps({"ok": not problems, "problems": problems, "facts": facts}))
    else:
        for p in problems:
            print(p, file=sys.stderr)
        if not problems:
            print("ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
