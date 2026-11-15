#!/usr/bin/env node
// Generates the tray icons (0.51) — the .ico files next to this script are
// its output and are committed with it; nothing else writes them.
//
//   node tools/windows-installer/cmd/rem0te-tray/icons/gen-icons.mjs
//       rewrite the eight .ico files
//   node tools/windows-installer/cmd/rem0te-tray/icons/gen-icons.mjs --check
//       regenerate in memory and exit 1 if a committed file differs
//   node tools/windows-installer/cmd/rem0te-tray/icons/gen-icons.mjs --preview DIR
//       also write contact sheets (1x and 8x, on a light and a dark taskbar)
//
// No dependencies: shapes are rasterised here with 16x16 supersampling, each
// image is a PNG (node:zlib, a hand-rolled CRC) and each .ico holds one PNG
// per size (PNG entries are valid in .ico from Windows Vista on, and
// CreateIconFromResourceEx reads them). Output is deterministic: the same
// script always writes the same bytes, which is what --check relies on.
//
// The design: a round badge with a bright ring around a deep disc and a
// white speech bubble — one silhouette that stays the same in every state,
// so the person learns it once, and a ring colour that says the state:
//
//   normal     cyan ring        (the support tray is here)
//   connected  green ring, three dots in the bubble (a chat is open)
//   attention  amber ring and a red dot cut out of the top right (unread)
//   offline    grey ring, grey disc (the portal cannot be reached)
//
// Two themes: on a dark taskbar the ring is a light, saturated tint with a
// soft glow outside it (from 24 px up); on a light taskbar the ring is a
// deeper shade of the same hue and there is no glow — a glow on a light
// background reads as a smudge, not light. Every size has its own geometry
// table, snapped so the bubble's edges fall on pixel boundaries: at 16 px the
// bubble is exactly 9x5 whole pixels and each dot one whole pixel, which is what keeps it a bubble and
// not a blur.

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIZES = [16, 20, 24, 32, 40, 48];
export const STATES = ['normal', 'connected', 'attention', 'offline'];
export const THEMES = ['dark', 'light'];

// ── Palette ─────────────────────────────────────────────────────────────────
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const PALETTE = {
  dark: {
    disc: hex('#12307A'), discOffline: hex('#3F4654'), glyph: hex('#FFFFFF'), glyphOffline: hex('#D4D8DE'),
    ring: { normal: hex('#36E2FF'), connected: hex('#3DF59A'), attention: hex('#FFB21E'), offline: hex('#9AA3AF') },
    glow: true,
  },
  light: {
    disc: hex('#12307A'), discOffline: hex('#4B5563'), glyph: hex('#FFFFFF'), glyphOffline: hex('#E5E7EB'),
    ring: { normal: hex('#0596C7'), connected: hex('#08A060'), attention: hex('#E08600'), offline: hex('#A3AAB5') },
    glow: false,
  },
};
const BADGE = hex('#FF2D3A');

// ── Geometry per size (pixel units; the canvas is 0..S) ─────────────────────
// r: outer radius of the ring, w: ring width, glow: glow width outside it,
// bubble: [x0, y0, x1, y1, corner radius], tail: triangle points,
// dots: [y, radius, [x...]], badge: [cx, cy, r, gap].
const GEO = {
  16: { r: 8, w: 1.75, glow: 0, bubble: [3, 4, 12, 9, 1.5], tail: [[4.5, 8.5], [7.5, 8.5], [4.5, 12]], dots: [6.5, 0.5, [5.5, 7.5, 9.5], 'square'], badge: [12.5, 3.5, 3.1, 1] },
  20: { r: 10, w: 2.25, glow: 0, bubble: [5, 5, 16, 11, 1.8], tail: [[6, 10.5], [9.5, 10.5], [6, 15]], dots: [7.5, 0.5, [8.5, 10.5, 12.5], 'square'], badge: [15.5, 4.5, 3.8, 1.1] },
  24: { r: 11, w: 2.5, glow: 1, bubble: [6, 6, 18, 13, 2], tail: [[7.5, 12.5], [11.5, 12.5], [7.5, 17.5]], dots: [9.5, 0.95, [9, 12, 15]], badge: [18.5, 5.5, 4.4, 1.2] },
  32: { r: 14.5, w: 3, glow: 1.5, bubble: [8, 8, 24, 18, 2.8], tail: [[10, 17.5], [15, 17.5], [10, 23.5]], dots: [13, 1.25, [12, 16, 20]], badge: [24.5, 7.5, 5.8, 1.5] },
  40: { r: 18, w: 3.75, glow: 2, bubble: [10, 10, 30, 22, 3.4], tail: [[12.5, 21.5], [19, 21.5], [12.5, 29.5]], dots: [16, 1.55, [15, 20, 25]], badge: [30.5, 9.5, 7.2, 1.8] },
  48: { r: 21.5, w: 4.5, glow: 2.5, bubble: [12, 12, 36, 27, 4], tail: [[15, 26.5], [23, 26.5], [15, 35.5]], dots: [19.5, 1.85, [18, 24, 30]], badge: [36.5, 11.5, 8.6, 2.2] },
};

