/**
 * What the standard Linux agent (0.32) and the standard macOS agent (0.33)
 * share: the POSIX sh fragments that decide what the agent trusts and what it
 * sends. Each platform's template (linux-agent.ts, macos-agent.ts) supplies
 * where things are and how to measure the machine; everything that touches
 * the secret, the server or the server's response is here, once.
 *
 * Assembled in this order by assemblePosixAgent():
 *
 *   platform head      paths, overrides, AGENT_PLATFORM and OS_LABEL
 *   POSIX_SETUP        sanitisers; the config read with sed; the secret checked
 *                      (owner, mode, length) before anything is sent
 *   platform identity  RID, the RustDesk ID, or exit 0 when there is none yet
 *   POSIX_TRANSPORT    a private temporary directory and post()
 *   platform live      the per-heartbeat values, in the variables named below
 *   POSIX_HEARTBEAT    the heartbeat body, the POST, and "authenticated or stop"
 *   platform collect   inventory_json and updates_json (setting UPD_ERR)
 *   POSIX_COMMANDS     the response read for command ids and three fixed names
 *
 * The live variables POSIX_HEARTBEAT reads: host, os_name, rdv, have_users,
 * users, uptime_s, boot_at, cpu, mem_total, mem_free, disk_total, disk_free.
 * Every one of them is already reduced (txt, nm, isnum) by the platform part.
 *
 * **Read-only.** Nothing here runs anything the server sends: the response is
 * searched for `{"id":"<charset>","type":"<one of three names>"` and nothing
 * else in it is read. scripts/check-security-invariants.mjs §24 (both agents)
 * and §25 (macOS) check the text.
 *
 * Every fragment is String.raw so shell backslashes survive, and none may
 * contain `${` (assemblePosixAgent refuses it): in a template literal that
 * would be an interpolation.
 */

const VERSION_RE = /^[a-zA-Z0-9._+-]{1,32}$/;

/** The heredoc delimiter both installers embed the agent with. */
export const POSIX_AGENT_HEREDOC = 'REM0TE_AGENT_EOF';

export function assemblePosixAgent(name: string, parts: string[], agentVersion: string): string {
  const v = VERSION_RE.test(agentVersion) ? agentVersion : 'unknown';
  const text = parts.join('');
  if (text.includes('${')) throw new Error(`${name} agent template must not contain \${`);
  if (text.split('\n').includes(POSIX_AGENT_HEREDOC)) throw new Error(`${name} agent contains its heredoc delimiter`);
  return text.replace(/__AGENT_VERSION__/g, v);
}

export const POSIX_SETUP = String.raw`
log() { printf 'rem0te-agent: %s\n' "$*" >&2; }

# ---- Reducing what leaves this machine --------------------------------------
# Printable ASCII only, without the two characters that would end or escape a
# JSON string, clamped to $2 bytes. Every string in every request goes through
# txt or nm, which is why no JSON escaping is needed anywhere below.
txt() { printf '%s' "$1" | tr -cd ' -~' | tr -d '"\\' | cut -c1-"$2"; }
# Names (host names): the inert charset the Connect script also reduces to.
nm() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-"$2"; }
isnum() { case "$1" in ''|*[!0-9]*) return 1;; esac; return 0; }

# ---- Configuration: read with sed, never sourced ----------------------------
conf_get() { sed -n "s/^$1=//p" "$CONF" 2>/dev/null | head -n 1; }
API_BASE=$(conf_get API_BASE)
if ! printf '%s' "$API_BASE" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/api/v1$'; then
  # Plain http only to this machine itself: the test suite's scratch API.
  if ! printf '%s' "$API_BASE" | grep -Eq '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/api/v1$'; then
    log "API_BASE in $CONF is missing or not an https URL; re-run the installer"
    exit 1
  fi
fi

# ---- The device secret ------------------------------------------------------
# Written by the installer and bound to this computer by the claim. Without it
# the server takes nothing this agent says, so it does not try. It must be
# readable by its owner only, and that owner must be the account the agent
# runs as (root, under systemd or launchd): a secret anyone else can read or
# replace is one they can report as this computer with.
if [ ! -f "$SECRET_FILE" ]; then
  log "no device secret at $SECRET_FILE; re-run the installer from an enrolment link"
  exit 1
fi
# GNU and busybox stat take -c; the BSD stat on macOS takes -f.
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }
file_owner() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null; }
mode=$(file_mode "$SECRET_FILE")
case "$mode" in
  600|400) ;;
  *) log "refusing to use $SECRET_FILE: mode $mode, it must be 600 (readable by root only)"; exit 1;;
esac
owner=$(file_owner "$SECRET_FILE")
if [ -z "$owner" ] || [ "$owner" != "$(id -u)" ]; then
  log "refusing to use $SECRET_FILE: owned by uid $owner, not by the account this agent runs as ($(id -u))"
  exit 1
fi
SECRET=$(tr -cd 'A-Za-z0-9_-' < "$SECRET_FILE" | cut -c1-128)
# tr: the BSD wc pads its count with spaces.
if [ "$(printf '%s' "$SECRET" | wc -c | tr -d ' ')" -lt 16 ]; then
  log "the device secret in $SECRET_FILE is unreadable or too short"
  exit 1
fi
`;

