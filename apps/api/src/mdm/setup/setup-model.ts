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

/**
 * 0.85 (M3, step 3): the connection test's outcome (0102 CHECK, in order).
 * `ok` is a token from Google and one read call; anything else names why.
 */
export const ANDROID_TEST_RESULTS = ['ok', 'bad_key', 'permission_denied', 'quota', 'unreachable', 'bad_response'] as const;
export type AndroidTestResult = (typeof ANDROID_TEST_RESULTS)[number];
export const ANDROID_TEST_REASON: Record<AndroidTestResult, string> = {
  ok: 'Google issued a token for the key and answered a read call.',
  bad_key: 'Google refused the key itself (deleted, disabled or not this account\'s): make a new key and upload it again.',
  permission_denied: 'Google refused the call: give the service account the Android Management User role (roles/androidmanagement.user) and enable the Android Management API in its project.',
  quota: 'Google answered "too many requests" (quota). Try again later.',
  unreachable: 'Google could not be reached (network, DNS or a server error). Try again.',
  bad_response: 'Google answered something Rem0te did not expect.',
};
export const isAndroidTestResult = (v: unknown): v is AndroidTestResult => typeof v === 'string' && (ANDROID_TEST_RESULTS as readonly string[]).includes(v);
/** The device quota a Platform Admin may record (0102 CHECK). */
export const ANDROID_QUOTA_MAX = 1_000_000;

/** The four capability states (docs/capabilities.md). */
export const STATES = ['available', 'requires_setup', 'unsupported', 'planned'] as const;
export type CapabilityState = (typeof STATES)[number];

/** The account that owns the push certificate, as the person typed it: an Apple Account is an e-mail address. */
export const APPLE_ACCOUNT_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;

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
  /** 0.84 (M2): the device CA's certificates, the profile signer, and what the MDM server has seen. */
  deviceCa: boolean;
  profileSigner: { notAfter: Date } | null;
  enrolledDevices: number;
  pushProven: boolean;
  /** 0.85 (M3): the connection test, the quota recorded by hand, bound enterprises, and what the sync has seen. */
  androidTest?: { result: AndroidTestResult; at: Date } | null;
  androidQuota?: number | null;
  androidEnterprises?: number;
  androidPolicies?: number;
  androidDevices?: number;
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
        : `Installed; expires in ${left} day${left === 1 ? '' : 's'}. ${f.pushProven ? 'A push was answered and the device connected afterwards.' : 'Not yet proven: only a first push answered by APNs, followed by the device connecting, proves it.'}`);
  }
  a('apple.renewal', 'Renewal reminders', f.pushCert ? 'available' : 'requires_setup',
    f.pushCert ? `Reminders at ${REMINDER_DAYS.join(', ')} days before expiry${f.appleAccount ? '' : '; record which Apple Account owns the certificate'}.` : 'Starts once a push certificate is installed.');
  const signerOk = !!f.profileSigner && f.profileSigner.notAfter.getTime() > now.getTime();
  a('apple.device_ca', 'Device identity CA (step-ca)', f.deviceCa ? 'available' : 'requires_setup',
    f.deviceCa ? 'The device CA\'s public certificates are uploaded; every device message is verified against them.' : 'Install the device CA on the server and upload its root and intermediate (step 6).');
  a('apple.profile_signer', 'Enrollment profile signing', signerOk ? 'available' : 'requires_setup',
    signerOk ? 'Enrollment profiles are signed.' : f.profileSigner ? 'The profile-signing certificate has expired: issue a new one from the device CA.' : 'Upload the profile-signing certificate the device CA issued (step 6).');
  const enrollReady = !!f.pushCert && daysLeft(f.pushCert.notAfter, now) > 0 && f.deviceCa && signerOk;
  a('apple.enrollment', 'Enrolling iPhones and iPads (iOS/iPadOS 16+)',
    enrollReady && f.enrolledDevices > 0 && f.pushProven ? 'available' : 'requires_setup',
    !enrollReady ? 'Needs the push certificate, the device CA and the profile signer (steps 5 and 6).'
      : f.enrolledDevices === 0 ? 'Ready: create a one-time enrollment link for a business and open it on a test iPhone or iPad (step 6).'
        : !f.pushProven ? `${f.enrolledDevices} enrolled; waiting for a push answered by APNs and the device connecting afterwards.`
          : `${f.enrolledDevices} enrolled; check-in, push and inventory seen.`);
  a('apple.abm', 'Apple Business Manager (automated enrollment)', 'planned', 'The ABM server token arrives in M6.');
  a('apple.ios15', 'iPhones and iPads below iOS/iPadOS 16', 'unsupported', 'Decision 24: iOS/iPadOS 16 is the minimum (device identity through ACME).');

  g('android.service_account', 'Service-account key', f.androidKey ? 'available' : 'requires_setup',
    f.androidKey ? 'The key is sealed. Whether its role is right is checked by the connection test (step 3).' : 'Upload the service-account key file (step 2).');
  const t = f.androidTest ?? null;
  g('android.connection_test', 'Connection test', f.androidKey && t?.result === 'ok' ? 'available' : 'requires_setup',
    !f.androidKey ? 'Upload the key first (step 2).' : !t ? 'Run the connection test (step 3): a token from Google and one read call.'
      : t.result === 'ok' ? 'Passed: Google issued a token and answered a read call. It does not check quota.' : ANDROID_TEST_REASON[t.result]);
  const q = f.androidQuota ?? null;
  g('android.quota', 'Device quota', q !== null && q > 0 ? 'available' : 'requires_setup',
    q === null ? 'Record the quota Google granted (step 4). Ask early: reviews are reported to take weeks.'
      : q === 0 ? 'Recorded as none granted yet. Nothing can enroll until Google grants quota.'
        : `Recorded by you: ${q} device${q === 1 ? '' : 's'}. Rem0te cannot read the quota from Google.`);
  const ents = f.androidEnterprises ?? 0, pols = f.androidPolicies ?? 0, devs = f.androidDevices ?? 0;
  g('android.enterprise', 'Enterprise sign-up per business', ents > 0 ? 'available' : 'requires_setup',
    ents > 0 ? `${ents} business${ents === 1 ? '' : 'es'} bound to an Android enterprise.` : t?.result === 'ok' ? 'Bind a business (step 5): its admin signs up at Google from a link Rem0te makes.' : 'Needs a passed connection test first (step 3).');
  g('android.enrollment', 'Enrolling Android devices', pols > 0 && devs > 0 ? 'available' : 'requires_setup',
    pols === 0 ? 'Needs a bound business with the default policy applied (steps 5 and 6).'
      : devs === 0 ? 'Ready: make a one-time enrollment token (step 6). No device has enrolled from this server yet.'
        : `${devs} enrolled, as Google reports them.`);
  return out;
}

/** A platform card's status: the first step that is not available, else available. */
export function platformState(caps: Capability[], platform: 'apple' | 'android'): { state: CapabilityState; reason: string } {
  const mine = caps.filter((c) => c.platform === platform && c.state !== 'unsupported');
  const first = mine.find((c) => c.state === 'requires_setup') ?? mine.find((c) => c.state === 'planned');
  return first ? { state: first.state, reason: first.reason } : { state: 'available', reason: 'Every step is done.' };
}
