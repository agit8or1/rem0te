/**
 * Settings → Mobile devices (0.83 Beacon): the wizard's closed lists and
 * decisions, pure (no imports). Migration 0100's CHECKs are these lists,
 * word for word (§92 compares them).
 */

/** Owner's own ticks on the prerequisites. Informational only: never treated as verification. */
export const APPLE_CHECKLIST = ['duns', 'developer_org', 'mdm_csr_permission', 'company_apple_account'] as const;
export const ANDROID_CHECKLIST = ['google_account', 'cloud_project', 'service_account', 'quota_request', 'permitted_use'] as const;
export type AppleItem = (typeof APPLE_CHECKLIST)[number];
export type AndroidItem = (typeof ANDROID_CHECKLIST)[number];

/**
 * How the push request is signed (decision 22): the owner's own MDM vendor
 * certificate (the route for the fleet), mdmcert.download (a first test
 * device only, while Apple's permission is pending), or another vendor.
 */
export const SIGNING_ROUTES = ['own_vendor', 'mdmcert', 'other_vendor'] as const;
export type SigningRoute = (typeof SIGNING_ROUTES)[number];

/** Renewal reminders, days before the push certificate expires; 0 is "it has expired". */
export const REMINDER_DAYS = [30, 14, 3] as const;
export const REMINDER_VALUES = [30, 14, 3, 0] as const;

/** The four capability states (docs/capabilities.md). */
export const STATES = ['available', 'requires_setup', 'unsupported', 'planned'] as const;
export type CapabilityState = (typeof STATES)[number];

/** The account that owns the push certificate, as the person typed it: an Apple Account is an e-mail address. */
export const APPLE_ACCOUNT_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,6}\.[A-Za-z]{2,24}$/;

export const DAY_MS = 86_400_000;
export const daysLeft = (notAfter: Date, now: Date) => Math.ceil((notAfter.getTime() - now.getTime()) / DAY_MS);

/**
 * The reminder due now, or null. One reminder per threshold crossed, the
 * smallest one only (a certificate installed 10 days before expiry gets the
 * 14-day reminder, not 30 and 14), and never the same one twice: `sent` is
 * the smallest threshold already reminded for this certificate.
 */
export function dueReminder(notAfter: Date, sent: number | null, now: Date): number | null {
  const left = daysLeft(notAfter, now);
  const due = left <= 0 ? 0 : [...REMINDER_DAYS].filter((t) => left <= t).sort((a, b) => a - b)[0];
  if (due === undefined) return null;
  if (sent !== null && sent <= due) return null;
  return due;
}

/**
 * Whether an uploaded push certificate may take the place of what is there.
 * The topic is in every enrolled device's profile and cannot change (Apple:
 * the MDM payload's Topic must not change), so a different topic is refused
 * on the ordinary upload and allowed only by the replace action, which
 * names the topic it replaces.
 */
export type TopicDecision = { ok: true; op: 'install' | 'renew' | 'replace' } | { ok: false; code: 'APNS_TOPIC_CHANGED' | 'APNS_TOPIC_SAME' | 'APNS_REPLACE_STALE' | 'APNS_NOTHING_TO_REPLACE' };
export function topicDecision(current: string | null, incoming: string, replace: { currentTopic: string } | null): TopicDecision {
  if (!replace) {
    if (!current) return { ok: true, op: 'install' };
    return current === incoming ? { ok: true, op: 'renew' } : { ok: false, code: 'APNS_TOPIC_CHANGED' };
  }
  if (!current) return { ok: false, code: 'APNS_NOTHING_TO_REPLACE' };
  if (replace.currentTopic !== current) return { ok: false, code: 'APNS_REPLACE_STALE' };
  if (incoming === current) return { ok: false, code: 'APNS_TOPIC_SAME' };
  return { ok: true, op: 'replace' };
}

export interface SetupFacts {
  pushKey: boolean;
  vendor: { notAfter: Date } | null;
  signingRoute: SigningRoute | null;
  pushCert: { notAfter: Date } | null;
  appleAccount: string | null;
  androidKey: boolean;
}
export interface Capability { key: string; platform: 'apple' | 'android'; label: string; state: CapabilityState; reason: string }

