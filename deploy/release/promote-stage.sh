#!/bin/bash
# promote-stage.sh STAGE PUB NODE REPO_INFO — run as the release user by
# publish_repo (lib.sh), after STAGE has passed `rem0te-release verify`.
#
# Moves a verified staging copy into the published repository by renames
# only, in the order TUF clients read it backwards from:
#   1. every target and versioned metadata file that is not there yet
#      (consistent snapshots: these names are content- or version-addressed,
#      so nothing the current timestamp points at is touched);
#   2. root.json (read by the portal's status page, not by agents);
#   3. timestamp.json — the commit point. Before this rename an agent sees the
#      previous release, whole; after it, the new one, whole.
# A versioned file that already exists with different bytes means the
# published repository has diverged from the signing one: stop before moving
# anything.
set -euo pipefail
umask 027
stage=$1 pub=$2 node=$3 info=$4
[[ -d $stage/metadata && -d $stage/targets && -d $pub ]] || { echo "promote-stage: bad arguments" >&2; exit 2; }
[[ -f $stage/metadata/timestamp.json && -f $stage/metadata/root.json ]] || { echo "promote-stage: staging copy is incomplete" >&2; exit 2; }

mapfile -d '' files < <(cd "$stage" && find metadata targets -type f ! -path metadata/timestamp.json ! -path metadata/root.json -print0 | sort -z)
new=()
for f in "${files[@]}"; do
  if [[ -e $pub/$f ]]; then
    cmp -s "$stage/$f" "$pub/$f" || { echo "promote-stage: $pub/$f already exists with different content; the published repository has diverged from the signing repository — nothing was changed" >&2; exit 3; }
  else
    new+=("$f")
  fi
done
for f in "${new[@]}"; do
  mkdir -p "$(dirname "$pub/$f")"
  mv -T "$stage/$f" "$pub/$f"
done
mv -T "$stage/metadata/root.json" "$pub/metadata/root.json"
mv -T "$stage/metadata/timestamp.json" "$pub/metadata/timestamp.json"
rm -rf "$stage"

# Old target files: keep everything the newest two targets versions list (an
# agent that read the previous timestamp a moment ago may still be fetching),
# remove the rest.
mapfile -t stale < <("$node" "$info" "$pub" prune-list)
for f in "${stale[@]}"; do
  if [[ $f == targets/* && $f != *..* ]]; then rm -f -- "$pub/$f"; fi
done
echo "published: ${#new[@]} new file(s) and timestamp.json; ${#stale[@]} old target file(s) removed"
