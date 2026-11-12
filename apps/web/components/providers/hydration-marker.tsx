'use client';

import { useEffect } from 'react';

/**
 * Sets `data-hydrated` on <html> once React has hydrated the page (0.34).
 *
 * The browser suite (scripts/e2e-ui.mjs) waits for it before clicking:
 * server-rendered buttons are visible before their handlers are attached, and
 * a click in that gap does nothing — a race that made browser tests flaky in
 * exactly the way that gets them switched off. It carries no information and
 * changes nothing a person sees.
 */
export function HydrationMarker() {
  useEffect(() => { document.documentElement.dataset.hydrated = '1'; }, []);
  return null;
}
