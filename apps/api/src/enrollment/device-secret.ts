// Timing for a device-secret candidate: the new secret a machine heartbeats
// with after its bound one stops matching. See
// EnrollmentService.recordCandidateSecret and EndpointsService.acceptDeviceSecret.

/** A candidate not seen for this long is stale — the machine stopped offering it. */
export const CANDIDATE_LIVE_MS = 15 * 60_000;

/** How long one secret must be offered alone before a conflict clears. */
export const CANDIDATE_SETTLE_MS = 60 * 60_000;
