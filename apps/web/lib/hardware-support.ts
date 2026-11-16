/**
 * Hardware support links and warranty state (0.56): which vendor made a
 * computer, the vendor's own support, warranty and driver pages for it, and
 * how close its warranty is to ending.
 *
 * THIS FILE HAS AN IDENTICAL COPY at apps/web/lib/hardware-support.ts. The
 * API builds the links it returns and the device list builds the same links
 * in the browser; §69 of scripts/check-security-invariants.mjs fails if the
 * two files differ by a byte. Edit one, copy it over the other.
 *
 * Plain data and pure functions: no imports, nothing read from anywhere.
 *
 * What a link may carry:
 *   - only a vendor host from VENDOR_HOSTS, always https;
 *   - the serial only where the vendor has a stable page that takes it in its
 *     path (Dell's service-tag pages), only after the vendor's own charset
 *     check, and always through encodeURIComponent;
 *   - every other vendor gets its fixed lookup page, and the console offers to
 *     copy the serial: Lenovo, HP, HPE, Apple, ASUS and Acer publish no link
 *     that fills it in (Apple and HPE also ask for a CAPTCHA or a sign-in).
 * The console opens each one in a new tab with rel="noopener noreferrer".
 *
 * A virtual machine has no hardware warranty: VMware, Hyper-V ("Microsoft
 * Corporation" / "Virtual Machine"), QEMU/KVM, VirtualBox, Xen, Parallels and
 * the public clouds' instances say so instead of linking anywhere.
 */

export const VENDOR_KEYS = ['dell', 'lenovo', 'hp', 'hpe', 'microsoft', 'apple', 'asus', 'acer'] as const;
export type VendorKey = (typeof VENDOR_KEYS)[number];

export const VENDOR_LABEL: Record<VendorKey, string> = {
  dell: 'Dell', lenovo: 'Lenovo', hp: 'HP', hpe: 'HPE', microsoft: 'Microsoft Surface', apple: 'Apple', asus: 'ASUS', acer: 'Acer',
};

/** Every host a support link may point at. */
export const VENDOR_HOSTS = [
  'www.dell.com', 'pcsupport.lenovo.com', 'support.hp.com', 'support.hpe.com', 'support.microsoft.com',
  'mybusinessservice.surface.com', 'checkcoverage.apple.com', 'support.apple.com', 'www.asus.com', 'www.acer.com',
] as const;

/** A serial as it may appear anywhere: letters, digits and hyphen, 4–40 characters. */
export const SERIAL_RE = /^[A-Za-z0-9-]{4,40}$/;
/** A Dell service tag: seven letters and digits. The only serial a link carries. */
export const DELL_TAG_RE = /^[A-Za-z0-9]{7}$/;

/** What firmware reports when nobody set a serial. Never a lookup, never a link. */
const PLACEHOLDER = /^(to be filled|default|system serial|serial ?number|none$|n\/?a$|not applicable|not specified|1234567(89)?$|chassis serial|invalid|oem)/i;

/** A serial worth using, upper-cased and trimmed — or null. */
export function cleanSerial(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || PLACEHOLDER.test(s) || !SERIAL_RE.test(s)) return null;
  if (/^(.)\1+$/.test(s)) return null; // all one character
  return s.toUpperCase();
}

export type Platform = 'VMware' | 'Hyper-V' | 'QEMU/KVM' | 'VirtualBox' | 'Xen' | 'Parallels' | 'Amazon EC2' | 'Google Compute Engine' | 'Azure';

export type Maker =
  | { kind: 'vendor'; vendor: VendorKey }
  | { kind: 'virtual'; platform: Platform }
  | { kind: 'unknown' };

const norm = (v: string | null | undefined) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '');

/**
 * Who made it, from the firmware's manufacturer and model strings ("Dell
 * Inc.", "LENOVO", "HP", "Hewlett-Packard", "ASUSTeK COMPUTER INC.", …).
 * A virtual platform is recognised first: Hyper-V reports Microsoft as its
 * manufacturer, and a VM is never a Surface.
 */
