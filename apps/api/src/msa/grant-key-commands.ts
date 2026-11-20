/**
 * The owner's commands that put the portal's grant public key into the signed
 * release metadata (0.72, Managed Secure Access §3.2). Text the console shows
 * a Platform Admin to run on the release host as root — the portal never runs
 * them, and cannot: the release user's state is unreadable to it (§56). These
 * two exported strings are the only place apps/api/src names the command
 * (§56 matches them exactly).
 */
export const MSA_GRANT_KEY_ADD_COMMAND = 'sudo rem0te-signed-grant-key add';
export const MSA_GRANT_KEY_PUBLISH_COMMAND = 'sudo rem0te-signed-publish --republish';

/** The signed target the agent reads its grant keys from, and its schema. Same strings as the Go agent and deploy/release. */
export const MSA_GRANT_KEYS_TARGET = 'msa/grant-keys.json';
export const MSA_GRANT_KEYS_SCHEMA = 'rem0te-msa-grant-keys/1';