export const POSIX_TRANSPORT = String.raw`
TMPD=$(mktemp -d 2>/dev/null) || { log "cannot create a temporary directory"; exit 1; }
trap 'rm -rf "$TMPD"' EXIT
trap 'exit 1' INT TERM

# POST the body in $2 to $1. The body goes through a file in the private
# temporary directory, never argv: argv is visible to every user on the
# machine through ps, and the body carries the secret. Not on a pipe either —
# the right side of a pipe is a subshell, and CODE would be lost.
post() {
  printf '%s' "$2" > "$TMPD/req"
  CODE=$(curl -sS --max-time 60 --max-redirs 0 -o "$TMPD/resp" -w '%{http_code}' \
    -H 'Content-Type: application/json' --data-binary @"$TMPD/req" "$API_BASE$1" 2>"$TMPD/curl.err")
  rm -f "$TMPD/req"
  [ -n "$CODE" ] || CODE=000
}
`;

export const POSIX_HEARTBEAT = String.raw`
body="{\"rustdeskId\":\"$RID\",\"agentSecret\":\"$SECRET\",\"platform\":\"$AGENT_PLATFORM\",\"agentVersion\":\"$(txt "$AGENT_VERSION" 32)\""
[ -n "$host" ] && body="$body,\"hostname\":\"$host\""
[ -n "$os_name" ] && body="$body,\"osVersion\":\"$os_name\""
[ -n "$rdv" ] && body="$body,\"rustdeskVersion\":\"$rdv\""
[ "$have_users" = 1 ] && body="$body,\"loggedOnUser\":\"$users\""
[ -n "$uptime_s" ] && body="$body,\"uptimeSeconds\":$uptime_s"
[ -n "$boot_at" ] && body="$body,\"lastBootAt\":\"$boot_at\""
[ -n "$cpu" ] && body="$body,\"cpuLoadPercent\":$cpu"
[ -n "$mem_total" ] && body="$body,\"memoryTotalMb\":$mem_total"
[ -n "$mem_free" ] && body="$body,\"memoryFreeMb\":$mem_free"
[ -n "$disk_total" ] && body="$body,\"systemDiskTotalMb\":$disk_total"
[ -n "$disk_free" ] && body="$body,\"systemDiskFreeMb\":$disk_free"
body="$body}"

post /enrollment/heartbeat "$body"
case "$CODE" in
  200) ;;
  401) log "heartbeat refused (HTTP 401): the server does not hold this computer's device secret. Re-run the installer from an enrolment link made for it."; exit 0;;
  *) log "heartbeat failed (HTTP $CODE) $(head -c 300 "$TMPD/curl.err" 2>/dev/null)"; exit 0;;
esac
resp=$(cat "$TMPD/resp" 2>/dev/null)
case "$resp" in
  *'"authenticated":true'*) ;;
  *) log "heartbeat recorded as liveness only: this computer's device secret is not bound on the server"; exit 0;;
esac

# ---- Collections ------------------------------------------------------------
jstr() { [ -n "$2" ] && printf ',"%s":"%s"' "$1" "$2"; }
jnum() { isnum "$2" && printf ',"%s":%s' "$1" "$2"; }
`;

export const POSIX_COMMANDS = String.raw`
result() { # id ok extra error
  r="{\"rustdeskId\":\"$RID\",\"agentSecret\":\"$SECRET\",\"commandId\":\"$1\",\"ok\":$2"
  [ -n "$3" ] && r="$r,$3"
  [ -n "$4" ] && r="$r,\"error\":\"$(txt "$4" 1000)\""
  post /enrollment/command-result "$r}"
  [ "$CODE" = 200 ] || log "command result for $1 not accepted (HTTP $CODE)"
}

# The only thing read from the response: command ids in a fixed charset and
# three fixed type names. A forged match could at worst make this agent
# describe the machine again.
printf '%s' "$resp" | grep -oE '\{"id":"[A-Za-z0-9_-]{1,64}","type":"(INVENTORY_REFRESH|UPDATE_SCAN|EVENT_LOG_QUERY)"' \
  | sed -E 's/^\{"id":"([A-Za-z0-9_-]+)","type":"([A-Z_]+)"$/\1 \2/' | head -n 4 > "$TMPD/cmds"
ran=0
# Read on fd 3, so nothing a collection runs can swallow the list from stdin.
while read -r cid ctype <&3; do
  case "$ctype" in
    INVENTORY_REFRESH) result "$cid" true "\"inventory\":$(inventory_json)" '';;
    UPDATE_SCAN)
      if updates_json > "$TMPD/upd.json"; then result "$cid" true "\"updates\":$(cat "$TMPD/upd.json")" ''
      else result "$cid" false '' "$UPD_ERR"; fi;;
    EVENT_LOG_QUERY) result "$cid" false '' "Event logs are Windows-only: the $OS_LABEL agent does not read logs.";;
  esac
  ran=$((ran + 1))
done 3< "$TMPD/cmds"
log "heartbeat ok; $ran command(s) answered"
exit 0
`;
