/**
 * Content-Security-Policy for the console.
 *
 * Only API responses carried one (helmet's), so the pages that actually render
 * user-controlled data had none. `'unsafe-inline'` stays on script-src because
 * the App Router inlines its hydration payload; what this buys is everything
 * else — no foreign script origins, no plugins, no <base> hijack, no framing,
 * no form posts or fetches to anywhere but this origin. GitHub is allowed for
 * the one client-side release lookup on /download.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.github.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // `X-Powered-By: Next.js` tells a scanner which advisories to try first.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Everything but /assist (0.36): the tray's chat page is served by the
        // API with its own, stricter policy (no inline script at all), and a
        // second, looser header here would only muddy what applies.
        source: '/:path((?!assist(?:/|$)).*)',
        headers: [
          // HSTS, nosniff, framing and referrer headers come from Caddy.
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        // The tray's chat page (0.36), served by the API: /assist/* here is
        // /api/v1/assist/* there, so its cookie (Path=/assist) is scoped to
        // the page and never sent to the console or the API's other routes.
        source: '/assist/:path*',
        destination: `${process.env.INTERNAL_API_URL ?? 'http://localhost:3001'}/api/v1/assist/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${process.env.INTERNAL_API_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