// ── Coverage tests (inside = true) ──────────────────────────────────────────
function inRoundRect(x, y, [x0, y0, x1, y1, rr]) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rr), x1 - rr);
  const cy = Math.min(Math.max(y, y0 + rr), y1 - rr);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
}
function inTri(x, y, [[ax, ay], [bx, by], [cx, cy]]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const SS = 16; // supersampling per axis

/** Draws one image: RGBA, straight (not premultiplied) alpha. */
export function render(size, state, theme) {
  const g = GEO[size];
  const p = PALETTE[theme];
  const c = size / 2;
  const ring = p.ring[state];
  const disc = state === 'offline' ? p.discOffline : p.disc;
  const glyph = state === 'offline' ? p.glyphOffline : p.glyph;
  const rIn = g.r - g.w;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Accumulate premultiplied colour over the subsamples.
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
          const d = Math.hypot(x - c, y - c);
          let col = null, a = 0;
          if (state === 'attention') {
            const [bx, by, br, gap] = g.badge;
            const bd = Math.hypot(x - bx, y - by);
            if (bd <= br) { col = BADGE; a = 1; }
            else if (bd <= br + gap) continue; // the cut-out: the taskbar shows through
          }
          if (!col) {
            if (d <= rIn) {
              col = disc; a = 1;
              const inBubble = inRoundRect(x, y, g.bubble) || inTri(x, y, g.tail);
              if (inBubble) {
                col = glyph;
                if (state === 'connected') {
                  // Round dots, except at 16 and 20 px: there a dot is exactly one
                  // whole pixel, or the three merge into a bar.
                  const [dy, dr, xs, shape] = g.dots;
                  const hit = shape === 'square'
                    ? (dx) => Math.abs(x - dx) <= dr && Math.abs(y - dy) <= dr
                    : (dx) => Math.hypot(x - dx, y - dy) <= dr;
                  if (xs.some(hit)) col = disc;
                }
              }
            } else if (d <= g.r) { col = ring; a = 1; }
            else if (p.glow && g.glow > 0 && d <= g.r + g.glow) {
              col = ring; a = 0.55 * (1 - (d - g.r) / g.glow) ** 1.6;
            }
          }
          if (col) { R += col[0] * a; G += col[1] * a; B += col[2] * a; A += a; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = A / n;
      if (alpha > 0) {
        out[i] = Math.round(R / A); out[i + 1] = Math.round(G / A); out[i + 2] = Math.round(B / A);
        out[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

// ── PNG / ICO encoding ──────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function ico(images /* [{size, png}] */) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach((im, k) => {
    const e = 6 + 16 * k;
    head[e] = im.size >= 256 ? 0 : im.size; head[e + 1] = im.size >= 256 ? 0 : im.size;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(im.png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += im.png.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.png)]);
}

export const fileName = (state, theme) => `tray-${state}-${theme}.ico`;

function build() {
  const files = new Map();
  const rasters = new Map();
  for (const theme of THEMES) {
    for (const state of STATES) {
      const imgs = SIZES.map((size) => {
        const px = render(size, state, theme);
        rasters.set(`${state}-${theme}-${size}`, px);
        return { size, png: png(size, size, px) };
      });
      files.set(fileName(state, theme), ico(imgs));
    }
  }
  return { files, rasters };
}

// ── Contact sheets ──────────────────────────────────────────────────────────
function sheet(rasters, theme, scale) {
  const bg = theme === 'dark' ? hex('#202020') : hex('#F3F3F3');
  const pad = 8 * (scale > 1 ? 2 : 1);
  const cellW = SIZES.map((s) => s * scale + pad);
  const W = cellW.reduce((a, b) => a + b, pad);
  const rowH = 48 * scale + pad;
  const H = pad + rowH * STATES.length;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { img[i * 4] = bg[0]; img[i * 4 + 1] = bg[1]; img[i * 4 + 2] = bg[2]; img[i * 4 + 3] = 255; }
  STATES.forEach((state, row) => {
    let x0 = pad;
    SIZES.forEach((size, col) => {
      const px = rasters.get(`${state}-${theme}-${size}`);
      const y0 = pad + row * rowH;
      for (let y = 0; y < size * scale; y++) {
        for (let x = 0; x < size * scale; x++) {
          const si = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
          const a = px[si + 3] / 255;
          const di = ((y0 + y) * W + x0 + x) * 4;
          for (let k = 0; k < 3; k++) img[di + k] = Math.round(px[si + k] * a + img[di + k] * (1 - a));
        }
      }
      x0 += cellW[col];
    });
  });
  return png(W, H, img);
}

const argv = process.argv.slice(2);
const { files, rasters } = build();
if (argv.includes('--check')) {
  const bad = [];
  for (const [name, buf] of files) {
    let have = null;
    try { have = readFileSync(join(HERE, name)); } catch { /* missing */ }
    if (!have || !have.equals(buf)) bad.push(name);
  }
  if (bad.length) {
    console.error(`tray icons are out of date (${bad.join(', ')}): run node tools/windows-installer/cmd/rem0te-tray/icons/gen-icons.mjs`);
    process.exit(1);
  }
  console.log(`tray icons: ${files.size} files match the generator`);
} else {
  for (const [name, buf] of files) writeFileSync(join(HERE, name), buf);
  console.log(`tray icons: wrote ${files.size} files to ${HERE}`);
}
const pi = argv.indexOf('--preview');
if (pi >= 0 && argv[pi + 1]) {
  const dir = argv[pi + 1];
  mkdirSync(dir, { recursive: true });
  for (const theme of THEMES) {
    writeFileSync(join(dir, `tray-${theme}-1x.png`), sheet(rasters, theme, 1));
    writeFileSync(join(dir, `tray-${theme}-8x.png`), sheet(rasters, theme, 8));
  }
  console.log(`previews: ${dir}`);
}
