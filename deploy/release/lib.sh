# shellcheck shell=bash
# Shared by the rem0te-signed-* commands (0.37). Sourced, never executed.
#
# Who runs what:
#   root (sudo)      — reads the configuration, switches user, installs the
#                      release tool. Never signs and never builds.
#   RELEASE_USER     — owns the keys (KEY_DIR, 0700), the signing repository,
#                      the build directory and the published repository. Runs
#                      the Go builds (which execute no repository code) and
#                      every rem0te-release command.
#   the checkout's   — runs git, and the one step that executes JavaScript
#   owner              from the checkout (TypeScript → install.ps1). That user
#                      already controls the source being signed, so running
#                      their code as them gives nothing away; running it as
#                      RELEASE_USER would hand their node_modules the keys.
#
# With --no-user (the test), RELEASE_USER is empty and everything runs as the
# invoking user, inside a prefix.
set -euo pipefail
umask 027

SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONF_KEYS="STATE_DIR KEY_DIR WORK_REPO PUB_DIR PUB_GROUP RELEASE_USER SOURCE_DIR BIN_DIR LIB_DIR BUILD_ROOT LOG_FILE GO GOTOOLCHAIN_SET GOMODCACHE GOCACHE NODE TYPESCRIPT_DIR PORTAL_ENV RUSTDESK_API RUSTDESK_VERSION SYSTEMD"
ROOT_KEYS="root1 root2 root3"
ROLE_KEYS="targets snapshot timestamp"
TRUSTROOT=tools/windows-installer/trustroot/root.json
DEFAULT_RUSTDESK_API=https://api.github.com/repos/rustdesk/rustdesk/releases