export function identifyMaker(manufacturer: string | null | undefined, model?: string | null): Maker {
  const m = norm(manufacturer), mo = norm(model);
  if (/vmware/.test(m) || /^vmware/.test(mo)) return { kind: 'virtual', platform: 'VMware' };
  if (/^microsoft/.test(m) && /virtual machine/.test(mo)) return { kind: 'virtual', platform: 'Hyper-V' };
  if (/^(qemu|red hat|nutanix|proxmox)/.test(m) || /^(kvm|standard pc \()/.test(mo)) return { kind: 'virtual', platform: 'QEMU/KVM' };
  if (/innotek|virtualbox|oracle corporation/.test(m) || /virtualbox/.test(mo)) return { kind: 'virtual', platform: 'VirtualBox' };
  if (/^xen/.test(m) || /^hvm domu/.test(mo)) return { kind: 'virtual', platform: 'Xen' };
  if (/^parallels/.test(m)) return { kind: 'virtual', platform: 'Parallels' };
  if (/^amazon ec2/.test(m)) return { kind: 'virtual', platform: 'Amazon EC2' };
  if (/^google/.test(m) && /compute engine/.test(mo)) return { kind: 'virtual', platform: 'Google Compute Engine' };
  if (/^dell/.test(m)) return { kind: 'vendor', vendor: 'dell' };
  if (/^lenovo/.test(m)) return { kind: 'vendor', vendor: 'lenovo' };
  if (/^(hpe|hewlett packard enterprise)/.test(m)) return { kind: 'vendor', vendor: 'hpe' };
  if (/^(hp|hewlett[- ]?packard)\b/.test(m)) {
    // Servers sold by Hewlett-Packard before the split, and HPE's still-"HP" firmware, are HPE's to support.
    return /proliant|synergy|apollo|superdome|moonshot/.test(mo) ? { kind: 'vendor', vendor: 'hpe' } : { kind: 'vendor', vendor: 'hp' };
  }
  if (/^microsoft/.test(m)) return { kind: 'vendor', vendor: 'microsoft' };
  if (/^apple/.test(m)) return { kind: 'vendor', vendor: 'apple' };
  if (/^asus/.test(m)) return { kind: 'vendor', vendor: 'asus' };
  if (/^acer/.test(m)) return { kind: 'vendor', vendor: 'acer' };
  return { kind: 'unknown' };
}

export type LinkKind = 'warranty' | 'support' | 'drivers';
export interface SupportLink { kind: LinkKind; label: string; url: string; serialInUrl: boolean }
export interface SupportInfo {
  maker: Maker;
  vendorLabel: string | null;
  /** The serial as it may be shown and copied, or null when it is missing or a placeholder. */
  serial: string | null;
  links: SupportLink[];
  /** One line the console shows under the links. */
  note: string | null;
}

type Fixed = { warranty: string; support?: string; drivers?: string };
const FIXED: Record<Exclude<VendorKey, 'dell'>, Fixed> = {
  lenovo: { warranty: 'https://pcsupport.lenovo.com/us/en/warrantylookup', support: 'https://pcsupport.lenovo.com/us/en/' },
  hp: { warranty: 'https://support.hp.com/us-en/check-warranty', drivers: 'https://support.hp.com/us-en/drivers' },
  hpe: { warranty: 'https://support.hpe.com/connect/s/warrantycheck', support: 'https://support.hpe.com/connect/s/' },
  microsoft: {
    warranty: 'https://mybusinessservice.surface.com/',
    support: 'https://support.microsoft.com/en-us/surface',
    drivers: 'https://support.microsoft.com/en-us/surface/download-drivers-and-firmware-for-surface-09bb2e09-2a4b-cb69-0951-078a7739e120',
  },
  apple: { warranty: 'https://checkcoverage.apple.com/', support: 'https://support.apple.com/' },
  asus: { warranty: 'https://www.asus.com/support/warranty-status-inquiry/', drivers: 'https://www.asus.com/support/download-center/' },
  acer: { warranty: 'https://www.acer.com/us-en/support/warranty/warranty-review', drivers: 'https://www.acer.com/us-en/support/drivers-and-manuals' },
};

const DELL_BASE = 'https://www.dell.com/support/home/en-us';

/** The support, warranty and driver pages for a computer, from what its firmware reported. */
export function supportInfo(manufacturer: string | null | undefined, model: string | null | undefined, rawSerial: string | null | undefined): SupportInfo {
  const maker = identifyMaker(manufacturer, model);
  const serial = cleanSerial(rawSerial);
  if (maker.kind === 'virtual') {
    return { maker, vendorLabel: null, serial, links: [], note: `Virtual machine (${maker.platform}) — no hardware warranty.` };
  }
  if (maker.kind === 'unknown') return { maker, vendorLabel: null, serial, links: [], note: null };
  const vendorLabel = VENDOR_LABEL[maker.vendor];
  if (maker.vendor === 'dell') {
    if (serial && DELL_TAG_RE.test(serial)) {
      const tag = encodeURIComponent(serial);
      return {
        maker, vendorLabel, serial,
        links: [
          { kind: 'warranty', label: 'Warranty and support', url: `${DELL_BASE}/product-support/servicetag/${tag}/overview`, serialInUrl: true },
          { kind: 'drivers', label: 'Drivers and downloads', url: `${DELL_BASE}/product-support/servicetag/${tag}/drivers`, serialInUrl: true },
        ],
        note: null,
      };
    }
    return {
      maker, vendorLabel, serial,
      links: [{ kind: 'support', label: 'Dell support', url: `${DELL_BASE}/`, serialInUrl: false }],
      note: 'No usable service tag reported: enter it on the page.',
    };
  }
  const f = FIXED[maker.vendor];
  const links: SupportLink[] = [{ kind: 'warranty', label: 'Warranty check', url: f.warranty, serialInUrl: false }];
  if (f.support) links.push({ kind: 'support', label: 'Support', url: f.support, serialInUrl: false });
  if (f.drivers) links.push({ kind: 'drivers', label: 'Drivers and downloads', url: f.drivers, serialInUrl: false });
  const note = serial
    ? `${vendorLabel} has no link that fills in the serial: copy it and paste it on the page.`
    : 'No usable serial reported: find it on the label or in the firmware setup.';
  return { maker, vendorLabel, serial, links, note };
}

// ── Warranty state ──────────────────────────────────────────────────────────

export const WARRANTY_STATES = ['expired', 'expiring_30', 'expiring_60', 'expiring_90', 'active', 'unknown'] as const;
export type WarrantyState = (typeof WARRANTY_STATES)[number];
export const WARRANTY_STATE_LABEL: Record<WarrantyState, string> = {
  expired: 'Expired', expiring_30: 'Ends within 30 days', expiring_60: 'Ends within 60 days', expiring_90: 'Ends within 90 days', active: 'Active', unknown: 'Unknown',
};
const DAY_MS = 86_400_000;
/** Where a computer's stored warranty dates came from. */
export const WARRANTY_SOURCE_LABEL: Record<string, string> = { manual: 'Entered by hand', dell: 'Dell TechDirect', lenovo: 'Lenovo warranty API' };

/** Whole days from `now` until `endsAt` (negative once it has passed), or null. */
export function daysLeft(endsAt: Date | string | null | undefined, now: Date | number = Date.now()): number | null {
  if (!endsAt) return null;
  const t = new Date(endsAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - new Date(now).getTime()) / DAY_MS);
}

/** Which bucket a warranty end date falls in. A date that has passed is expired; no date is unknown. */
export function warrantyState(endsAt: Date | string | null | undefined, now: Date | number = Date.now()): WarrantyState {
  if (!endsAt) return 'unknown';
  const t = new Date(endsAt).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const ms = t - new Date(now).getTime();
  if (ms < 0) return 'expired';
  if (ms < 30 * DAY_MS) return 'expiring_30';
  if (ms < 60 * DAY_MS) return 'expiring_60';
  if (ms < 90 * DAY_MS) return 'expiring_90';
  return 'active';
}

/** Coverage text: an inert charset (Latin letters, digits, a little punctuation), 200 characters at most. */
export const COVERAGE_RE = /^[A-Za-z0-9\u00C0-\u024F .,:;()/&+'#-]{0,200}$/;
export const COVERAGE_MAX = 200;

/** Vendor text reduced to the coverage charset: anything else becomes a space, runs collapse, capped. */
export function cleanCoverage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[^A-Za-z0-9\u00C0-\u024F .,:;()/&+'#-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, COVERAGE_MAX).trim();
  return s || null;
}
