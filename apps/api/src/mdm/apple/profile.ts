/**
 * The Apple enrollment profile (0.84 Harbor, docs/own-mdm.md M2, §93).
 * Builds the .mobileconfig for one one-time enrollment link, and signs it.
 * Only ./plist, ./protocol, ./cms and node:crypto; no database and no clock.
 *
 * Two payloads:
 *   - the device identity: an ACME payload (com.apple.security.acme), which
 *     Apple recommends: the key is made on the device (HardwareBound, in the
 *     Secure Enclave) and Apple attests the device (Attest), and Rem0te's
 *     device CA (step-ca, `rem0te-mdm-ca`, its own system user; the portal
 *     never holds its key) issues the certificate through device-attest-01;
 *   - the MDM payload (com.apple.mdm): ServerURL, CheckInURL, the push topic,
 *     the identity, ACCESS_RIGHTS, SignMessage (Caddy terminates TLS, so the
 *     device signs every message instead of presenting its certificate), and
 *     CheckOutWhenRemoved.
 *
 * ServerURL, CheckInURL and Topic can never change for an enrolled device
 * (Apple: MDM payload). CheckInURL carries the link's id (`?enroll=`) so the
 * first Authenticate can be matched to exactly one claimed link; it is not a
 * secret, and it is the only per-device part.
 *
 * TEST ONLY: the device simulator the e2e suite uses (mdmb) cannot do ACME
 * or attestation, only SCEP. Under NODE_ENV=test, and only then, a profile
 * may carry a SCEP payload pointing at the test stack's step-ca on
 * 127.0.0.1. `scepTestIdentity()` refuses to build one anywhere else. No
 * profile ever carries a private key: there is no PKCS#12 payload here.
 */
import { createHash, type KeyObject, type X509Certificate } from 'node:crypto';
import { signAttachedCms } from './cms';
import { buildPlist, type PlistDict } from './plist';
import { ACCESS_RIGHTS } from './protocol';

export const PROFILE_CONTENT_TYPE = 'application/x-apple-aspen-config';
/** The ACME key: P-384 in the Secure Enclave (Apple: HardwareBound supports P-256 and P-384). */
export const ACME_KEY = { KeyType: 'ECSECPrimeRandom', KeySize: 384 } as const;

export type Identity =
  | { kind: 'acme'; directoryUrl: string; clientIdentifier: string }
  | { kind: 'scep_test'; url: string; challenge: string };

/** A deterministic UUID (v4-shaped) from a seed, so a profile's payload UUIDs are stable for one link. */
export function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

/** The test-only SCEP identity. Refused unless NODE_ENV=test and the URL is the loopback test CA. */
export function scepTestIdentity(url: string, challenge: string): Identity {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile: a SCEP identity is for the test suites only');
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/scep\/[A-Za-z0-9._-]{1,64}$/.test(url)) throw new Error('profile: the test SCEP address must be on 127.0.0.1');
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(challenge)) throw new Error('profile: bad test challenge');
  return { kind: 'scep_test', url, challenge };
}

export interface ProfileInput {
  linkId: string;
  /** The portal's public base (its https origin), or the test API on 127.0.0.1. */
  base: string;
  topic: string;
  identity: Identity;
  organization: string;
}

export function buildProfile(p: ProfileInput): { plist: string; identifier: string } {
  const identifier = `net.rem0te.mdm.enroll.${p.linkId}`;
  const idUuid = uuidFrom(`${p.linkId}:identity`);
  const identityPayload: PlistDict = p.identity.kind === 'acme'
    ? {
      PayloadType: 'com.apple.security.acme', PayloadVersion: 1, PayloadIdentifier: `${identifier}.identity`, PayloadUUID: idUuid,
      PayloadDisplayName: 'Rem0te device identity',
      DirectoryURL: p.identity.directoryUrl, ClientIdentifier: p.identity.clientIdentifier,
      KeyType: ACME_KEY.KeyType, KeySize: ACME_KEY.KeySize, HardwareBound: true, Attest: true,
      Subject: [[['CN', 'Rem0te managed device']]], UsageFlags: 1, ExtendedKeyUsage: ['1.3.6.1.5.5.7.3.2'],
    }
    : {
      PayloadType: 'com.apple.security.scep', PayloadVersion: 1, PayloadIdentifier: `${identifier}.identity`, PayloadUUID: idUuid,
      PayloadDisplayName: 'Rem0te device identity (TEST ONLY)',
      PayloadContent: {
        URL: p.identity.url, Name: 'rem0te-mdm-test', Challenge: p.identity.challenge, Keysize: 2048, 'Key Type': 'RSA', 'Key Usage': 5,
        Subject: [[['CN', 'Rem0te managed device (test)']]],
      },
    };
  const mdm: PlistDict = {
    PayloadType: 'com.apple.mdm', PayloadVersion: 1, PayloadIdentifier: `${identifier}.mdm`, PayloadUUID: uuidFrom(`${p.linkId}:mdm`),
    PayloadDisplayName: 'Rem0te device management',
    ServerURL: `${p.base}/api/v1/mdm/apple/server`,
    CheckInURL: `${p.base}/api/v1/mdm/apple/checkin?enroll=${p.linkId}`,
    Topic: p.topic,
    IdentityCertificateUUID: idUuid,
    AccessRights: ACCESS_RIGHTS,
    SignMessage: true,
    CheckOutWhenRemoved: true,
    UseDevelopmentAPNS: false,
  };
  const root: PlistDict = {
    PayloadType: 'Configuration', PayloadVersion: 1, PayloadIdentifier: identifier, PayloadUUID: uuidFrom(`${p.linkId}:profile`),
    PayloadDisplayName: 'Rem0te device management', PayloadOrganization: p.organization.slice(0, 100),
    PayloadDescription: 'Lets your organization manage this device with Rem0te: it reads the device\'s model, storage, security settings, installed apps, profiles and certificates. Remove this profile to stop.',
    PayloadScope: 'System', PayloadRemovalDisallowed: false,
    PayloadContent: [identityPayload, mdm],
  };
  return { plist: buildPlist(root), identifier };
}

/** The signed .mobileconfig: an attached CMS SignedData over the profile's XML. */
export function signProfile(plist: string, signer: { cert: X509Certificate; key: KeyObject; chain: X509Certificate[] }, now: Date): Buffer {
  return signAttachedCms(Buffer.from(plist, 'utf8'), signer, now);
}
