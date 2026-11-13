#!/bin/bash
# rem0te-signed-setup.sh — set up signed releases on this host, once (0.37).
#
#   sudo ./deploy/release/rem0te-signed-setup.sh [--apply-env] [options]
#
# Run it from the source checkout. It:
#   1. creates the system user rem0te-release (no login shell), its state
#      directory /var/lib/rem0te-release (0700: keys/, the signing repository,
#      the RustDesk cache, the log) and the published repository
#      /var/lib/rem0te-updates (owner rem0te-release, group reboot, 2750/0640:
#      the portal reads it, cannot write it);
#   2. builds rem0te-release from `git archive HEAD` and installs it with the
#      rem0te-signed-* commands;
#   3. as rem0te-release, with umask 077, generates three root keys
#      (threshold 2) and the targets, snapshot and timestamp keys, and
#      initialises the signing repository. Keys are never printed and never
#      overwritten: if any key already exists, none is generated;
#   4. installs and starts rem0te-timestamp-refresh.timer (daily);
#   5. prints the UPDATE_REPO_DIR line for /etc/reboot-remote/api.env, or with
#      --apply-env adds it;
#   6. runs the first rem0te-signed-publish.
#
# Safe to run again: it never regenerates or overwrites a key, never
# re-initialises the repository, and refuses a half-present key set.
#
# Every path can be moved, so the test (apps/api/scripts/e2e-signed-release.mjs)
# runs all of it inside a temporary directory as an ordinary user:
#   --prefix DIR        put every default path under DIR (etc/, var/, usr/)
#   --no-user           no system user, no chown: everything as the invoking user
#   --no-systemd        install no units (run rem0te-signed-refresh yourself)
#   --no-publish        stop before the first publish
#   --apply-env         add UPDATE_REPO_DIR to the portal's env file
#   --source DIR        the checkout to build from (default: this one)
#   --state-dir, --pub-dir, --bin-dir, --lib-dir, --conf, --build-root,
#   --systemd-dir, --portal-env, --pub-group, --user NAME
#   --go PATH, --gotoolchain NAME, --gomodcache DIR, --gocache DIR, --node PATH,
#   --typescript DIR    the build tools (defaults: found on this host)
#   --rustdesk-version X.Y.Z, --rustdesk-api URL   (the latter: loopback tests only)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB=$HERE
# shellcheck source=lib.sh
source "$LIB/lib.sh"

# The Go toolchain the agent is built with when the host's go is older than
# go.mod asks (a bare "go1.27" does not exist as a toolchain name).
DEFAULT_GOTOOLCHAIN=go1.27.4

prefix='' no_user=0 no_systemd=0 no_publish=0 apply_env=0
o_source='' o_state='' o_pub='' o_bin='' o_lib='' o_conf='' o_build='' o_sysd='' o_env='' o_group='' o_user=''
o_go='' o_gotc='' o_gomod='' o_gocache='' o_node='' o_ts='' o_rd='' o_rdapi=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) prefix=$2; shift 2 ;;
    --no-user) no_user=1; shift ;;
    --no-systemd) no_systemd=1; shift ;;
    --no-publish) no_publish=1; shift ;;
    --apply-env) apply_env=1; shift ;;
    --source) o_source=$2; shift 2 ;;
    --state-dir) o_state=$2; shift 2 ;;
    --pub-dir) o_pub=$2; shift 2 ;;
    --bin-dir) o_bin=$2; shift 2 ;;
    --lib-dir) o_lib=$2; shift 2 ;;
    --conf) o_conf=$2; shift 2 ;;
    --build-root) o_build=$2; shift 2 ;;
    --systemd-dir) o_sysd=$2; shift 2 ;;
    --portal-env) o_env=$2; shift 2 ;;
    --pub-group) o_group=$2; shift 2 ;;
    --user) o_user=$2; shift 2 ;;
    --go) o_go=$2; shift 2 ;;
    --gotoolchain) o_gotc=$2; shift 2 ;;
    --gomodcache) o_gomod=$2; shift 2 ;;
    --gocache) o_gocache=$2; shift 2 ;;
    --node) o_node=$2; shift 2 ;;
    --typescript) o_ts=$2; shift 2 ;;
    --rustdesk-version) o_rd=$2; shift 2 ;;
    --rustdesk-api) o_rdapi=$2; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

