import type { ConnectionKind } from '../model';
import type { BackupDriver } from '../driver';
import { standinDriver } from './standin';

/**
 * Every pull driver, by kind. St0r pushes and has none; Comet is planned
 * (4.4). A new one is one file here and one line below.
 */
export const DRIVERS: Partial<Record<ConnectionKind, BackupDriver>> = {
  standin: standinDriver,
};
