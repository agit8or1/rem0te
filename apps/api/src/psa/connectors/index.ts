import type { Kind, PsaDriver } from '../connector';
import { clientst0rDriver } from './clientst0r';
import { emailDriver } from './email';
import { webhookDriver } from './webhook';

/** Every connector, by kind. A new one is one file here and one line below. */
export const DRIVERS: Record<Kind, PsaDriver> = {
  email: emailDriver,
  webhook: webhookDriver,
  clientst0r: clientst0rDriver,
};