if [[ $no_user -eq 0 && $EUID -ne 0 ]]; then die "run with sudo (or --no-user --prefix DIR for a test install)"; fi
if [[ -n $prefix ]]; then mkdir -p "$prefix"; prefix=$(cd "$prefix" && pwd); fi
abspath() { [[ $1 == /* ]] || die "$2 must be an absolute path"; printf '%s' "$1"; }

STATE_DIR=$(abspath "${o_state:-$prefix/var/lib/rem0te-release}" --state-dir)
KEY_DIR=$STATE_DIR/keys
WORK_REPO=$STATE_DIR/repo
PUB_DIR=$(abspath "${o_pub:-$prefix/var/lib/rem0te-updates}" --pub-dir)
BIN_DIR=$(abspath "${o_bin:-$prefix/usr/local/sbin}" --bin-dir)
LIB_DIR=$(abspath "${o_lib:-$prefix/usr/local/lib/rem0te-release}" --lib-dir)
CONF_PATH=$(abspath "${o_conf:-$prefix/etc/rem0te-release/release.conf}" --conf)
BUILD_ROOT=$(abspath "${o_build:-$prefix/var/tmp/rem0te-release-build}" --build-root)
SYSTEMD_DIR=$(abspath "${o_sysd:-$prefix/etc/systemd/system}" --systemd-dir)
PORTAL_ENV=$(abspath "${o_env:-$prefix/etc/reboot-remote/api.env}" --portal-env)
LOG_FILE=$STATE_DIR/publish.log
SOURCE_DIR=$(cd "${o_source:-$HERE/../..}" && pwd)
if [[ $no_user -eq 1 ]]; then
  RELEASE_USER=''
  PUB_GROUP=${o_group:-$(id -gn)}
else
  RELEASE_USER=${o_user:-rem0te-release}
  PUB_GROUP=${o_group:-reboot}
fi
SYSTEMD=$(( no_systemd ? 0 : 1 ))
RUSTDESK_VERSION=$o_rd
RUSTDESK_API=${o_rdapi:-$DEFAULT_RUSTDESK_API}
[[ -z $RUSTDESK_VERSION || $RUSTDESK_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--rustdesk-version wants x.y.z"
[[ $RUSTDESK_API == "$DEFAULT_RUSTDESK_API" || $RUSTDESK_API =~ ^http://127\.0\.0\.1:[0-9]+/ ]] || die "--rustdesk-api must be a loopback test server"

# ── Tools ───────────────────────────────────────────────────────────────────
GO=${o_go:-$(command -v go || echo /usr/local/go/bin/go)}
[[ -x $GO ]] || die "no Go toolchain (looked for $GO); install Go or pass --go"
GO=$(abspath "$(cd "$(dirname "$GO")" && pwd)/$(basename "$GO")" --go)
NODE=${o_node:-}
if [[ -z $NODE ]]; then for n in /usr/bin/node /usr/local/bin/node "$(command -v node || true)"; do if [[ -n $n && -x $n ]]; then NODE=$n; break; fi; done; fi
[[ -n $NODE && -x $NODE ]] || die "no node binary; pass --node"
TYPESCRIPT_DIR=${o_ts:-$SOURCE_DIR/apps/api/node_modules/typescript}
[[ -f $TYPESCRIPT_DIR/package.json ]] || die "TypeScript not found at $TYPESCRIPT_DIR (run pnpm install in $SOURCE_DIR, or pass --typescript)"
TYPESCRIPT_DIR=$(cd "$TYPESCRIPT_DIR" && pwd -P)
GOMODCACHE=$(abspath "${o_gomod:-$STATE_DIR/go/mod}" --gomodcache)
GOCACHE=$(abspath "${o_gocache:-$STATE_DIR/go/cache}" --gocache)
want=$(sed -n 's/^go \([0-9.]*\)$/\1/p' "$SOURCE_DIR/tools/windows-installer/go.mod")
# The binary's own version: with the caller's GOTOOLCHAIN inherited, `go env
# GOVERSION` reports the toolchain it would switch to, and the builds below run
# under `env -i` without that switch.
have=$(GOTOOLCHAIN=local "$GO" env GOVERSION 2>/dev/null | sed 's/^go//')
if [[ -n $o_gotc ]]; then GOTOOLCHAIN_SET=$o_gotc
elif [[ -n $have && -n $want ]] && ! ver_lt "$have" "$want"; then GOTOOLCHAIN_SET=local
elif [[ $DEFAULT_GOTOOLCHAIN == go$want.* ]]; then GOTOOLCHAIN_SET=$DEFAULT_GOTOOLCHAIN
else die "go.mod asks for Go $want and $GO is $have: pass --gotoolchain go$want.N (an exact release)"
fi
command -v git > /dev/null || die "git is required"
command -v curl > /dev/null || die "curl is required"
command -v flock > /dev/null || die "flock is required"

# ── The checkout ────────────────────────────────────────────────────────────
as_owner git -C "$SOURCE_DIR" rev-parse --git-dir > /dev/null 2>&1 || die "$SOURCE_DIR is not a git checkout"
check_trustroot_clean

# ── A second run must describe the same install ────────────────────────────
if [[ -f $CONF_PATH ]]; then
  for k in STATE_DIR PUB_DIR; do
    old=$(sed -n "s/^$k=//p" "$CONF_PATH")
    [[ -z $old || $old == "${!k}" ]] || die "$CONF_PATH already sets $k=$old; this run asks for ${!k}. Refusing to set up a second key store."
  done
fi

say "Setting up signed releases"
say "  release user  ${RELEASE_USER:-(none: $(id -un))}"
say "  keys          $KEY_DIR"
say "  published     $PUB_DIR (group $PUB_GROUP)"
say "  source        $SOURCE_DIR"
say "  go            $GO (GOTOOLCHAIN=$GOTOOLCHAIN_SET)"

# ── 1. User and directories ─────────────────────────────────────────────────
if [[ -n $RELEASE_USER ]]; then
  if ! id "$RELEASE_USER" > /dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin \
      --comment 'rem0te release signing (keys; never the portal)' "$RELEASE_USER"
    say "  created system user $RELEASE_USER"
  fi
  getent group "$PUB_GROUP" > /dev/null || die "group $PUB_GROUP does not exist (the portal's group; pass --pub-group)"
  if id -nG "$RELEASE_USER" | tr ' ' '\n' | grep -qx "$PUB_GROUP"; then die "$RELEASE_USER must not be in $PUB_GROUP"; fi
fi
mk() { # mode dir [group]
  if [[ ! -d $2 ]]; then mkdir -p "$2"; fi
  if [[ -n $RELEASE_USER ]]; then chown "$RELEASE_USER:${3:-$RELEASE_USER}" "$2"; elif [[ -n ${3:-} ]]; then chgrp "$3" "$2"; fi
  chmod "$1" "$2"
}
mk 0700 "$STATE_DIR"
mk 0700 "$KEY_DIR"
mk 0755 "$BUILD_ROOT"
mk 2750 "$PUB_DIR" "$PUB_GROUP"
mkdir -p "$(dirname "$CONF_PATH")" "$BIN_DIR" "$LIB_DIR"
for f in "$LOG_FILE" "$STATE_DIR/publish.lock"; do
  as_release 027 touch "$f"
done

# ── Configuration (KEY=VALUE, read without executing) ──────────────────────
tmpconf=$(mktemp "$(dirname "$CONF_PATH")/.release.conf.XXXXXX")
cat > "$tmpconf" <<EOF
# rem0te signed releases (0.37), written by rem0te-signed-setup.sh.
# Read as KEY=VALUE by the rem0te-signed-* commands; never executed.
STATE_DIR=$STATE_DIR
KEY_DIR=$KEY_DIR
WORK_REPO=$WORK_REPO
PUB_DIR=$PUB_DIR
PUB_GROUP=$PUB_GROUP
RELEASE_USER=$RELEASE_USER
SOURCE_DIR=$SOURCE_DIR
BIN_DIR=$BIN_DIR
LIB_DIR=$LIB_DIR
BUILD_ROOT=$BUILD_ROOT
LOG_FILE=$LOG_FILE
GO=$GO
GOTOOLCHAIN_SET=$GOTOOLCHAIN_SET
GOMODCACHE=$GOMODCACHE
GOCACHE=$GOCACHE
NODE=$NODE
TYPESCRIPT_DIR=$TYPESCRIPT_DIR
PORTAL_ENV=$PORTAL_ENV
RUSTDESK_API=$RUSTDESK_API
RUSTDESK_VERSION=$RUSTDESK_VERSION
SYSTEMD=$SYSTEMD
EOF
chmod 0644 "$tmpconf"
mv -f "$tmpconf" "$CONF_PATH"
load_conf "$CONF_PATH"
if [[ -n $RELEASE_USER ]]; then
  as_release 077 mkdir -p "$GOMODCACHE" "$GOCACHE"
else
  mkdir -p "$GOMODCACHE" "$GOCACHE"
fi

# ── 2. Build the release tool from HEAD and install the commands ───────────
recover_work
trap cleanup_build EXIT
new_build_dir
extract_head "$BUILD/src"
say "building rem0te-release from HEAD ($(head_commit))"
gobuild "$BUILD/src/tools/windows-installer" "$BUILD/out/rem0te-release" linux "-s -w" ./cmd/rem0te-release
install -m 0755 "$BUILD/out/rem0te-release" "$LIB_DIR/rem0te-release"
TOOL=$LIB_DIR/rem0te-release
R=$BUILD/src/deploy/release
[[ -f $R/lib.sh ]] || die "HEAD has no deploy/release (commit it first: the installed commands come from HEAD, like everything else)"
for f in lib.sh promote-stage.sh repo-info.mjs rustdesk-asset.mjs portal-pin.mjs; do install -m 0755 "$R/$f" "$LIB_DIR/$f"; done
esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
for c in rem0te-signed-publish rem0te-signed-status rem0te-signed-export-root rem0te-signed-refresh; do
  sed -e "s|@LIB_DIR@|$(esc "$LIB_DIR")|" -e "s|@CONF@|$(esc "$CONF_PATH")|" "$R/$c" > "$BIN_DIR/.$c.new"
  chmod 0755 "$BIN_DIR/.$c.new"
  mv -f "$BIN_DIR/.$c.new" "$BIN_DIR/$c"
done
LIB=$LIB_DIR
say "  installed rem0te-signed-publish, -status, -export-root, -refresh in $BIN_DIR"

# ── 3. Keys and the signing repository ─────────────────────────────────────
present=0 missing=()
for k in $ROOT_KEYS $ROLE_KEYS; do if key_present "$k"; then present=$((present + 1)); else missing+=("$k"); fi; done
exported=0; if as_release 077 test -f "$KEY_DIR/ROOT_EXPORTED"; then exported=1; fi
if (( present == 0 && exported == 0 )); then
  [[ ! -e $WORK_REPO ]] || die "$WORK_REPO exists but there are no keys: refusing to generate keys for a repository someone else signed"
  for k in $ROOT_KEYS $ROLE_KEYS; do
    tool keygen -out "$KEY_DIR/$k.pem" | sed -n 's/^keyid /  generated '"$k"' key, id /p'
  done
elif (( present == 6 )) || { (( exported == 1 )) && [[ ${missing[*]} == "root1 root2 root3" ]]; }; then
  say "  keys already exist in $KEY_DIR; none generated, none changed"
else
  die "an incomplete key set is in $KEY_DIR (missing: ${missing[*]}). Refusing to generate or replace any key; restore the missing ones."
fi
as_release 077 chmod 0700 "$KEY_DIR"
as_release 077 find "$KEY_DIR" -type f -exec chmod 0600 {} +
if [[ -f $WORK_REPO/metadata/root.json ]]; then
  say "  signing repository already initialised at $WORK_REPO"
else
  for k in $ROOT_KEYS; do key_present "$k" || die "the repository is not initialised and $k.pem is not here"; done
  tool init -repo "$WORK_REPO" \
    -root-key "$KEY_DIR/root1.pem" -root-key "$KEY_DIR/root2.pem" -root-key "$KEY_DIR/root3.pem" -root-threshold 2 \
    -targets-key "$KEY_DIR/targets.pem" -snapshot-key "$KEY_DIR/snapshot.pem" -timestamp-key "$KEY_DIR/timestamp.pem" > /dev/null
  say "  initialised the signing repository (root threshold 2 of 3)"
fi
# The portal's user (named like its group, `reboot`) must not be able to read a key.
if [[ -n $RELEASE_USER ]] && id -u "$PUB_GROUP" > /dev/null 2>&1; then
  for k in $ROLE_KEYS; do
    if runuser -u "$PUB_GROUP" -- test -r "$KEY_DIR/$k.pem" 2>/dev/null; then die "$PUB_GROUP can read $KEY_DIR/$k.pem — fix the permissions before going on"; fi
  done
  say "  checked: the $PUB_GROUP user cannot read the keys"
fi

# ── 4. The daily timestamp ──────────────────────────────────────────────────
if (( SYSTEMD )); then
  mkdir -p "$SYSTEMD_DIR"
  for u in rem0te-timestamp-refresh.service rem0te-timestamp-refresh.timer; do
    sed -e "s|@RELEASE_USER@|$(esc "$RELEASE_USER")|g" -e "s|@BIN_DIR@|$(esc "$BIN_DIR")|g" -e "s|@CONF@|$(esc "$CONF_PATH")|g" \
        -e "s|@STATE_DIR@|$(esc "$STATE_DIR")|g" -e "s|@PUB_DIR@|$(esc "$PUB_DIR")|g" -e "s|@BUILD_ROOT@|$(esc "$BUILD_ROOT")|g" \
        "$R/systemd/$u" > "$SYSTEMD_DIR/$u"
    chmod 0644 "$SYSTEMD_DIR/$u"
  done
  systemctl daemon-reload
  systemctl enable --now rem0te-timestamp-refresh.timer
  say "  rem0te-timestamp-refresh.timer enabled (daily)"
else
  say "  no systemd units (--no-systemd): run $BIN_DIR/rem0te-signed-refresh at least every 3 days"
fi

# ── 5. The portal's UPDATE_REPO_DIR ────────────────────────────────────────
envline="UPDATE_REPO_DIR=$PUB_DIR"
if (( apply_env )); then
  if [[ -f $PORTAL_ENV ]] && grep -q '^UPDATE_REPO_DIR=' "$PORTAL_ENV"; then
    cur=$(sed -n 's/^UPDATE_REPO_DIR=//p' "$PORTAL_ENV" | tail -1)
    [[ $cur == "$PUB_DIR" ]] || die "$PORTAL_ENV already sets UPDATE_REPO_DIR=$cur; change it yourself if you mean to"
    say "  $PORTAL_ENV already has $envline"
  else
    mkdir -p "$(dirname "$PORTAL_ENV")"
    printf '\n# Signed update repository (rem0te-signed-setup.sh, 0.37)\n%s\n' "$envline" >> "$PORTAL_ENV"
    say "  added $envline to $PORTAL_ENV — restart the API to pick it up"
  fi
fi

# ── 6. First publish ────────────────────────────────────────────────────────
cleanup_build; trap - EXIT
if (( no_publish )); then
  say "Skipping the first publish (--no-publish). Run: $BIN_DIR/rem0te-signed-publish"
else
  say "First publish:"
  publish_args=(--conf "$CONF_PATH")
  "$BIN_DIR/rem0te-signed-publish" "${publish_args[@]}"
fi

cat <<EOF

Done. Next:
  1. The portal needs this line in $PORTAL_ENV, then a restart of the API:
       $envline
$( (( apply_env )) && echo "     (added by --apply-env)" || echo "     (or re-run with --apply-env to add it)")
  2. Move the root keys off this host (they are needed only to rotate keys):
       sudo rem0te-signed-export-root /media/<usb-stick>
  3. After every deploy:  sudo rem0te-signed-publish
     Status at any time:   sudo rem0te-signed-status
EOF
