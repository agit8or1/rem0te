import type { AppleReader } from '../apple/apple-mdm.service';
import type { MdmDriver } from '../driver';
import type { Provider } from '../model';
import { androidDriver, type AndroidReader } from './android';
import { appleDriver } from './apple';
import { standinDriver } from './standin';

/**
 * Every MDM connector, by provider. A new one is one file here and one line
 * below (driver.ts). 0.84: a factory, because the `apple` driver reads
 * Rem0te's own Apple tables through the reader the sync hands it. 0.85: the
 * `android` driver (drivers/android/) reads Google's Android Management API,
 * with the sealed key and the connector's device ids from its reader.
 * 0.86: every driver also has send() (lost-device commands only, §95); the
 * readers below carry the Apple queue's one entry and Android's open
 * commands. Only MdmActionService calls send().
 */
export function makeDrivers(deps: { apple: AppleReader; android: AndroidReader }): Record<Provider, MdmDriver> {
  return {
    standin: standinDriver,
    apple: appleDriver(deps.apple),
    android: androidDriver(deps.android),
  };
}

/** Readiness only (the console's connector view): no driver here is ever asked to list. */
const NO_READER: AppleReader = {
  devices: () => Promise.reject(new Error('readiness only')),
  commands: () => Promise.reject(new Error('readiness only')),
  queueLostDevice: () => Promise.reject(new Error('readiness only')),
};
const NO_ANDROID: AndroidReader = {
  credential: () => Promise.reject(new Error('readiness only')),
  openCommands: () => Promise.reject(new Error('readiness only')),
};
export const READINESS: Record<Provider, Pick<MdmDriver, 'ready' | 'label'>> = makeDrivers({ apple: NO_READER, android: NO_ANDROID });
