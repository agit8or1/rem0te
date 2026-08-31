import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PREFIXES = ['/login', '/mfa', '/api/', '/_next/', '/favicon.ico', '/download'];

// `/quick` is the public "I need remote support" page. It must stay reachable
// without an account — requiring one to receive a support session would defeat
// the point — and it exposes nothing from the console.
//
// Matched exactly, NOT as a prefix: `/quick-connect` and `/quickstart` are
// signed-in pages and a prefix match would quietly open them up.
const PUBLIC_EXACT = ['/quick'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for access token cookie
  const token = request.cookies.get('access_token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // world-basemap.json and world-basemap-detail.json are the dashboard map's
  // country and state geometry — the second fetched only once someone zooms in
  // far enough to see the difference. Public domain geometry, nothing to gate.
  // Both matched exactly rather than by prefix — this middleware is the app's
  // only auth gate, and a bare prefix would also exempt
  // /world-basemap<anything>.
  //
  // docs-img holds the documentation screenshots. They are served from public/
  // and are the same images already published in the repository, so gating them
  // buys nothing and costs a middleware round trip per image on a page that has
  // a lot of them.
  matcher: ['/((?!_next/static|_next/image|docs-img|favicon.ico|world\\-basemap\\.json|world\\-basemap\\-detail\\.json).*)'],
};
