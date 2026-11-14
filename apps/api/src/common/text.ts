/**
 * Character classes for text that crosses a boundary (0.48), built from code
 * points as email/mail-content.ts does, so the source holds no invisible
 * characters and no control-character regex literals.
 */
const cls = (ranges: [number, number][]) => ranges.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('');

/** Controls except tab and newline, plus line/paragraph separators and bidi overrides. */
// eslint-disable-next-line security/detect-non-literal-regexp -- constant input, no user data
export const CONTROLS_KEEP_LINES = new RegExp(`[${cls([[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]])}]`, 'gu');

/** Every control character, newlines included. */
// eslint-disable-next-line security/detect-non-literal-regexp -- constant input, no user data
export const CONTROLS_ALL = new RegExp(`[${cls([[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]])}]`, 'gu');
