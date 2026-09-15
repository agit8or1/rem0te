#!/usr/bin/env bash
#
# Turn the recorded WebM walkthrough into the published media set:
#   walkthrough.mp4    H.264/AAC, 1080p30 — broadly compatible
#   highlight.mp4      30-60s cut for the README
#   poster.png         thumbnail with a play affordance
#
# Raw recordings and finished video live under media/, which is gitignored:
# these are large binaries and do not belong in normal Git history. Publish
# them as GitHub release assets.
#
# Usage: scripts/build-video.sh [media-dir]
set -euo pipefail

DIR="${1:-media}"
RAW="$DIR/raw/walkthrough.webm"
[[ -f "$RAW" ]] || { echo "ERROR: $RAW not found — run apps/web/scripts/capture-video.mjs first" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not installed" >&2; exit 1; }
mkdir -p "$DIR"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW" | cut -d. -f1)
echo "→ source ${dur}s"

# yuv420p + faststart: what Safari, iOS and GitHub previews actually need.
echo "→ walkthrough.mp4"
ffmpeg -y -loglevel error -i "$RAW" \
  -r 30 -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -profile:v high -level 4.1 \
  -movflags +faststart -an "$DIR/walkthrough.mp4"

# Highlight: the opening title through the first workflow.
echo "→ highlight.mp4"
ffmpeg -y -loglevel error -ss 0 -t 52 -i "$RAW" \
  -r 30 -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 21 -profile:v high -level 4.1 \
  -movflags +faststart -an "$DIR/highlight.mp4"

# Poster: a populated dashboard frame, not the title card.
echo "→ poster.png"
ffmpeg -y -loglevel error -ss 24 -i "$RAW" -frames:v 1 \
  -vf "scale=1920:1080:flags=lanczos" "$DIR/poster-frame.png"

echo
ls -la "$DIR"/*.mp4 "$DIR"/poster-frame.png 2>/dev/null | awk '{printf "  %-28s %s\n", $9, $5}'
echo "✓ done — publish as release assets; media/ is gitignored"
