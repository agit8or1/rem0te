#!/usr/bin/env bash
#
# Turn the recorded WebM walkthrough into the published media set:
#   walkthrough.mp4    H.264, 1080p30, no audio — broadly compatible
#   highlight.mp4      the ~55 s cut (its own recording, CUT=highlight)
#   poster.png         a populated frame with a play affordance, for the README
#   poster-frame.png   the same frame, plain
#
# Raw recordings and finished video live under media/, which is gitignored:
# these are large binaries and do not belong in normal Git history. Publish
# them as GitHub release assets.
#
# Usage: scripts/build-video.sh [media-dir]
#   POSTER_AT=<seconds>  frame used for the poster (default 40)
#   POSTER_LABEL=<text>  line under the play button
set -euo pipefail

DIR="${1:-media}"
RAW="$DIR/raw/walkthrough.webm"
HL="$DIR/raw/highlight.webm"
[[ -f "$RAW" ]] || { echo "ERROR: $RAW not found — run apps/web/scripts/capture-video.mjs first" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not installed" >&2; exit 1; }
mkdir -p "$DIR"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW" | cut -d. -f1)
echo "→ source ${dur}s"

ENC=(-r 30 -vf "scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -preset slow -profile:v high -level 4.1 -movflags +faststart -an)

# yuv420p + faststart: what Safari, iOS and GitHub previews actually need.
echo "→ walkthrough.mp4"
ffmpeg -y -loglevel error -i "$RAW" "${ENC[@]}" -crf 22 "$DIR/walkthrough.mp4"

echo "→ highlight.mp4"
if [[ -f "$HL" ]]; then
  ffmpeg -y -loglevel error -i "$HL" "${ENC[@]}" -crf 21 "$DIR/highlight.mp4"
else
  # No separate highlight recording: the opening of the walkthrough.
  ffmpeg -y -loglevel error -ss 0 -t 55 -i "$RAW" "${ENC[@]}" -crf 21 "$DIR/highlight.mp4"
fi

# Poster: a populated frame, not the title card, with a play button.
AT="${POSTER_AT:-40}"
LABEL="${POSTER_LABEL:-Watch the walkthrough}"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
FONTB=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
echo "→ poster.png (frame at ${AT}s)"
ffmpeg -y -loglevel error -ss "$AT" -i "$RAW" -frames:v 1 -vf "scale=1920:1080:flags=lanczos" "$DIR/poster-frame.png"
if [[ -f "$FONT" && -f "$FONTB" ]]; then
  ffmpeg -y -loglevel error -i "$DIR/poster-frame.png" -vf "\
drawbox=x=0:y=0:w=iw:h=ih:color=black@0.38:t=fill,\
drawbox=x=(iw-230)/2:y=(ih-230)/2-40:w=230:h=230:color=0x0b1220@0.82:t=fill,\
drawtext=fontfile=$FONT:text='▶':fontsize=150:fontcolor=white:x=(w-text_w)/2+10:y=(h-text_h)/2-40,\
drawtext=fontfile=$FONTB:text='$LABEL':fontsize=46:fontcolor=white:x=(w-text_w)/2:y=(h/2)+120:box=1:boxcolor=0x0b1220@0.82:boxborderw=18" \
    "$DIR/poster.png"
else
  cp "$DIR/poster-frame.png" "$DIR/poster.png"
fi

echo
for f in walkthrough.mp4 highlight.mp4 poster.png poster-frame.png; do
  [[ -f "$DIR/$f" ]] || continue
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/$f" 2>/dev/null | cut -d. -f1)
  printf "  %-18s %10s bytes  %s\n" "$f" "$(stat -c %s "$DIR/$f")" "${d:+${d}s}"
done
echo "✓ done — publish as release assets; media/ is gitignored"
