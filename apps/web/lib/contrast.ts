/**
 * Text on a branding accent colour (0.35).
 *
 * The accent is whatever the operator picked (an `@IsHexColor` string), so
 * no fixed ink is readable on all of them: white vanished on a pale yellow
 * and the drawer's grey close button on almost anything. `inkOn()` picks
 * black or white by WCAG 2.x relative luminance, whichever contrasts more.
 * One of the two always reaches at least 4.58:1 against any opaque sRGB
 * colour — the worst case is the colour whose contrast with both is equal,
 * √(1.05 × 0.05) − 0.05 luminance — so the result always meets WCAG AA for
 * normal text (4.5:1).
 */

/** #rgb, #rgba, #rrggbb or #rrggbbaa (the `#` optional) → [r, g, b] 0–255; alpha is ignored. Null if not hex. */
export function parseHex(color: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((color ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two luminances, 1 to 21. */
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever is more readable on `color`; null when `color` is not a hex colour. */
export function inkOn(color: string | null | undefined): '#000000' | '#ffffff' | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const l = luminance(rgb);
  return contrastRatio(l, 0) > contrastRatio(l, 1) ? '#000000' : '#ffffff';
}
