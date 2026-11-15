#!/usr/bin/env node
/**
 * Write docs/media/walkthrough.vtt and docs/media/walkthrough-script.md from
 * the caption log capture-video.mjs leaves next to the recording
 * (media/raw/walkthrough.captions.json). The log holds every caption and
 * chapter with the second it appeared, so the tracked captions match the
 * recording exactly instead of being retimed by hand.
 *
 *   node scripts/video-captions.mjs [media-dir]
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] ?? path.join(ROOT, 'media');
// The version recorded: the checkout's own, read rather than written in here.
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
const log = JSON.parse(readFileSync(path.join(DIR, 'raw/walkthrough.captions.json'), 'utf8'));
let hl = null;
try { hl = JSON.parse(readFileSync(path.join(DIR, 'raw/highlight.captions.json'), 'utf8')); } catch { /* optional */ }

const pad = (n, w = 2) => String(n).padStart(w, '0');
const vttTime = (s) => { const ms = Math.round(s * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`; };
const clock = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const wrap = (t, n = 52) => { const out = []; let line = ''; for (const w of t.split(/\s+/)) { if (line && (line + ' ' + w).length > n) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; } if (line) out.push(line); return out.join('\n'); };

const cues = log.events.filter((e) => e.kind === 'caption' || e.kind === 'card');
const chapters = log.events.filter((e) => e.kind === 'chapter');
const dur = log.duration;

let vtt = `WEBVTT

NOTE
Captions for the Rem0te walkthrough (media/walkthrough.mp4, ${clock(dur)}).
The video is caption-led and has no narration or audio track; these cues are
the on-screen captions, timed from the recorder's own log
(scripts/video-captions.mjs).

`;
cues.forEach((c, i) => {
  const end = Math.max(c.start + 1, Math.min(c.end ?? dur, (cues[i + 1]?.start ?? dur) - 0.05));
  vtt += `${i + 1}\n${vttTime(c.start)} --> ${vttTime(end)}\n${wrap(c.text.replace(/\n/g, ' '))}\n\n`;
});
writeFileSync(path.join(ROOT, 'docs/media/walkthrough.vtt'), vtt.trimEnd() + '\n');

const esc = (t) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
let md = `# Rem0te walkthrough — script and transcript

The walkthrough is **caption-led**: the on-screen captions below are what the
recording shows, word for word. **No narration was produced**, and the video
has no audio track.

Recorded against the isolated demo stack described in
[docs/screenshots.md](../screenshots.md#regenerating-these), on v${VERSION}. Every
business, person and computer in it is fictitious, and the computers report
through a **simulated agent**: none of the computer actions shown ran on a real
Windows PC. The AI provider and the PSA are loopback stand-ins on the demo
server.

**Length:** ${clock(dur)}${hl ? ` · highlight cut: ${clock(hl.duration)}` : ''}

## Chapters

| Time | Chapter |
|---|---|
${chapters.map((c) => `| ${clock(c.start)} | ${esc(c.text)} |`).join('\n')}

## Captions

| # | Time | Chapter | On-screen caption |
|---|---|---|---|
${cues.map((c, i) => `| ${i + 1} | ${clock(c.start)} | ${esc(c.chapter ?? (c.kind === 'card' ? 'Title card' : ''))} | ${esc(c.text)} |`).join('\n')}

## How it was made

- \`apps/web/scripts/capture-video.mjs\` drives the real application with
  Playwright at 1920 × 1080 and records WebM. A red ring marks what is about
  to be read or clicked, and a drawn pointer moves to it (headless Chromium
  records no pointer of its own). \`CUT=highlight\` records the short cut.
- \`scripts/build-video.sh\` encodes the MP4s and the poster;
  \`scripts/video-captions.mjs\` writes this page and \`walkthrough.vtt\` from
  the recorder's caption log.
- Masking (\`apps/web/scripts/capture-masks.mjs\`) runs in the page before
  anything is painted: enrolment tokens, long hex secrets, RustDesk IDs, public
  IP addresses and host names outside a small allowlist are replaced in the
  DOM, so no frame carries them. Nothing is written back to the database.
- No remote session is established. Connect stops at its confirmation dialog;
  the service, process, uninstall, install and catalog dialogs are opened and
  cancelled. The only writes are one chat message and one ticket sent to the
  loopback PSA stand-in.
`;
writeFileSync(path.join(ROOT, 'docs/media/walkthrough-script.md'), md);
console.log(`wrote ${cues.length} cues, ${chapters.length} chapters, ${clock(dur)}`);