/**
 * Every wizard capability in one of the four states. "Available" here means
 * the step is done and checked offline; nothing in M1 is proven against
 * Apple or Google (only a real device or a call can prove that), and the
 * steps that would are planned.
 */
export function capabilities(f: SetupFacts, now: Date): Capability[] {
  const out: Capability[] = [];
  const a = (key: string, label: string, state: CapabilityState, reason: string) => out.push({ key, platform: 'apple', label, state, reason });
  const g = (key: string, label: string, state: CapabilityState, reason: string) => out.push({ key, platform: 'android', label, state, reason });

  a('apple.push_request', 'Push certificate request (CSR)', f.pushKey ? 'available' : 'requires_setup',
    f.pushKey ? 'The push key is sealed in Rem0te and the CSR is ready to download.' : 'Generate the push request (step 2).');
  if (f.signingRoute === 'own_vendor' || f.signingRoute === null) {
    const vExpired = !!f.vendor && f.vendor.notAfter.getTime() <= now.getTime();
    a('apple.vendor_signing', 'Signing with your MDM vendor certificate', f.vendor && !vExpired ? 'available' : 'requires_setup',
      !f.vendor ? 'Upload your MDM vendor certificate, its key and the chain (step 3).' : vExpired ? 'The vendor certificate has expired: make a new one in your developer account.' : 'The vendor certificate is sealed; Rem0te can produce the signed request.');
  } else {
    a('apple.vendor_signing', 'Signing the request', f.pushCert ? 'available' : 'requires_setup',
      f.signingRoute === 'mdmcert' ? 'Signed outside Rem0te by the community signing service (mdmcert): for a first test device only, never the fleet.' : 'Signed outside Rem0te by another vendor.');
  }
  if (!f.pushCert) a('apple.push_certificate', 'APNs push certificate', 'requires_setup', 'Upload the push certificate from the Apple push certificates portal (step 5).');
  else {
    const left = daysLeft(f.pushCert.notAfter, now);
    a('apple.push_certificate', 'APNs push certificate', left <= 0 ? 'requires_setup' : 'available',
      left <= 0 ? 'The push certificate has expired: renew it with the same Apple Account.'
        : `Installed; expires in ${left} day${left === 1 ? '' : 's'}. Not yet proven: only a first push to a real device proves APNs accepts it (M2).`);
  }
  a('apple.renewal', 'Renewal reminders', f.pushCert ? 'available' : 'requires_setup',
    f.pushCert ? `Reminders at ${REMINDER_DAYS.join(', ')} days before expiry${f.appleAccount ? '' : '; record which Apple Account owns the certificate'}.` : 'Starts once a push certificate is installed.');
  a('apple.enrollment', 'Enrolling iPhones and iPads (iOS/iPadOS 16+)', 'planned', 'Enrollment links, check-in and inventory arrive in M2.');
  a('apple.abm', 'Apple Business Manager (automated enrollment)', 'planned', 'The ABM server token arrives in M6.');
  a('apple.ios15', 'iPhones and iPads below iOS/iPadOS 16', 'unsupported', 'Decision 24: iOS/iPadOS 16 is the minimum (device identity through ACME).');

  g('android.service_account', 'Service-account key', f.androidKey ? 'available' : 'requires_setup',
    f.androidKey ? 'The key is sealed. Whether its role and quota are right is checked by the connection test (M3).' : 'Upload the service-account key file (step 2).');
  g('android.connection_test', 'Connection test', 'planned', 'Calling Google arrives in M3; this release makes no call.');
  g('android.enterprise', 'Enterprise sign-up per business', 'planned', 'Arrives in M3.');
  g('android.quota', 'Device quota', 'planned', 'Request it from Google early (weeks reported); recording it arrives in M3.');
  g('android.enrollment', 'Enrolling Android devices', 'planned', 'Arrives in M3.');
  return out;
}

/** A platform card's status: the first step that is not available, else available. */
export function platformState(caps: Capability[], platform: 'apple' | 'android'): { state: CapabilityState; reason: string } {
  const mine = caps.filter((c) => c.platform === platform && c.state !== 'unsupported');
  const first = mine.find((c) => c.state === 'requires_setup') ?? mine.find((c) => c.state === 'planned');
  return first ? { state: first.state, reason: first.reason } : { state: 'available', reason: 'Every step is done.' };
}