log() {
  if [[ -n "${LOG_FILE:-}" && -w "${LOG_FILE:-/nonexistent}" ]]; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true
  fi
}
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Read KEY=VALUE lines without executing anything. The file must be owned by
# root or by the invoking user, and not writable by anyone else: whoever can
# write it chooses which directory the keys are read from.
load_conf() {
  local f=$1 line k v owner mode
  [[ -f $f ]] || die "no configuration at $f — run deploy/release/rem0te-signed-setup.sh first"
  owner=$(stat -c %u "$f"); mode=$(stat -c %a "$f")
  [[ $owner == 0 || $owner == "$(id -u)" ]] || die "$f is owned by uid $owner, not root"
  (( (8#$mode & 8#022) == 0 )) || die "$f is group- or world-writable"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    k=${line%%=*}; v=${line#*=}
    case " $CONF_KEYS " in
      *" $k "*) printf -v "$k" '%s' "$v" ;;
      *) die "unknown setting '$k' in $f" ;;
    esac
  done < "$f"
  local p
  for p in STATE_DIR KEY_DIR WORK_REPO PUB_DIR SOURCE_DIR LIB_DIR BUILD_ROOT LOG_FILE GO NODE; do
    [[ ${!p:-} == /* ]] || die "$p in $f must be an absolute path"
  done
  CONF_FILE=$f
}

# Run as the release user, with the given umask.
as_release() {
  local m=$1; shift
  if [[ -z ${RELEASE_USER:-} || $(id -un) == "$RELEASE_USER" ]]; then
    ( umask "$m"; exec "$@" )
  elif [[ $EUID -eq 0 ]]; then
    runuser -u "$RELEASE_USER" -- /bin/sh -c 'umask "$0"; exec "$@"' "$m" "$@"
  else
    die "run this with sudo: it acts as $RELEASE_USER"
  fi
}

# Run as the owner of the source checkout (git refuses a repository owned by
# someone else, and the checkout's own JavaScript runs only as its owner).
as_owner() {
  local o; o=$(stat -c %U "$SOURCE_DIR")
  if [[ $EUID -eq 0 && $o != root ]]; then runuser -u "$o" -- "$@"; else "$@"; fi
}

# The release tool, as the release user, with a private TMPDIR.
tool() {
  as_release 077 env -i PATH="$SAFE_PATH" TMPDIR="$TMP_DIR" "$TOOL" "$@"
}

lock_or_die() {
  exec 9>>"$STATE_DIR/publish.lock"
  flock -n 9 || die "another rem0te-signed publish or refresh is running"
}

# The checked-out root of trust must stay the `{}` placeholder, in the
# working tree and in HEAD: the owner's root.json is written only into a build
# copy and must never reach git (and so GitHub).
check_trustroot_clean() {
  local wt head
  wt=$(tr -d ' \t\r\n' < "$SOURCE_DIR/$TRUSTROOT" 2>/dev/null || echo missing)
  head=$(as_owner git -C "$SOURCE_DIR" show "HEAD:$TRUSTROOT" 2>/dev/null | tr -d ' \t\r\n' || echo missing)
  [[ $wt == '{}' ]] || die "$SOURCE_DIR/$TRUSTROOT is not the {} placeholder. The root of trust is written only into the build copy and must never be committed: restore it with  git -C $SOURCE_DIR checkout -- $TRUSTROOT"
  [[ $head == '{}' ]] || die "HEAD:$TRUSTROOT is not the {} placeholder: a real root.json was committed. Remove it from that commit before publishing (never push it)."
}

# A fresh build directory, owned by the release user, readable by the
# checkout's owner (who runs the TypeScript step against it).
new_build_dir() {
  BUILD=$(as_release 022 mktemp -d "$BUILD_ROOT/build.XXXXXX")
  as_release 022 chmod 0755 "$BUILD"
  as_release 022 mkdir -p "$BUILD/src" "$BUILD/out" "$BUILD/tmp"
  as_release 022 chmod 0700 "$BUILD/tmp"
  TMP_DIR=$BUILD/tmp
}

cleanup_build() {
  if [[ -n ${BUILD:-} && -d $BUILD ]]; then as_release 022 rm -rf "$BUILD" || true; fi
}

# git archive of HEAD — never the working tree — unpacked by the release user.
extract_head() {
  as_owner git -C "$SOURCE_DIR" archive --format=tar HEAD | as_release 022 tar -x -C "$1" -f -
  [[ -f $1/version.json && -d $1/tools/windows-installer ]] || die "git archive of HEAD produced no source tree"
}

head_commit() { as_owner git -C "$SOURCE_DIR" rev-parse --verify 'HEAD^{commit}'; }

json_version() { # file → .version, validated
  "$NODE" -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version; if(!/^\d+\.\d+\.\d+$/.test(String(v))) process.exit(3); process.stdout.write(v)' "$1"
}

# 0 when $1 < $2 (dotted numeric versions).
ver_lt() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1) == "$1" ]]; }

gobuild() { # srcdir out goos ldflags pkg
  as_release 022 env -i PATH="$SAFE_PATH" HOME="$STATE_DIR" GOPATH="$STATE_DIR/go" \
    GOMODCACHE="$GOMODCACHE" GOCACHE="$GOCACHE" GOTOOLCHAIN="$GOTOOLCHAIN_SET" GOFLAGS=-mod=readonly \
    CGO_ENABLED=0 GOOS="$3" GOARCH=amd64 TMPDIR="$TMP_DIR" \
    /bin/sh -c 'cd "$0" && exec "$@"' "$1" "$GO" build -trimpath -buildvcs=false -ldflags "$4" -o "$2" "$5"
}

repo_info() { "$NODE" "$LIB/repo-info.mjs" "$@"; }

key_present() { as_release 077 test -f "$KEY_DIR/$1.pem"; }

# Copy a signing repository into a staging directory beside the published
# one, verify the staging copy with the agents' own client, then move it in
# with promote-stage.sh. The published repository is only ever changed by
# renames, and the last rename — timestamp.json — is the commit point: until
# it lands, every client still sees the previous release, complete.
publish_repo() {
  local src=$1 stage
  stage=$(as_release 027 mktemp -d "$PUB_DIR/.staging.XXXXXX")
  as_release 027 cp -r "$src/metadata" "$src/targets" "$stage/"
  as_release 027 find "$stage" -name '*.tmp' -delete
  as_release 027 chmod -R u=rwX,g=rX,o= "$stage"
  # Test hook (never as root): damage the staged copy to prove it is caught.
  if [[ $EUID -ne 0 && ${REM0TE_SIGNED_TEST_CORRUPT_STAGING:-} == 1 ]]; then
    local victim; victim=$(find "$stage/targets" -type f -name '*.rem0te-agent.exe' | head -1)
    printf 'X' | dd of="$victim" bs=1 seek=100 conv=notrunc status=none
  fi
  if ! tool verify -repo "$stage" -trusted-root "$WORK_REPO/metadata/1.root.json" >> "$LOG_FILE" 2>&1; then
    as_release 027 rm -rf "$stage"
    die "the staged repository failed verification; the published repository was not changed (see $LOG_FILE)"
  fi
  as_release 027 "$LIB/promote-stage.sh" "$stage" "$PUB_DIR" "$NODE" "$LIB/repo-info.mjs"
}

# Replace the signing repository with a verified copy (two renames in the
# release user's own directory).
promote_work() {
  as_release 077 rm -rf "$WORK_REPO.next"
  as_release 077 cp -a "$1" "$WORK_REPO.next"
  as_release 077 /bin/sh -c 'rm -rf "$0.prev" && mv "$0" "$0.prev" && mv "$0.next" "$0" && rm -rf "$0.prev"' "$WORK_REPO"
}

recover_work() {
  if [[ ! -d $WORK_REPO && -d $WORK_REPO.prev ]]; then
    as_release 077 mv "$WORK_REPO.prev" "$WORK_REPO"
    log "recovered the signing repository from an interrupted swap"
  fi
  as_release 077 rm -rf "$WORK_REPO.next"
}

# Open a log under STATE_DIR and copy everything to it.
start_log() {
  if [[ ! -e $LOG_FILE ]]; then as_release 027 touch "$LOG_FILE"; fi
  exec > >(tee -a "$LOG_FILE") 2>&1
  printf '\n── %s %s (uid %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(id -u)"
}
