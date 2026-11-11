import type { ActorContext } from '../rbac/access-control.service';

// No service imports here: monitoring, email and reports all ask these, and
// a module that imported a service would make the three import each other.

/** The MSP: a Platform Admin, or a technicians:manage holder not acting as a technician. */
export function isMspActor(a: ActorContext): boolean {
  return a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes('technicians:manage' as never));
}

/**
 * Who decides who is told: a Business Owner of that business in their own
 * right (never through a technician assignment), or the MSP. `customerId`
 * null is the global layer, the MSP's alone. Used for notification policies
 * and, from 0.34, for the email addresses and scheduled reports that mail
 * goes to (email/email.service.ts, reports/report-schedules.service.ts).
 */
export function mayManageNotifications(a: ActorContext, customerId: string | null, isOwner: boolean): boolean {
  if (isMspActor(a)) return true;
  return !!customerId && !a.technician && a.businessId === customerId && isOwner;
}

/**
 * Monitoring, as people see it: alerts, monitors (rules), maintenance
 * windows and who is notified.
 *
 *   alerts          monitoring:alerts — for computers the person can see.
 *                   Site-outage alerts need the whole business in view.
 *   monitors,       monitoring:configure inside a business (or a Business
 *   windows         Owner). Global ones: the MSP (Platform Admin or
 *                   technicians:manage, not as a technician).
 *   notification    a Business Owner for their business, or the MSP —
 *                   with fresh authentication (the controller checks).
 *                   A destination is where alert text, including computer
 *                   names, is sent, so it is not a configure-level choice.
 */
