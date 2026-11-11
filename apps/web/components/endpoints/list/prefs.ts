import { EMPTY_FILTERS, type Density, type DeviceFilters, type SortKey } from './types';

/**
 * Per-viewer preferences for the device list, kept in this browser's
 * localStorage: visible columns, density and named saved views.
 *
 * Every read and write is wrapped: storage can be missing, blocked, full or
 * throw (private windows, cleared site data). The list works without it —
 * it just forgets between visits. Nothing here is security-relevant: a saved
 * view is a set of query parameters, and the server scopes every one.
 */

const PREFS_KEY = 'rem0te.devices.prefs.v1';
const VIEWS_KEY = 'rem0te.devices.views.v1';

export interface Prefs { columns: string[] | null; density: Density }
export interface SavedView {
  name: string;
  filters: DeviceFilters;
  columns: string[];
  sort: SortKey;
  dir: 'asc' | 'desc';
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadPrefs(): Prefs {
  const p = read<Partial<Prefs>>(PREFS_KEY);
  return {
    columns: Array.isArray(p?.columns) ? p!.columns.filter((c): c is string => typeof c === 'string') : null,
    density: p?.density === 'compact' ? 'compact' : 'comfortable',
  };
}
export const savePrefs = (p: Prefs) => write(PREFS_KEY, p);

export function loadViews(): SavedView[] {
  const v = read<SavedView[]>(VIEWS_KEY);
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x.name === 'string' && x.filters && Array.isArray(x.columns))
    .map((x) => ({ ...x, filters: { ...EMPTY_FILTERS, ...x.filters } }))
    .slice(0, 50);
}
export const saveViews = (v: SavedView[]) => write(VIEWS_KEY, v);
