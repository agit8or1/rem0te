import type { MdmDriver } from '../driver';
import type { Provider } from '../model';
import { standinDriver } from './standin';

/** Every MDM connector, by provider. A new one is one file here and one line below (driver.ts). */
export const DRIVERS: Record<Provider, MdmDriver> = {
  standin: standinDriver,
};
