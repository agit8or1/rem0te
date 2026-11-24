import type { AppleReader } from '../apple/apple-mdm.service';
import type { MdmDriver } from '../driver';
import type { Provider } from '../model';
import { appleDriver } from './apple';
import { standinDriver } from './standin';

/**
 * Every MDM connector, by provider. A new one is one file here and one line
 * below (driver.ts). 0.84: a factory, because the `apple` driver reads
 * Rem0te's own Apple tables through the reader the sync hands it.
 */
export function makeDrivers(deps: { apple: AppleReader }): Record<Provider, MdmDriver> {
  return {
    standin: standinDriver,
    apple: appleDriver(deps.apple),
  };
}

/** Readiness only (the console's connector view): no driver here is ever asked to list. */
const NO_READER: AppleReader = {
  devices: () => Promise.reject(new Error('readiness only')),
  commands: () => Promise.reject(new Error('readiness only')),
};
export const READINESS: Record<Provider, Pick<MdmDriver, 'ready' | 'label'>> = makeDrivers({ apple: NO_READER });
