'use client';

/**
 * The person's navigation state on the client (0.87): GET /me/navigation,
 * held in one TanStack query, with the preferences mirrored into
 * localStorage only so the first paint after a reload draws the sidebar the
 * way it was (collapsed, mode). The server is the record; the mirror is a
 * convenience and is overwritten by the server's answer.
 *
 * Nothing here decides access. A favourite names a record; the server
 * resolves it through that record's own visibility rule and leaves out what
 * the caller cannot open; the page itself checks again when it loads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { navigationApi, type NavItemKind, type NavPreferences, type NavPreferencesInput, type NavigationState } from './api-client';
import { usePermissions } from './auth';
import { NAV, pageLabel, type NavCtx } from '@/components/layout/nav-model';

export const NAV_KEY = ['me', 'navigation'] as const;
const MIRROR = 'nav.prefs';

const DEFAULTS: NavPreferences = { mode: 'standard', sidebarCollapsed: false, pinnedGroups: [], density: 'comfortable', workspace: 'all', contextBusiness: null };

function readMirror(): Partial<NavPreferences> {
  try {
    const v = JSON.parse(window.localStorage.getItem(MIRROR) ?? 'null');
    if (!v || typeof v !== 'object') return {};
    const groups = new Set(NAV.map((s) => s.id));
    return {
      mode: v.mode === 'advanced' ? 'advanced' : 'standard',
      sidebarCollapsed: v.sidebarCollapsed === true,
      pinnedGroups: Array.isArray(v.pinnedGroups) ? v.pinnedGroups.filter((g: unknown) => typeof g === 'string' && groups.has(g)) : [],
      density: v.density === 'compact' ? 'compact' : 'comfortable',
      workspace: ['l1', 'l2', 'l3'].includes(v.workspace) ? v.workspace : 'all',
    };
  } catch { return {}; }
}
function writeMirror(p: NavPreferences) {
  try { window.localStorage.setItem(MIRROR, JSON.stringify({ mode: p.mode, sidebarCollapsed: p.sidebarCollapsed, pinnedGroups: p.pinnedGroups, density: p.density, workspace: p.workspace })); } catch { /* storage unavailable */ }
}

export function useNavCtx(): NavCtx {
  const { can, isPlatformAdmin, isBusinessOwner, technician, assignedBusinesses, canManageTechnicians, isIndependentReviewer } = usePermissions();
  return {
    can, isPlatformAdmin, isBusinessOwner, technician: !!technician,
    hasAssignments: assignedBusinesses.length > 0, canManageTechnicians, isIndependentReviewer,
  };
}

export function useNavigation() {
  const qc = useQueryClient();
  const { user } = usePermissions();
  const [mirror, setMirror] = useState<Partial<NavPreferences>>({});
  useEffect(() => { setMirror(readMirror()); }, []);
  const q = useQuery<NavigationState>({
    queryKey: NAV_KEY,
    queryFn: () => navigationApi.get().then((r) => r.data.data),
    enabled: !!user,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => { if (q.data) writeMirror(q.data.preferences); }, [q.data]);
  const prefs: NavPreferences = q.data?.preferences ?? { ...DEFAULTS, ...mirror };

  const save = useMutation({
    mutationFn: (p: NavPreferencesInput) => navigationApi.setPreferences(p).then((r) => r.data.data),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: NAV_KEY });
      const before = qc.getQueryData<NavigationState>(NAV_KEY);
      const { contextBusinessId: _ctx, ...rest } = p;
      const next = { ...prefs, ...rest };
      setMirror(next);
      writeMirror(next);
      if (before) qc.setQueryData<NavigationState>(NAV_KEY, { ...before, preferences: { ...before.preferences, ...rest } });
      return { before };
    },
    onError: (_e, _p, c) => { if (c?.before) qc.setQueryData(NAV_KEY, c.before); },
    onSuccess: (data) => qc.setQueryData(NAV_KEY, data),
  });
  const setPrefs = useCallback((p: NavPreferencesInput) => save.mutate(p), [save]);

  const fav = useMutation({
    mutationFn: ({ kind, ref, id }: { kind: NavItemKind; ref: string; id?: string }) =>
      (id ? navigationApi.removeFavorite(id) : navigationApi.addFavorite(kind, ref)).then((r) => r.data.data),
    onSuccess: (data) => qc.setQueryData(NAV_KEY, data),
  });
  const favoriteOf = useCallback((kind: NavItemKind, ref: string) => q.data?.favorites.find((f) => f.kind === kind && f.ref === ref) ?? null, [q.data]);
  const toggleFavorite = useCallback((kind: NavItemKind, ref: string) => {
    const f = favoriteOf(kind, ref);
    fav.mutate({ kind, ref, id: f?.id });
  }, [fav, favoriteOf]);
  const removeFavorite = useCallback((id: string) => fav.mutate({ kind: 'page', ref: '/', id }), [fav]);

  return {
    ready: !!q.data, prefs, favorites: q.data?.favorites ?? [], recent: q.data?.recent ?? [], caps: q.data?.caps ?? { favorites: 50, recent: 15 },
    setPrefs, favoriteOf, toggleFavorite, removeFavorite, favError: fav.error, favPending: fav.isPending,
  };
}

const RECORD_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Static sub-pages that are not records, under the record prefixes below. */
const NOT_RECORDS = new Set(['enroll', 'new', 'full-agent', 'agent-migrations', 'remote-readiness', 'managed-sessions']);

/** What a path is, as a favourite or a recent item: a record, a menu page, or nothing. */
export function targetOf(path: string): { kind: NavItemKind; ref: string } | null {
  const m = /^\/(endpoints|businesses|automation\/scripts)\/([^/]+)$/.exec(path);
  if (m && RECORD_ID.test(m[2]) && !NOT_RECORDS.has(m[2])) {
    return { kind: m[1] === 'endpoints' ? 'device' : m[1] === 'businesses' ? 'business' : 'script', ref: m[2] };
  }
  return pageLabel(path) ? { kind: 'page', ref: path } : null;
}

/** Records each page or record opened as a recent item (once per path change). */
export function useRecordVisits() {
  const pathname = usePathname();
  const { user } = usePermissions();
  const qc = useQueryClient();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !pathname) return;
    const t = targetOf(pathname);
    if (!t) return;
    const key = `${t.kind}:${t.ref}`;
    if (last.current === key) return;
    last.current = key;
    const timer = setTimeout(() => {
      navigationApi.recordVisit(t.kind, t.ref).then(() => qc.invalidateQueries({ queryKey: NAV_KEY })).catch(() => { /* a refused visit is simply not recorded */ });
    }, 800);
    return () => clearTimeout(timer);
  }, [pathname, user, qc]);
}

/** Applies the density preference to the document (CSS in globals.css reads data-density). */
export function useApplyDensity(density: NavPreferences['density']) {
  useEffect(() => { document.documentElement.dataset.density = density; }, [density]);
}

export function useIsMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => { try { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); } catch { /* unknown platform */ } }, []);
  return mac;
}

