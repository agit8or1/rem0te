import type { AgentVersionView } from '@/lib/agent-version';
import axios from 'axios';
import type { PolicyWindowInput } from './patching';

// Always use a relative path so browser requests go to the same origin,
// avoiding CORS issues regardless of the port the user accesses the UI on.
// The Next.js rewrite (next.config.js) proxies /api/* to the backend.
const BASE_URL = '/api/v1';

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Redirect to login on 401
api.interceptors.response.use(
  (res) => res,
  (error) => {
    // Not on the sign-in pages themselves: a wrong password there is a 401,
    // and redirecting would wipe the message and set returnTo=/login.
    if (typeof window !== 'undefined' && error?.response?.status === 401
      && !['/login', '/mfa'].includes(window.location.pathname)) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?returnTo=${returnTo}`;
    }
    return Promise.reject(error);
  },
);

// ─── Auth ────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  verifyMfa: (code: string) => api.post('/auth/mfa/verify', { code }),
  profile: () => api.get('/auth/profile'),
  updateProfile: (data: {
    firstName?: string; lastName?: string; email?: string;
    phone?: string; jobTitle?: string;
    address?: string; city?: string; state?: string; country?: string; postalCode?: string;
    timeZone?: string; currentPassword?: string;
  }) => api.patch('/auth/profile', data),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
};

// ─── MFA ─────────────────────────────────────────────────────────────────────
export const mfaApi = {
  status: () => api.get('/mfa/status'),
  beginEnroll: () => api.post('/mfa/totp/setup'),
  confirmEnroll: (code: string) => api.post('/mfa/totp/confirm', { code }),
  verifyRecovery: (code: string) => api.post('/mfa/recovery/verify', { code }),
  disable: (code: string) => api.delete('/mfa/totp', { data: { code } }),
};

// ─── Dashboard ───────────────────────────────────────────────────────────────
export const dashboardApi = {
  // Approximate client locations for the dashboard map. Returns null data
  // when the caller lacks computers:view.
  map: (businessId?: string) =>
    api.get('/dashboard/map', { params: businessId ? { businessId } : {} }),
  stats: () => api.get('/dashboard'),
  platformStats: () => api.get('/dashboard/platform'),
};

// ─── Approved actions (v0.26) ───────────────────────────────────────────────
// Request, read, cancel, reconcile. There is no approve call: approval happens
// on the approval signer's own origin, with a passkey on its roster — or, in
// direct mode (0.40, the signer operator's setting), not at all.
export const actionsApi = {
  catalog: (endpointId?: string, businessId?: string) => api.get('/actions/catalog', { params: endpointId ? { endpointId } : businessId ? { businessId } : {} }),
  list: (endpointId: string) => api.get(`/endpoints/${endpointId}/actions`),
  request: (endpointId: string, body: { actionId: string; version: number; params: Record<string, unknown>; reason: string; windowHours?: number; restartAt?: { local: string; timeZone: string } }) =>
    api.post(`/endpoints/${endpointId}/actions`, body),
  get: (id: string) => api.get(`/actions/${id}`),
  cancel: (id: string) => api.post(`/actions/${id}/cancel`),
  reconcile: (id: string, body: { found: 'running' | 'stopped' | 'installed' | 'not_installed' | 'restart_scheduled' | 'no_restart_scheduled' | 'other'; note: string; endpointId?: string }) =>
    api.post(`/actions/${id}/reconcile`, body),
};

// ─── Staged patching (v0.27) ─────────────────────────────────────────────────
// Requests and views only. Each ring is a signed plan approved on the approval
// signer like any other action; nothing here can approve one.
export interface UpdateIdentity { updateId: string; revision: number }
export const patchingApi = {
  endpoint: (endpointId: string) => api.get(`/endpoints/${endpointId}/patches`),
  candidates: (businessId: string) => api.get('/patching/candidates', { params: { businessId } }),
  list: (businessId: string) => api.get('/patching/deployments', { params: { businessId } }),
  get: (id: string) => api.get(`/patching/deployments/${id}`),
  create: (body: { businessId: string; name: string; updates: UpdateIdentity[]; rings: string[][]; soakHours: number; failureThreshold: number; windowHours: number; reboot?: 'never' | 'if_required_in_window'; staging?: PatchStaging }) =>
    api.post('/patching/deployments', body),
  requestRing: (id: string, ring: number, body: { reason: string; startsInMinutes?: number; exclude?: { endpointId: string; why: string }[]; schedule?: ScheduleInput }) =>
    api.post(`/patching/deployments/${id}/rings/${ring}/request`, body),
  pause: (id: string, reason: string) => api.post(`/patching/deployments/${id}/pause`, { reason }),
  resume: (id: string, reason: string) => api.post(`/patching/deployments/${id}/resume`, { reason }),
  cancel: (id: string, reason: string) => api.post(`/patching/deployments/${id}/cancel`, { reason }),
  // 0.32. "Install updates" builds a one-computer deployment; its canary
  // still needs two approvals on the approval signer.
  // 0.52: `schedule` installs at a wall-clock time in a named zone instead of now.
  install: (endpointId: string, body: { updates: UpdateIdentity[]; reboot: 'never' | 'if_required_in_window'; reason: string; windowHours: number; schedule?: ScheduleInput }) =>
    api.post(`/endpoints/${endpointId}/patches/install`, body),
  preflight: () => api.get('/patching/preflight'),
  policies: (businessId: string) => api.get('/patching/policies', { params: { businessId } }),
  policy: (id: string) => api.get(`/patching/policies/${id}`),
  // Creating and revoking need a fresh sign-in (the interceptor prompts).
  createPolicy: (body: PatchPolicyInput) => api.post('/patching/policies', body),
  revokePolicy: (id: string, reason: string) => api.post(`/patching/policies/${id}/revoke`, { reason }),
  // 0.50: company-wide and assignable policies, and each computer's Patch
  // policy setting. Each revision is still a signed closed list; the portal
  // proposes revisions itself. Writes need a fresh sign-in (the interceptor prompts).
  endpointPolicy: (endpointId: string) => api.get(`/endpoints/${endpointId}/patch-policy`),
  setEndpointPolicy: (endpointId: string, body: PatchPolicySettingInput) => api.put(`/endpoints/${endpointId}/patch-policy`, body),
  series: (businessId: string) => api.get('/patching/series', { params: { businessId } }),
  createSeries: (body: PatchSeriesInput) => api.post('/patching/series', body),
  retireSeries: (id: string, reason: string) => api.post(`/patching/series/${id}/retire`, { reason }),
  // 0.53: a window's description and next openings, computed by the functions the approval signer runs.
  windowPreview: (window: PolicyWindowInput) => api.post('/patching/window-preview', { window }),
};

export type PatchPolicySettingInput = { mode: 'inherit' } | { mode: 'exclude' } | { mode: 'policy'; seriesId: string };
export interface PatchSeriesInput {
  businessId: string; scope: 'business' | 'assigned'; name: string;
  allow: { classifications: string[]; severities?: string[]; excludeKbs?: string[] };
  soakHours: number; failureThreshold: number;
  window: PolicyWindowInput;
  /** 0.63: no expiry: every revision stands until a newer one replaces it or the policy is retired. */
  reboot: 'never' | 'if_required_in_window'; reason: string; canaryEndpointId?: string;
  /** 0.62: 'none' (all at once) or 'canary' (Test on one computer first). The API reads absent as canary. */
  staging?: PatchStaging;
}
/** 0.62: how a patch policy or deployment rolls out. */
export type PatchStaging = 'none' | 'canary';

// 0.34 software deployment (docs/software-deployment.md). The catalog is
// allowlisted winget packages pinned to one version and installer SHA-256.
// Changing it needs a fresh sign-in (the interceptor prompts). There is no
// approve route: each ring's plan is approved on the approval signer.
export type SoftwareDetection =
  | { kind: 'display_name'; name: string; match: 'exact' | 'prefix'; compare: 'gte' | 'eq'; version: string }
  | { kind: 'uninstall_key'; key: string; compare: 'gte' | 'eq'; version: string }
  | { kind: 'file_version'; base: 'ProgramFiles' | 'ProgramFilesX86'; file: string; compare: 'gte' | 'eq'; version: string };
export type SoftwareHash =
  | { source: 'winget_pkgs'; architecture: 'x64' | 'x86' | 'arm64' | 'neutral'; installerSha256?: string }
  | { source: 'admin_pasted'; installerSha256: string };
export interface SoftwareEntryInput { name: string; publisher?: string; version: string; hash: SoftwareHash; detection: SoftwareDetection; notes?: string }
export const softwareApi = {
  list: (businessId?: string | null, archived?: boolean) =>
    api.get('/software/catalog', { params: { ...(businessId ? { businessId } : {}), ...(archived ? { archived: '1' } : {}) } }),
  get: (id: string) => api.get(`/software/catalog/${id}`),
  create: (body: SoftwareEntryInput & { scope: 'global' | 'business'; businessId?: string; packageId: string }) => api.post('/software/catalog', body),
  update: (id: string, body: SoftwareEntryInput & { expectedRevision: number }) => api.post(`/software/catalog/${id}`, body),
  archive: (id: string, body: { reason: string; expectedRevision: number }) => api.post(`/software/catalog/${id}/archive`, body),
  manifestPreview: (body: { packageId: string; version: string }) => api.post('/software/manifest-preview', body),
  deployments: (businessId?: string | null) => api.get('/software/deployments', bq(businessId)),
  deployment: (id: string) => api.get(`/software/deployments/${id}`),
  createDeployment: (body: { entryId: string; operation: 'install' | 'uninstall'; name?: string; rings: string[][]; soakHours: number; failureThreshold: number; windowHours: number }) =>
    api.post('/software/deployments', body),
  requestRing: (id: string, ring: number, body: { reason: string; startsInMinutes?: number; schedule?: { local: string; timeZone: string }; exclude?: { endpointId: string; why: string }[] }) =>
    api.post(`/software/deployments/${id}/rings/${ring}/request`, body),
  pause: (id: string, reason: string) => api.post(`/software/deployments/${id}/pause`, { reason }),
  resume: (id: string, reason: string) => api.post(`/software/deployments/${id}/resume`, { reason }),
  cancel: (id: string, reason: string) => api.post(`/software/deployments/${id}/cancel`, { reason }),
  endpoint: (endpointId: string) => api.get(`/endpoints/${endpointId}/software/catalog`),
  // One computer: a one-ring deployment; the returned job carries the approval link.
  single: (endpointId: string, entryId: string, operation: 'install' | 'uninstall', body: { reason: string; windowHours: number; startsInMinutes?: number; schedule?: { local: string; timeZone: string } }) =>
    api.post(`/endpoints/${endpointId}/software/${entryId}/${operation}`, body),
  // 0.41: the searchable winget catalog, one-click install, removing an installed program.
  wingetSearch: (q: string) => api.get('/software/winget/packages', { params: { q } }),
  wingetRefresh: () => api.post('/software/winget/refresh', {}),
  wingetAdd: (body: { scope: 'global' | 'business'; businessId?: string; packageId: string; version?: string; architecture?: 'x64' | 'x86' | 'arm64' }) => api.post('/software/winget/catalog', body),
  // 0.43: one page of the whole index, marked with the catalogs holding each package; and adding up to 25 at once.
  wingetBrowse: (params: { q?: string; page: number; pageSize?: number; sort?: 'relevance' | 'name' | '-name'; publisher?: string; letter?: string; businessId?: string }) =>
    api.get('/software/winget/packages', { params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) }),
  wingetAddMany: (body: { scope: 'global' | 'business'; businessId?: string; packages: { packageId: string; version?: string }[]; architecture?: 'x64' | 'x86' | 'arm64' }) =>
    api.post('/software/winget/catalog/bulk', body),
  quickInstall: (endpointId: string, body: { packageId: string; version?: string; reason?: string; windowHours?: number }) =>
    api.post(`/endpoints/${endpointId}/software/winget-install`, body),
  removeProgram: (endpointId: string, body: { key: string; view: '64' | '32'; displayName: string; reason?: string; windowHours?: number }) =>
    api.post(`/endpoints/${endpointId}/software/remove-program`, body),
  // The report (report-kit's useReport/ExportButton call the same two routes).
  compliance: (params: Record<string, string>) => api.get('/reports/software-compliance', { params }),
  complianceCsv: (params: Record<string, string>) => api.get('/reports/software-compliance/export.csv', { params, responseType: 'blob' }),
};

export interface PatchPolicyInput {
  businessId: string; name: string; rings: string[][];
  allow: { classifications: string[]; severities?: string[]; excludeKbs?: string[] };
  soakHours: number; failureThreshold: number;
  window: PolicyWindowInput;
  /** 0.63: the console sends no expiry, so the policy never expires (the API still takes an optional expiresInDays). */
  reboot: 'never' | 'if_required_in_window'; reason: string;
  /** 0.62: 'none' (all at once) or 'canary' (Test on one computer first). The API reads absent as canary. */
  staging?: PatchStaging;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
export const endpointsApi = {
  /**
   * One-click connect, as a downloadable script.
   *
   * Not an axios call: the browser must navigate to it so the download lands
   * with its Content-Disposition filename. Same authorization and audit entry
   * as POST :id/connect.
   */
  connectScriptUrl: (id: string) => `${BASE_URL}/endpoints/${id}/connect.cmd`,
  connected: () => api.get('/endpoints/connected'),
  // Employee-facing: only computers this user is authorized to connect to.
  mine: () => api.get('/endpoints/mine'),
  // Employee-facing Connect — checks ComputerAccess, returns
  // { rustdeskId, hasPassword, grantToken, launchUri, mode, accessPath,
  // maxSessionMinutes }. Never the password itself (0.30.1): it travels in the
  // Connect script or the launcher grant, and a launch that carries it needs a
  // step-up (403 STEP_UP_REQUIRED, which the interceptor below answers).
  // hasPassword is false for a preset-backed launch, and a refusal is a 403 with
  // { code, message } — e.g. TEMPORARY_GRANT_REQUIRED, PROTECTED_DEVICE_CLASS,
  // ENDPOINT_CANNOT_ENFORCE_VIEW_ONLY, IDENTITY_PAUSED — whose message is meant
  // to be shown as it is.
  connect: (id: string, mode?: 'view_only' | 'control') =>
    api.post(`/endpoints/${id}/connect`, undefined, { params: mode ? { mode } : {} }),
  // Redeem a ConnectionGrant token — the launcher path (browser fallback OK too).
  redeemGrant: (token: string) => api.post(`/endpoints/grants/redeem`, { token }),
  // Admin: stage a credential rotation. Old password stays valid until the
  // endpoint applies + confirms the new one on its next heartbeat.
  rotateCredential: (id: string) => api.post(`/endpoints/${id}/rotate-credential`),
  // Admin access management for one computer
  listAccess: (id: string) => api.get(`/endpoints/${id}/access`),
  grantAccess: (id: string, userId: string) => api.post(`/endpoints/${id}/access`, { userId }),
  revokeAccess: (id: string, userId: string) => api.delete(`/endpoints/${id}/access/${userId}`),
  setAccessMode: (id: string, mode: 'ASSIGNED_USERS' | 'COMPANY_WIDE') =>
    api.patch(`/endpoints/${id}/access-mode`, { accessMode: mode }),
  list: (params?: Record<string, string>) =>
    api.get('/endpoints', { params }),
  get: (id: string) => api.get(`/endpoints/${id}`),
  create: (data: Record<string, unknown>) => api.post('/endpoints', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/endpoints/${id}`, data),
  archive: (id: string) => api.patch(`/endpoints/${id}/archive`),
  restore: (id: string) => api.patch(`/endpoints/${id}/restore`),
  /** 0.34: whether the AI summary can be requested through ClientSt0r, and exactly what would be sent. */
  timelineStatus: (id: string) => api.get(`/endpoints/${id}/timeline`),
  generateTimeline: (id: string) => api.post(`/endpoints/${id}/timeline/generate`),
  saveTimeline: (id: string, aiTimeline: string) => api.patch(`/endpoints/${id}`, { aiTimeline }),
  getPassword: (id: string) => api.get(`/endpoints/${id}/password`),
  setPassword: (id: string, password: string | null) => api.patch(`/endpoints/${id}/password`, { password }),
  addTag: (id: string, tag: string) => api.post(`/endpoints/${id}/tags`, { tag }),
  removeTag: (id: string, tag: string) => api.delete(`/endpoints/${id}/tags/${encodeURIComponent(tag)}`),
  // Tactical RMM: turn what a TRMM URL Action sends into one computer, and
  // record the mapping so the next launch is exact.
  trmmResolve: (q: { host?: string; client?: string; site?: string; agent?: string }) =>
    api.get('/endpoints/trmm/resolve', { params: q }),
  trmmLink: (endpointId: string, agentId: string) =>
    api.post('/endpoints/trmm/link', { endpointId, agentId }),
  // System specs, Windows Update state and recent collection requests for one
  // computer. Populated by the agent's heartbeat, so a machine whose installer
  // predates this reports `agentBound: false` and nothing else.
  inventory: (id: string) => api.get(`/endpoints/${id}/inventory`),
  // Metric history (0.33): CPU, memory and disk over 24h | 7d | 30d | 90d.
  // Gaps come back as intervals; nothing is interpolated.
  metrics: (id: string, range: string) => api.get(`/endpoints/${id}/metrics`, { params: { range } }),
  // Chat (0.34): the person at the computer, through the signed Windows agent.
  chat: (id: string) => api.get(`/endpoints/${id}/chat`),
  chatTranscript: (id: string, cid: string) => api.get(`/endpoints/${id}/chat/conversations/${cid}`),
  chatStart: (id: string, supportRequestId?: string) => api.post(`/endpoints/${id}/chat/conversations`, supportRequestId ? { supportRequestId } : {}),
  chatSend: (id: string, cid: string, text: string) => api.post(`/endpoints/${id}/chat/conversations/${cid}/messages`, { text }),
  chatEnd: (id: string, cid: string) => api.post(`/endpoints/${id}/chat/conversations/${cid}/end`, {}),
  // 0.36: the panel has shown these replies (in a chat that is not recorded, the server then deletes them).
  chatAck: (id: string, cid: string, ids: string[]) => api.post(`/endpoints/${id}/chat/conversations/${cid}/ack`, { ids }),
  // 0.44: a file or image, as multipart (the server decides what it is from its bytes).
  chatUpload: (id: string, cid: string, file: File, onUploadProgress?: (e: { loaded: number; total?: number }) => void) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return api.post(`/endpoints/${id}/chat/conversations/${cid}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }, onUploadProgress,
    });
  },
  // 0.36: the tray on this computer, its self-help runs and the support requests sent from it.
  tray: (id: string) => api.get(`/endpoints/${id}/tray`),
  // Queues a re-collection for the endpoint's next heartbeat — up to ~3
  // minutes away. Nothing is synchronous here.
  refreshInventory: (id: string) => api.post(`/endpoints/${id}/inventory/refresh`, {}),
  // Re-runs the installer on the machine: upgrades the Rem0te agent while
  // keeping its config, password and enrolment. The only way to refresh the
  // agent on a computer whose RustDesk client is already current.
  reinstallAgent: (id: string) => api.post(`/endpoints/${id}/reinstall-agent`, {}),
  // 0.34 Agent card: what the computer runs, and updating or upgrading it.
  // Upgrading needs a fresh sign-in (the interceptor asks) and a reason.
  agent: (id: string) => api.get(`/endpoints/${id}/agent`),
  updateAgent: (id: string) => api.post(`/endpoints/${id}/agent/update`, {}),
  migrateAgent: (id: string, reason: string) => api.post(`/endpoints/${id}/agent/migrate`, { reason }),
  /** 0.46: this computer's own automatic-agent-update setting. Anything but off may answer STEP_UP_REQUIRED. */
  setAgentAutoUpdate: (id: string, mode: 'inherit' | 'on' | 'off') => api.put(`/endpoints/${id}/agent/auto-update`, { mode }),
  cancelAgentMigration: (id: string) => api.post(`/endpoints/${id}/agent/migrate/cancel`, {}),
  agentMigrations: (params?: { state?: string; businessId?: string }) => api.get('/agent-migrations', { params }),
  // Trust the new device secret a computer is heartbeating with after its
  // bound one stopped matching (e.g. an installer re-run that lost it).
  acceptDeviceSecret: (id: string) => api.post(`/endpoints/${id}/accept-device-secret`, {}),
  requestEventLog: (
    id: string,
    query: { logName: string; levels?: number[]; maxEvents?: number; sinceHours?: number; providerName?: string },
  ) => api.post(`/endpoints/${id}/event-log`, query),
  // The last query run against this computer, whoever ran it — so the tab
  // shows what was already fetched rather than an empty form.
  latestEventLog: (id: string) => api.get(`/endpoints/${id}/event-log/latest`),
  // Polled while a request is outstanding.
  command: (id: string, commandId: string) => api.get(`/endpoints/${id}/commands/${commandId}`),
  addAlias: (id: string, alias: string) => api.post(`/endpoints/${id}/aliases`, { alias }),
  removeAlias: (id: string, aliasId: string) => api.delete(`/endpoints/${id}/aliases/${aliasId}`),
};

// ─── Sessions ────────────────────────────────────────────────────────────────
export const sessionsApi = {
  list: (params?: Record<string, string>) => api.get('/sessions', { params }),
  get: (id: string) => api.get(`/sessions/${id}`),
  create: (data: Record<string, unknown>) => api.post('/sessions', data),
  complete: (id: string, data: Record<string, unknown>) => api.patch(`/sessions/${id}/complete`, data),
  cancel: (id: string) => api.patch(`/sessions/${id}/cancel`),
  stats: (days?: number) => api.get('/sessions/stats', { params: days ? { days } : {} }),
};

// ─── Launcher ────────────────────────────────────────────────────────────────
export const launcherApi = {
  issueToken: (data: Record<string, unknown>) => api.post('/launcher/token', data),
  revokeToken: (id: string) => api.patch(`/launcher/token/${id}/revoke`),
};

// ─── Businesses ──────────────────────────────────────────────────────────────
// A Business is a customer organisation, and it is the security boundary:
// every call below is scoped server-side to the caller's own business unless
// they are a Platform Admin.
export const businessesApi = {
  list: (params?: Record<string, string>) => api.get('/businesses', { params }),
  get: (id: string) => api.get(`/businesses/${id}`),
  create: (data: Record<string, unknown>) => api.post('/businesses', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/businesses/${id}`, data),
  archive: (id: string) => api.patch(`/businesses/${id}/archive`),
  remove: (id: string) => api.delete(`/businesses/${id}`),
  sites: (id: string) => api.get(`/businesses/${id}/sites`),

  // People
  listUsers: (id: string) => api.get(`/businesses/${id}/users`),
  addUser: (id: string, data: {
    email: string; firstName?: string; lastName?: string;
    level: 'BUSINESS_OWNER' | 'BUSINESS_USER'; capabilities?: string[];
  }) => api.post(`/businesses/${id}/users`, data),
  setUserCapabilities: (id: string, userId: string, capabilities: string[]) =>
    api.patch(`/businesses/${id}/users/${userId}/capabilities`, { capabilities }),
  setUserActive: (id: string, userId: string, active: boolean) =>
    api.patch(`/businesses/${id}/users/${userId}/active`, { active }),
  resetUserAccess: (id: string, userId: string) =>
    api.post(`/businesses/${id}/users/${userId}/reset-access`),
  removeUser: (id: string, userId: string) =>
    api.delete(`/businesses/${id}/users/${userId}`),

  // The capability vocabulary, so the permission checkboxes stay in step with
  // the server instead of being duplicated in the UI.
  capabilityCatalog: () => api.get('/businesses/capability-catalog'),
};

// ─── Sites ───────────────────────────────────────────────────────────────────
export const sitesApi = {
  list: (businessId?: string) =>
    api.get('/sites', { params: businessId ? { businessId } : {} }),
  get: (id: string) => api.get(`/sites/${id}`),
  create: (data: Record<string, unknown>) => api.post('/sites', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/sites/${id}`, data),
  delete: (id: string) => api.delete(`/sites/${id}`),
};

// ─── Users ───────────────────────────────────────────────────────────────────
export const usersApi = {
  list: (businessId?: string) =>
    api.get('/users', { params: businessId ? { businessId } : {} }),
  suspend: (userId: string) => api.patch(`/users/${userId}/suspend`),
  activate: (userId: string) => api.patch(`/users/${userId}/activate`),
  updateProfile: (userId: string, data: {
    firstName?: string; lastName?: string; email?: string;
    phone?: string; jobTitle?: string;
    address?: string; city?: string; state?: string; country?: string; postalCode?: string;
    timeZone?: string;
  }) => api.patch(`/users/${userId}`, data),
  resetPassword: (userId: string, password: string) =>
    api.post(`/users/${userId}/reset-password`, { password }),
  /** Move between the two business levels. Promotion is Platform Admin only. */
  setLevel: (userId: string, level: 'BUSINESS_OWNER' | 'BUSINESS_USER') =>
    api.patch(`/users/${userId}/level`, { level }),
  setCapabilities: (userId: string, capabilities: string[]) =>
    api.patch(`/users/${userId}/capabilities`, { capabilities }),
  setBusiness: (userId: string, businessId: string | null) =>
    api.patch(`/users/${userId}/business`, { businessId }),
  remove: (userId: string) => api.delete(`/users/${userId}`),
  resetMfa: (userId: string) => api.post(`/users/${userId}/mfa/reset`),
  listPlatformAdmins: () => api.get('/users/platform-admins'),
  findByEmail: (email: string) => api.get('/users/find', { params: { email } }),
  setPlatformAdmin: (userId: string, enabled: boolean) =>
    api.patch(`/users/${userId}/platform-admin`, { enabled }),
};

// ─── Platform configuration ──────────────────────────────────────────────────
// Branding, RustDesk server settings, MFA policy, feature switches.
// Platform Admin only.
export const platformApi = {
  list: () => api.get('/platform'),
  get: (id: string) => api.get(`/platform/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/platform/${id}`, data),
  updateBranding: (id: string, data: Record<string, unknown>) =>
    api.patch(`/platform/${id}/branding`, data),
  uploadLogo: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.patch(`/platform/${id}/branding/logo`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  updateSettings: (id: string, data: Record<string, unknown>) =>
    api.patch(`/platform/${id}/settings`, data),

  // Platform-wide feature switches — the Quick Connect master switch lives here.
  getSettings: () => api.get('/admin/platform-settings'),
  saveSettings: (data: {
    quickConnectEnabled?: boolean;
    quickConnectWindows?: boolean;
    quickConnectMacos?: boolean;
    quickConnectLinux?: boolean;
  }) => api.patch('/admin/platform-settings', data),
};

// ─── Quick Connect ───────────────────────────────────────────────────────────
// Temporary support access to a machine that is NOT an enrolled managed
// computer. The remote person reads out the ID and password their Quick
// Connect client displays; Rem0te never stores that password.
export const quickConnectApi = {
  status: () => api.get('/quick-connect/status'),
  connect: (data: { rustdeskId: string; password: string; contactName?: string; issueDescription?: string }) =>
    api.post('/quick-connect/connect', data),
  endSession: (id: string, result?: 'completed' | 'failed' | 'cancelled') =>
    api.post(`/quick-connect/sessions/${id}/end`, result ? { result } : {}),
  sessions: (params?: Record<string, string>) => api.get('/quick-connect/sessions', { params }),
};

// ─── Audit ───────────────────────────────────────────────────────────────────
export const auditApi = {
  list: (params?: Record<string, string>) => api.get('/audit', { params }),
};

// ─── Enrollment ──────────────────────────────────────────────────────────────
export const enrollmentApi = {
  listTokens: () => api.get('/enrollment/tokens'),
  createToken: (data: Record<string, unknown>) => api.post('/enrollment/tokens', data),
  /** Add device: has the device this token was made for enrolled, and how is it? Never returns the token. */
  tokenStatus: (id: string) => api.get(`/enrollment/tokens/${encodeURIComponent(id)}/status`),
  revokeToken: (id: string) => api.delete(`/enrollment/tokens/${id}`),
};

// ─── Admin ────────────────────────────────────────────────────────────────────
export const adminApi = {
  status: () => api.get('/admin/status'),
  listUnassigned: () => api.get('/admin/unassigned-devices'),
};

// ─── Device discovery and adoption (0.57) ────────────────────────────────────
// Platform Admin only. Adopting, forgetting, a new rule and a new deployment
// key ask for a fresh sign-in (the interceptor shows the dialog and retries).
export type AdoptionSource = 'deployment_key' | 'key_binding' | 'domain' | 'cidr' | 'hostname_prefix';
export interface AdoptionMatch { source: AdoptionSource; mappingId: string | null; customerId: string; siteId: string | null; value: string }
export interface PooledComputer {
  id: string; name: string; hostname: string | null; platform: string | null; osVersion: string | null;
  ipAddress: string | null; sourceIp: string | null; arrivedVia: 'heartbeat' | 'install_script' | 'deployment_key' | null;
  deploymentKeyId: string | null; createdAt: string; lastSeenAt: string | null; isOnline: boolean; status: string;
  agentVersion: string | null; agentVersionView?: AgentVersionView; updateChannel: string | null; macAddress: string | null; serialNumber: string | null;
  rustdeskId: string | null; rustdeskVersion: string | null; nodeLastSeenAt: string | null; agentBound: boolean;
  inventory: {
    manufacturer: string | null; model: string | null; serialNumber: string | null; chassisType: string | null; osCaption: string | null;
    osBuild: string | null; osArch: string | null; domain: string | null; cpuModel: string | null; cpuCores: number | null;
    cpuThreads: number | null; memoryTotalMb: number | null; systemDiskTotalMb: number | null; collectedAt: string | null;
  } | null;
  deploymentKey: { id: string; name: string; customerId: string; siteId: string | null; mode: 'review' | 'active'; keyHint: string } | null;
  suggestion: AdoptionMatch | null; matches: AdoptionMatch[]; conflict: boolean;
}
export interface AdoptionMapping {
  id: string; customerId: string; siteId: string | null; kind: 'deployment_key' | 'domain' | 'cidr' | 'hostname_prefix';
  value: string; deploymentKeyId: string | null; priority: number; note: string | null; createdAt: string;
  businessName: string | null; siteName: string | null; keyName: string | null; keyState: DeploymentKeyState | null;
}
export type DeploymentKeyState = 'usable' | 'revoked' | 'expired' | 'exhausted';
export interface DeploymentKey {
  id: string; customerId: string; siteId: string | null; endpointGroupId: string | null; name: string; keyHint: string;
  mode: 'review' | 'active'; accessMode: 'ASSIGNED_USERS' | 'COMPANY_WIDE'; maxUses: number; useCount: number;
  expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; createdAt: string; state: DeploymentKeyState;
  businessName: string | null; siteName?: string | null; groupName?: string | null;
  /** Only in the answer to create, once. */
  key?: string;
}
export type AdoptResult = { endpointId: string; result: 'adopted' | 'not_unassigned' };
export const adoptionApi = {
  devices: () => api.get('/adoption/devices').then((r) => r.data?.data as { computers: PooledComputer[]; businesses: Record<string, string>; sites: Record<string, string> }),
  assign: (body: { endpointIds: string[]; businessId: string; siteId?: string | null; groupIds?: string[]; mappingId?: string | null }) =>
    api.post('/adoption/devices/assign', body).then((r) => r.data?.data as { results: AdoptResult[] }),
  forget: (endpointIds: string[]) =>
    api.post('/adoption/devices/forget', { endpointIds }).then((r) => r.data?.data as { results: { endpointId: string; result: 'forgotten' | 'not_unassigned' | 'in_use' }[] }),
  mappings: () => api.get('/adoption/mappings').then((r) => r.data?.data as AdoptionMapping[]),
  createMapping: (body: { businessId: string; siteId?: string | null; kind: AdoptionMapping['kind']; value: string; priority?: number; note?: string | null }) =>
    api.post('/adoption/mappings', body).then((r) => r.data?.data as AdoptionMapping),
  deleteMapping: (id: string) => api.delete(`/adoption/mappings/${id}`).then((r) => r.data?.data),
  keys: () => api.get('/adoption/deployment-keys').then((r) => r.data?.data as DeploymentKey[]),
  createKey: (body: { businessId: string; siteId?: string | null; endpointGroupId?: string | null; name: string; mode: 'review' | 'active'; accessMode?: DeploymentKey['accessMode']; maxUses: number; expiresInDays: number }) =>
    api.post('/adoption/deployment-keys', body).then((r) => r.data?.data as DeploymentKey),
  revokeKey: (id: string) => api.post(`/adoption/deployment-keys/${id}/revoke`).then((r) => r.data?.data),
};

// ─── Public address (Settings → General) ─────────────────────────────────────
export interface PublicAddressInfo {
  effective: string;
  effectiveApi: string;
  source: 'setting' | 'environment' | 'default';
  setting: string | null;
  environment: { FRONTEND_URL: string | null; PUBLIC_API_URL: string | null };
  webauthnRpIdPinned: boolean;
  passkeys: number;
}
export interface PublicAddressCheck { address: string; reachable: boolean; sameServer: boolean; detail: string }
export const publicAddressApi = {
  get: () => api.get<{ data: PublicAddressInfo }>('/admin/public-address'),
  check: (url: string) => api.post<{ data: PublicAddressCheck }>('/admin/public-address/check', { url }),
  /** null clears the setting. 409 ADDRESS_UNVERIFIED unless the check passes or saveUnverified. */
  set: (url: string | null, saveUnverified = false) =>
    api.put<{ data: PublicAddressInfo & { check: PublicAddressCheck | null } }>('/admin/public-address', { url, saveUnverified }),
};

// ─── Automatic snapshots (0.35) ───────────────────────────────────────────────
export type SnapshotScheduleKey = 'process_list' | 'service_list' | 'network_adapters';
export interface SnapshotSchedule {
  enabled: boolean;
  /** Minutes between automatic snapshots per key; 0 = not on a schedule. */
  minutes: Record<SnapshotScheduleKey, number>;
  /** Minutes between snapshots while the key's tab is open; 0 = off. */
  watchMinutes: number;
  /** False when this server runs with SNAPSHOT_SWEEP=off: nothing is asked for automatically whatever is saved. */
  processEnabled: boolean;
  /** Scheduled snapshots started per minute at most (SNAPSHOT_MAX_PER_MINUTE). */
  perMinute: number;
}
export const snapshotScheduleApi = {
  get: () => api.get<{ data: SnapshotSchedule }>('/admin/snapshot-schedule'),
  set: (body: Partial<Pick<SnapshotSchedule, 'enabled' | 'watchMinutes'>> & { minutes?: Partial<Record<SnapshotScheduleKey, number>> }) =>
    api.put<{ data: SnapshotSchedule }>('/admin/snapshot-schedule', body),
};

// ─── Update ───────────────────────────────────────────────────────────────────
// ─── Technician client downloads ──────────────────────────────────────────
// Authenticated, unlike the Quick Connect downloads: these are for the people
// doing the supporting, not the person being helped.
export const downloadsApi = {
  manifest: () => api.get('/downloads'),
};

export const updateApi = {
  // Version and codename only — readable by anyone signed in. `version` below
  // also reports update availability and is Platform Admin only.
  appVersion: () => api.get('/admin/update/app-version'),
  version: () => api.get('/admin/update/version'),
  check: () => api.get('/admin/update/check'),
  changelog: () => api.get('/admin/update/changelog'),
  progressUrl: () => `${BASE_URL}/admin/update/progress`,
  // RustDesk client versions across managed endpoints, and staging upgrades.
  rustdesk: () => api.get('/admin/update/rustdesk'),
  updateRustdesk: (endpointIds?: string[]) =>
    api.post('/admin/update/rustdesk', endpointIds?.length ? { endpointIds } : {}),
  cancelRustdesk: (endpointId: string) =>
    api.post(`/admin/update/rustdesk/${endpointId}/cancel`, {}),
  // hbbs/hbbr — the rendezvous and relay pair this platform runs, which is a
  // different thing from the client on an endpoint.
  rustdeskServer: () => api.get('/admin/update/rustdesk-server'),
  updateRustdeskServer: () => api.post('/admin/update/rustdesk-server', {}),
};

// ─── Admin Security ───────────────────────────────────────────────────────
// Admin → Security (0.74). Platform Admin only. Every change may answer
// 403 STEP_UP_REQUIRED (server.security, or login.lockout when the lockout is
// weakened), which the interceptor below answers.
export const securityApi = {
  getPosture: (refresh = false) => api.get('/admin/security/posture', { params: refresh ? { refresh: 1 } : {} }),
  getConfig: () => api.get('/admin/security/config'),
  updateConfig: (data: { maxLoginAttempts?: number; lockoutMinutes?: number; clearUnenforced?: boolean }) => api.patch('/admin/security/config', data),
  getFail2ban: (refresh = false) => api.get('/admin/security/fail2ban', { params: refresh ? { refresh: 1 } : {} }),
  unbanIp: (jail: string, ip: string) => api.post('/admin/security/fail2ban/unban', { jail, ip }),
  banIp: (jail: string, ip: string) => api.post('/admin/security/fail2ban/ban', { jail, ip }),
  getIgnoreList: () => api.get('/admin/security/fail2ban/ignore'),
  addIgnoreIp: (ip: string) => api.post('/admin/security/fail2ban/ignore', { ip }),
  removeIgnoreIp: (ip: string) => api.delete(`/admin/security/fail2ban/ignore/${encodeURIComponent(ip)}`),
  getJailConfig: (jail: string) => api.get(`/admin/security/fail2ban/jail/${encodeURIComponent(jail)}/config`),
  updateJailConfig: (jail: string, cfg: { bantime?: number; findtime?: number; maxretry?: number }) => api.patch(`/admin/security/fail2ban/jail/${encodeURIComponent(jail)}/config`, cfg),
  installFail2ban: () => api.post('/admin/security/fail2ban/install'),
  getOsUpdates: (refresh = false) => api.get('/admin/security/os-updates', { params: refresh ? { refresh: 1 } : {} }),
  runOsUpdate: () => api.post('/admin/security/os-updates/run'),
  getOsUpdateStatus: () => api.get('/admin/security/os-updates/status'),
  getDependencyAudit: (refresh = false) => api.get('/admin/security/audit', { params: refresh ? { refresh: 1 } : {} }),
  getTls: (refresh = false) => api.get('/admin/security/tls', { params: refresh ? { refresh: 1 } : {} }),
};

// ─── Notes ───────────────────────────────────────────────────────────────────
export const notesApi = {
  list: (params: Record<string, string>) => api.get('/notes', { params }),
  create: (data: Record<string, unknown>) => api.post('/notes', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/notes/${id}`, data),
  delete: (id: string) => api.delete(`/notes/${id}`),
};

// ─── v0.20: step-up ──────────────────────────────────────────────────────────
// Sensitive actions answer 403 { code: 'STEP_UP_REQUIRED' }. The interceptor
// below asks the person to confirm it is them (StepUpDialog, mounted in the app
// layout) and retries the request once. Nothing here grants anything: the
// server re-checks the step-up cookie on the retried request.
export const stepUpApi = {
  status: () => api.get('/auth/step-up'),
  verify: (data: { password?: string; totpCode?: string }) => api.post('/auth/step-up', data),
  passkeyOptions: () => api.post('/auth/step-up/passkey/options'),
  passkeyVerify: (response: unknown) => api.post('/auth/step-up/passkey', { response }),
};

type StepUpHandler = (action: string | undefined, message: string | undefined) => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
/** Registered by StepUpDialog. Resolves true once a step-up succeeded. */
export function registerStepUpHandler(h: StepUpHandler | null) { stepUpHandler = h; }

api.interceptors.response.use(undefined, async (error) => {
  const res = error?.response;
  const cfg = error?.config as (typeof error.config & { _stepUpRetried?: boolean }) | undefined;
  if (res?.status === 403 && res.data?.code === 'STEP_UP_REQUIRED' && cfg && !cfg._stepUpRetried && stepUpHandler) {
    const ok = await stepUpHandler(res.data?.action, res.data?.message);
    if (ok) {
      cfg._stepUpRetried = true;
      return api.request(cfg);
    }
  }
  return Promise.reject(error);
});

// ─── v0.20: which business a multi-business person is working in ────────────
// The API honours the cookie only for the person's own business or one they
// are currently assigned to; anything else silently acts as their own.
export const BUSINESS_COOKIE = 'rem0te_business';
export function setActiveBusiness(id: string | null) {
  if (typeof document === 'undefined') return;
  document.cookie = id
    ? `${BUSINESS_COOKIE}=${encodeURIComponent(id)}; path=/; SameSite=Strict`
    : `${BUSINESS_COOKIE}=; path=/; Max-Age=0; SameSite=Strict`;
}

// ─── v0.20: MSP technicians ──────────────────────────────────────────────────
export const techniciansApi = {
  me: () => api.get('/technicians/me'),
  overview: () => api.get('/technicians/overview'),
  vocabulary: () => api.get('/technicians/vocabulary'),
  requestAccess: (data: Record<string, unknown>) => api.post('/technicians/access-requests', data),
  approvals: () => api.get('/technicians/approvals'),
  decide: (id: string, data: { decision: 'APPROVE' | 'DENY'; note?: string; capabilities?: string[]; endpointIds?: string[]; expiresAt?: string | null }) =>
    api.post(`/technicians/approvals/${id}`, data),
  setApprovalRequired: (businessId: string, required: boolean) =>
    api.patch(`/technicians/businesses/${businessId}/approval-required`, { required }),
  people: () => api.get('/technicians/people'),
  effective: (userId: string) => api.get(`/technicians/people/${userId}/effective`),
  setPlatformPermissions: (userId: string, permissions: string[]) =>
    api.patch(`/technicians/people/${userId}/platform-permissions`, { permissions }),
  assignments: (params?: Record<string, string>) => api.get('/technicians/assignments', { params }),
  createAssignment: (data: Record<string, unknown>) => api.post('/technicians/assignments', data),
  revokeAssignment: (id: string, reason?: string) => api.post(`/technicians/assignments/${id}/revoke`, { reason }),
  groups: () => api.get('/technicians/groups'),
  createGroup: (data: Record<string, unknown>) => api.post('/technicians/groups', data),
  updateGroup: (id: string, data: Record<string, unknown>) => api.patch(`/technicians/groups/${id}`, data),
  deleteGroup: (id: string) => api.delete(`/technicians/groups/${id}`),
  addMember: (id: string, userId: string) => api.post(`/technicians/groups/${id}/members`, { userId }),
  removeMember: (id: string, userId: string) => api.delete(`/technicians/groups/${id}/members/${userId}`),
};

// ─── v0.20: connection diagnostics ───────────────────────────────────────────
export const diagnosticsApi = {
  forEndpoint: (id: string) => api.get(`/endpoints/${id}/diagnostics`),
  /** A redacted text report, downloaded by navigation. */
  reportUrl: (id: string) => `${BASE_URL}/endpoints/${id}/diagnostics/report`,
  /** The technician-side check (Windows .cmd), downloaded by navigation. */
  helperUrl: (endpointId?: string) =>
    `${BASE_URL}/diagnostics/technician/helper.cmd${endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : ''}`,
  latestTechnicianReport: () => api.get('/diagnostics/technician/latest'),
};

// ─── v0.20: access review and offboarding ────────────────────────────────────
export const offboardingApi = {
  accessReview: (endpointId: string) => api.get(`/endpoints/${endpointId}/access-review`),
  preview: (userId: string, businessId?: string) =>
    api.get('/offboarding/preview', { params: { userId, ...(businessId ? { businessId } : {}) } }),
  execute: (data: { userId: string; businessId?: string; suspendAccount?: boolean; rotateEndpointIds?: string[]; notes?: string }) =>
    api.post('/offboarding', data),
  list: (businessId?: string) => api.get('/offboarding', { params: businessId ? { businessId } : {} }),
  get: (id: string) => api.get(`/offboarding/${id}`),
  pendingRotations: (businessId?: string) =>
    api.get('/offboarding/pending-rotations', { params: businessId ? { businessId } : {} }),
};

// ─── v0.20: support requests ─────────────────────────────────────────────────
export const supportRequestsApi = {
  getIntake: (businessId?: string) => api.get('/support-requests/intake', { params: businessId ? { businessId } : {} }),
  setIntake: (enabled: boolean, regenerate = false, businessId?: string) =>
    api.patch('/support-requests/intake', { enabled, regenerate }, { params: businessId ? { businessId } : {} }),
  /** A signed-in business user asking for help. */
  submit: (data: { description: string; endpointId?: string; phone?: string }) => api.post('/support-requests', data),
  list: (params?: { businessId?: string; status?: string; mine?: boolean }) =>
    api.get('/support-requests', { params: { ...params, mine: params?.mine ? '1' : undefined } }),
  get: (id: string) => api.get(`/support-requests/${id}`),
  handoffCandidates: (id: string) => api.get(`/support-requests/${id}/handoff-candidates`),
  claim: (id: string, version: number) => api.post(`/support-requests/${id}/claim`, { version }),
  handoff: (id: string, version: number, toUserId: string, note?: string) =>
    api.post(`/support-requests/${id}/handoff`, { version, toUserId, note }),
  release: (id: string, version: number) => api.post(`/support-requests/${id}/release`, { version }),
  complete: (id: string, version: number, outcome?: string) => api.post(`/support-requests/${id}/complete`, { version, outcome }),
  cancel: (id: string, version: number, outcome?: string) => api.post(`/support-requests/${id}/cancel`, { version, outcome }),
};

// ─── v0.36: whether chats are recorded ───────────────────────────────────────
// Changing either needs a fresh sign-in (403 STEP_UP_REQUIRED, which the
// interceptor answers) and is audited.
/**
 * Where a chat attachment is read (0.44): an image's URL for <img>, a file's
 * for a download link. Built only from ids, each encoded; the session cookie
 * goes with the request, so no token is put in the URL.
 */
export function chatAttachmentUrl(endpointId: string, conversationId: string, attachmentId: string): string {
  return `${BASE_URL}/endpoints/${encodeURIComponent(endpointId)}/chat/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

// ─── v0.52: task progress (read only) ────────────────────────────────────────
// Every task sent or queued for a computer, with one lifecycle. Cancelling a
// scheduled one is actionsApi.cancel (the existing route).
export type ScheduleInput = { local: string; timeZone: string };
export const tasksApi = {
  list: (q: { state?: string; type?: string; businessId?: string } = {}) => api.get('/tasks', { params: q }),
  endpoint: (endpointId: string) => api.get(`/endpoints/${encodeURIComponent(endpointId)}/tasks`),
  mine: (since?: string) => api.get('/tasks/mine', { params: since ? { since } : {} }),
};

// ─── v0.44: the chat inbox (the header's chat icon, toasts, the title count) ─
export const chatInboxApi = {
  get: (since?: string) => api.get('/chat/inbox', { params: since ? { since } : {} }),
  markRead: (conversationId: string, upTo?: string) => api.post('/chat/inbox/read', upTo ? { conversationId, upTo } : { conversationId }),
};

export const chatRecordingApi = {
  get: (businessId?: string) => api.get('/chat-recording', { params: businessId ? { businessId } : {} }),
  setBusiness: (businessId: string, recording: boolean | null) => api.put('/chat-recording', { businessId, recording }),
  setPlatform: (recording: boolean) => api.put('/chat-recording/platform', { recording }),
};

// 0.49: which functions ask "confirm it is you" (Settings → Confirm it is you).
// The catalog comes from the API; the console keeps no copy of it.
export const confirmPolicyApi = {
  get: () => api.get('/security/confirm-policy'),
  set: (values: Record<string, 'ask' | 'off'>) => api.put('/security/confirm-policy', { values }),
};

/** The customer side: no account, the link is the only key. */
export const publicSupportApi = {
  intake: (slug: string) => api.get(`/public/support/intake/${encodeURIComponent(slug)}`),
  submit: (slug: string, data: Record<string, unknown>) => api.post(`/public/support/intake/${encodeURIComponent(slug)}`, data),
  status: (token: string) => api.get(`/public/support/status/${encodeURIComponent(token)}`),
  cancel: (token: string) => api.post(`/public/support/status/${encodeURIComponent(token)}/cancel`),
};

// ─── v0.20: staged endpoint updates ──────────────────────────────────────────
export const rolloutsApi = {
  list: () => api.get('/admin/rollouts'),
  get: (id: string) => api.get(`/admin/rollouts/${id}`),
  create: (data: Record<string, unknown>) => api.post('/admin/rollouts', data),
  start: (id: string) => api.post(`/admin/rollouts/${id}/start`),
  pause: (id: string) => api.post(`/admin/rollouts/${id}/pause`),
  cancel: (id: string) => api.post(`/admin/rollouts/${id}/cancel`),
  cancelJob: (jobId: string) => api.post(`/admin/rollouts/jobs/${jobId}/cancel`),
  history: (endpointId: string) => api.get(`/admin/rollouts/endpoints/${endpointId}/history`),
  pilotGroups: () => api.get('/admin/rollouts/pilot-groups'),
  savePilotGroup: (data: { id?: string; name: string; description?: string; endpointIds: string[] }) =>
    api.post('/admin/rollouts/pilot-groups', data),
  pin: () => api.get('/admin/rollouts/pin'),
  setPin: (version: string | null) => api.patch('/admin/rollouts/pin', { version }),
};

// ─── v0.20: SSO (OIDC) and passkeys ──────────────────────────────────────────
export const ssoApi = {
  // Sign-in page
  providers: () => api.get('/auth/sso/providers'),
  /** Navigate here (not an XHR): it redirects to the provider. */
  startUrl: (id: string, returnTo?: string) =>
    `${BASE_URL}/auth/sso/${encodeURIComponent(id)}/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`,
  // The signed-in person's own identities
  identities: () => api.get('/auth/sso/identities'),
  /** Returns { url } to navigate to; the provider round trip then links. */
  link: (id: string, returnTo = '/account') => api.post(`/auth/sso/${encodeURIComponent(id)}/link`, { returnTo }),
  unlink: (identityId: string) => api.delete(`/auth/sso/identities/${identityId}`),
  // Platform Admin configuration
  adminList: () => api.get('/sso/providers'),
  create: (data: Record<string, unknown>) => api.post('/sso/providers', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/sso/providers/${id}`, data),
  remove: (id: string) => api.delete(`/sso/providers/${id}`),
  test: (id: string) => api.post(`/sso/providers/${id}/test`),
  addMapping: (id: string, data: { groupValue: string; businessId: string; capabilities?: string[] }) =>
    api.post(`/sso/providers/${id}/mappings`, data),
  removeMapping: (id: string, mappingId: string) => api.delete(`/sso/providers/${id}/mappings/${mappingId}`),
  // 0.59 "Agit8or Identity P0"
  generateClientKey: (id: string) => api.post(`/sso/providers/${id}/client-key`),
  jwksUrl: (id: string) => `${BASE_URL}/auth/sso/${encodeURIComponent(id)}/jwks.json`,
  stepUpOptions: () => api.get('/auth/sso/step-up'),
  stepUpStart: (data: { providerId?: string; phishingResistant?: boolean; returnTo?: string }) => api.post('/auth/sso/step-up', data),
  suggestions: () => api.get('/sso/link-suggestions'),
  confirmSuggestion: (id: string) => api.post(`/sso/link-suggestions/${id}/confirm`),
  dismissSuggestion: (id: string) => api.post(`/sso/link-suggestions/${id}/dismiss`),
  enforcement: () => api.get('/sso/enforcement'),
  setMode: (scope: string, mode: 'off' | 'optional' | 'required') => api.put(`/sso/enforcement/${encodeURIComponent(scope)}`, { mode }),
  setBreakGlass: (userId: string, breakGlass: boolean) => api.put(`/sso/break-glass/${userId}`, { breakGlass }),
  mode: () => api.get('/auth/sso/mode'),
};

export const passkeysApi = {
  list: () => api.get('/auth/passkeys'),
  registerOptions: () => api.post('/auth/passkeys/register/options'),
  register: (response: unknown, name?: string) => api.post('/auth/passkeys/register', { response, name }),
  remove: (id: string) => api.delete(`/auth/passkeys/${id}`),
  loginOptions: () => api.post('/auth/passkeys/login/options'),
  login: (response: unknown) => api.post('/auth/passkeys/login', { response }),
};

// ─── v0.23: technician access presets and security controls ─────────────────
// Settings → Security → Technician Access, the Security Features catalog, and
// a technician's own temporary-access requests. Every mutation here except the
// revoke routes needs fresh authentication; the step-up interceptor above
// prompts and retries. A widening change comes back as
// { pendingReview: true, request } rather than being applied.
export type InspectAction =
  | 'view_inventory' | 'support_requests' | 'event_logs' | 'diagnostics' | 'credential_reveal' | 'enrollment'
  | 'launch_view_only' | 'launch_control' | 'launch_elevated' | 'launch_unattended' | 'clipboard' | 'file_transfer'
  | 'scripts' | 'patches' | 'fix_request' | 'fix_approval' | 'fleet_execution' | 'approve_requests';

// Signed update chain (0.24): mirror status, trust mode, agent inventory.
export const updateTrustApi = {
  get: () => api.get('/admin/update-trust'),
  setMode: (mode: 'legacy_allowed' | 'signed_only', legacyPortalMigration: boolean) =>
    api.put('/admin/update-trust/mode', { mode, legacyPortalMigration }),
};

// Containment (0.28): global write pause and business suspension. Setting
// needs no step-up; lifting does (the interceptor prompts and retries).
export type ContainmentKind = 'actions' | 'remote' | 'updates' | 'integration' | 'notifications';
export const containmentApi = {
  state: () => api.get('/containment'),
  banner: () => api.get('/containment/banner'),
  set: (data: { scope: 'global' | 'business'; businessId?: string; kinds: ContainmentKind[]; reason: string }) => api.post('/containment/pauses', data),
  clear: (id: string, reason: string) => api.post(`/containment/pauses/${id}/clear`, { reason }),
};

// Tamper-evident audit log (0.28).
export const auditIntegrityApi = {
  get: () => api.get('/audit/integrity'),
  verify: () => api.post('/audit/integrity/verify'),
};

export const securityControlsApi = {
  catalog: (businessId?: string) => api.get('/security-controls/catalog', { params: businessId ? { businessId } : {} }),
  // Presets
  presets: () => api.get('/security-controls/presets'),
  clonePreset: (id: string, name: string) => api.post(`/security-controls/presets/${id}/clone`, { name }),
  previewPreset: (id: string, policy: Record<string, unknown>) => api.post(`/security-controls/presets/${id}/preview`, { policy }),
  updatePreset: (id: string, data: { name?: string; description?: string; policy: Record<string, unknown> }) =>
    api.put(`/security-controls/presets/${id}`, data),
  resetPreset: (id: string) => api.post(`/security-controls/presets/${id}/reset`),
  deletePreset: (id: string) => api.delete(`/security-controls/presets/${id}`),
  // Platform policy
  policy: () => api.get('/security-controls/policy'),
  setPolicy: (policy: Record<string, unknown>) => api.put('/security-controls/policy', policy),
  // Read-only views
  inspect: (q: { userId: string; businessId: string; endpointId?: string; action: InspectAction }) =>
    api.get('/security-controls/inspect', { params: q }),
  upgradePreview: () => api.get('/security-controls/upgrade-preview'),
  // Independent review
  trustChanges: (status?: string) => api.get('/security-controls/trust-changes', { params: status ? { status } : {} }),
  decideTrustChange: (id: string, decision: 'APPROVE' | 'DENY') =>
    api.post(`/security-controls/trust-changes/${id}/decision`, { decision }),
  // Temporary access
  temporaryAccess: (params?: { status?: string; mine?: boolean }) =>
    api.get('/security-controls/temporary-access', {
      params: { ...(params?.status ? { status: params.status } : {}), ...(params?.mine ? { mine: 'true' } : {}) },
    }),
  requestTemporaryAccess: (data: { endpointId: string; mode: 'CONTROL' | 'ELEVATION' | 'PROTECTED_EXCEPTION'; reason: string; durationMinutes: number }) =>
    api.post('/security-controls/temporary-access', data),
  decideTemporaryAccess: (id: string, decision: 'APPROVE' | 'DENY', note?: string) =>
    api.post(`/security-controls/temporary-access/${id}/decision`, { decision, ...(note ? { note } : {}) }),
  activateTemporaryAccess: (id: string) => api.post(`/security-controls/temporary-access/${id}/activate`),
  revokeTemporaryAccess: (id: string) => api.post(`/security-controls/temporary-access/${id}/revoke`),
  // Pauses and alerts
  pauses: () => api.get('/security-controls/pauses'),
  clearPause: (id: string) => api.post(`/security-controls/pauses/${id}/clear`),
  alerts: () => api.get('/security-controls/alerts'),
};

// Monitoring and alerts (0.29).
export type MonitorScope = 'global' | 'business' | 'site' | 'group' | 'endpoint';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type MonitorKindId = 'OFFLINE' | 'DISK_FREE' | 'CPU_HIGH' | 'MEMORY_HIGH' | 'SERVICE_STOPPED' | 'EVENT_MATCH' | 'REBOOT_PENDING' | 'AGENT_SILENT'
  | 'DRIVE_FREE' | 'UPTIME_LONG' | 'UPDATES_MISSING' | 'UPDATE_FAILED' // 0.55
  | 'WARRANTY_EXPIRING'; // 0.56
/** A notification destination: a webhook, or (0.34) a confirmed email recipient of the policy's own scope. */
export type NotifyDestination = { label: string; url: string } | { label: string; recipientId: string };
const bq = (businessId?: string | null) => ({ params: businessId ? { businessId } : {} });
export const monitoringApi = {
  summary: (businessId?: string | null) => api.get('/monitoring/summary', bq(businessId)),
  alerts: (q: { state?: string; severity?: string; endpointId?: string; kind?: string; fingerprint?: string; before?: string; limit?: number; businessId?: string | null }) => {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params[k] = v as string | number;
    return api.get('/monitoring/alerts', { params });
  },
  alert: (id: string, businessId?: string | null) => api.get(`/monitoring/alerts/${id}`, bq(businessId)),
  acknowledge: (id: string, note?: string) => api.post(`/monitoring/alerts/${id}/acknowledge`, note ? { note } : {}),
  resolve: (id: string, note: string) => api.post(`/monitoring/alerts/${id}/resolve`, { note }),
  /** 0.70: resolve every open alert on one computer, until the next check raises what is still true. */
  clearComputer: (endpointId: string) => api.post(`/monitoring/endpoints/${endpointId}/alerts/clear`, {}),
  rules: (businessId?: string | null) => api.get('/monitoring/rules', bq(businessId)),
  /** 0.35: scope 'group' names groupId and a priority (1 first). */
  createRule: (data: { scope: MonitorScope; businessId?: string; siteId?: string; groupId?: string; priority?: number; endpointId?: string; key: string; kind: MonitorKindId; name: string; enabled?: boolean; severity: Severity; params: Record<string, unknown> }) =>
    api.post('/monitoring/rules', data),
  addRecommended: (scope: 'global' | 'business', businessId?: string) => api.post('/monitoring/rules/recommended', businessId ? { scope, businessId } : { scope }),
  updateRule: (id: string, data: { name?: string; enabled?: boolean; severity?: Severity; params?: Record<string, unknown>; priority?: number }) => api.patch(`/monitoring/rules/${id}`, data),
  deleteRule: (id: string) => api.delete(`/monitoring/rules/${id}`),
  suppressions: (businessId?: string | null) => api.get('/monitoring/suppressions', bq(businessId)),
  createSuppression: (data: { scope: MonitorScope; businessId?: string; siteId?: string; endpointId?: string; ruleKeys: string[]; reason: string; startsAt?: string; endsAt: string }) =>
    api.post('/monitoring/suppressions', data),
  revokeSuppression: (id: string) => api.post(`/monitoring/suppressions/${id}/revoke`),
  policy: (businessId?: string | null) => api.get('/monitoring/notify-policy', bq(businessId)),
  setPolicy: (data: { scope: 'global' | 'business'; businessId?: string; levels: { afterMinutes: number; minSeverity: Severity; destinations: NotifyDestination[] }[]; ticketing: { enabled: boolean; minSeverity: Severity } }) =>
    api.put('/monitoring/notify-policy', data),
  endpoint: (id: string) => api.get(`/monitoring/endpoints/${id}`),
  /** 0.55: automatic PSA tickets from alerts. Saving and removing ask for fresh authentication (monitoring.autoticket). */
  ticketPolicy: (businessId?: string | null) => api.get('/monitoring/ticket-policy', bq(businessId)),
  setTicketPolicy: (data: { scope: 'global' | 'business'; businessId?: string; enabled: boolean; minSeverity: Severity; kinds: MonitorKindId[] }) => api.put('/monitoring/ticket-policy', data),
  removeTicketPolicy: (scope: 'global' | 'business', businessId?: string | null) => api.delete('/monitoring/ticket-policy', { params: { scope, ...(businessId ? { businessId } : {}) } }),
};

// False positives and alert quality rules (0.67). Reporting never changes a
// monitor or a rule. A rule applies only once tested (simulate) and approved;
// approving may answer STEP_UP_REQUIRED (monitoring.qualityrule), which the
// interceptor answers. Reject and rollback never ask.
export const FP_REASONS = [
  ['known_harmless', 'Known harmless event'], ['incorrect_severity', 'Incorrect severity'], ['duplicate', 'Duplicate alert'],
  ['expected_activity', 'Expected activity'], ['incorrect_threshold', 'Incorrect threshold'], ['rule_too_broad', 'Monitoring rule too broad'],
  ['incorrect_correlation', 'Incorrect correlation'], ['other', 'Other'],
] as const;
export type FpReason = (typeof FP_REASONS)[number][0];
export type QualityScope = { kind: 'endpoint' | 'group' | 'business' | 'monitor' | 'os' | 'platform'; businessId?: string; endpointId?: string; groupId?: string; monitorRuleId?: string; osFamily?: string };
export type QualityMatch = { ruleKey: string; fingerprint?: string; provider?: string; eventId?: number; levels?: number[]; statusCode?: string; component?: string };
export type QualityBehaviour = { kind: 'suppress' } | { kind: 'downgrade'; severity: 'WARNING' | 'INFO' } | { kind: 'require_count'; minCount: number } | { kind: 'require_repeats'; reports: number };
export type QualityDraft = {
  name: string; description: string; justification: string; scope: QualityScope; match: QualityMatch; behaviour: QualityBehaviour;
  temporary: boolean; expiresAt?: string; reviewAt?: string; allowBroad?: boolean; recommendationId?: string; supersedesId?: string;
};
export type QualityFilters = { businessId?: string; endpointId?: string; monitor?: string; severity?: string; reason?: string; status?: string; reportedBy?: string; from?: string; to?: string; before?: string; limit?: number };
const qp = (q: Record<string, unknown> = {}) => ({ params: Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
export const qualityApi = {
  fpContext: (alertId: string) => api.get(`/monitoring/alerts/${alertId}/false-positive`),
  report: (alertId: string, data: { reason: FpReason; comment?: string; recommendPrevent: boolean; resolve: boolean }) => api.post(`/monitoring/alerts/${alertId}/false-positive`, data),
  summary: (q: QualityFilters) => api.get('/monitoring/quality/summary', qp(q)),
  reports: (q: QualityFilters) => api.get('/monitoring/quality/reports', qp(q)),
  recommendations: (q: QualityFilters) => api.get('/monitoring/quality/recommendations', qp(q)),
  dismiss: (id: string, note: string) => api.post(`/monitoring/quality/recommendations/${id}/dismiss`, { note }),
  preview: (id: string) => api.get(`/monitoring/quality/recommendations/${id}/preview`),
  checks: (q: QualityFilters) => api.get('/monitoring/quality/checks', qp(q)),
  rules: (q: { businessId?: string; status?: string; monitor?: string }) => api.get('/monitoring/quality/rules', qp(q)),
  rule: (id: string) => api.get(`/monitoring/quality/rules/${id}`),
  create: (d: QualityDraft) => api.post('/monitoring/quality/rules', d),
  edit: (id: string, d: Partial<QualityDraft> & { revision: number }) => api.patch(`/monitoring/quality/rules/${id}`, d),
  simulate: (id: string) => api.post(`/monitoring/quality/rules/${id}/simulate`),
  approve: (id: string, revision: number, acceptDangerous: boolean) => api.post(`/monitoring/quality/rules/${id}/approve`, { revision, acceptDangerous }),
  reject: (id: string, note: string) => api.post(`/monitoring/quality/rules/${id}/reject`, { note }),
  rollback: (id: string, note: string) => api.post(`/monitoring/quality/rules/${id}/rollback`, { note }),
};

// Global search (0.33): one route, grouped results. A group the caller may
// not use is null (never an empty list). See docs/technician-guide.md.
export type SearchComputerField = 'hostname' | 'rustdeskId' | 'serialNumber' | 'loggedOnUser' | 'ipAddress' | 'privateIp' | 'alias';
export interface SearchGroup<T> { items: T[]; more: boolean }
export interface SearchResults {
  query: string;
  cap: number;
  groups: {
    computers: SearchGroup<{
      id: string; name: string; hostname: string | null; isOnline: boolean; lastSeenAt: string | null; platform: string | null;
      business: { id: string; name: string | null } | null; site: { id: string; name: string | null } | null;
      match: { field: SearchComputerField; value: string | null } | null;
    }> | null;
    businesses: SearchGroup<{ id: string; name: string; code: string | null; city: string | null; isActive: boolean }> | null;
    sites: SearchGroup<{ id: string; name: string; city: string | null; business: { id: string; name: string } }> | null;
    users: SearchGroup<{ id: string; membershipId: string; name: string | null; email: string; status: string; accessLevel: string; business: { id: string; name: string } | null }> | null;
    alerts: SearchGroup<{
      id: string; title: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; state: string; kind: string; lastSeenAt: string;
      business: { id: string; name: string } | null; computer: { id: string; name: string } | null; site: { id: string; name: string } | null;
    }> | null;
  };
}
export const searchApi = {
  search: (q: string, signal?: AbortSignal) => api.get<{ success: boolean; data: SearchResults }>('/search', { params: { q }, signal }),
};

// Scheduled RustDesk client updates (0.32). Turning a policy on, or removing a
// site override, needs fresh authentication (STEP_UP_REQUIRED); turning it off does not.
export const clientUpdatesApi = {
  policy: (businessId?: string | null) => api.get('/client-updates/policy', bq(businessId)),
  setPolicy: (data: {
    businessId: string; siteId?: string | null; groupId?: string | null; priority?: number | null; enabled: boolean; timeZone: string;
    windows: { days: number[]; start: string; end: string }[]; skipActiveSession: boolean; skipLoggedOnUser: boolean;
    /** 0.36: automatic agent updates here; null inherits, omitted leaves it as it is. */
    agentMode?: 'ANY_TIME' | 'WINDOW' | 'OFF' | null;
  }) => api.put('/client-updates/policy', data),
  /** 0.46: the business page's selector — the business policy's agent mode only (null inherits). Anything but OFF may answer STEP_UP_REQUIRED. */
  setAgentMode: (businessId: string, agentMode: 'ANY_TIME' | 'WINDOW' | 'OFF' | null) => api.put('/client-updates/policy/agent-mode', { businessId, agentMode }),
  removeSiteOverride: (businessId: string, siteId: string) => api.delete(`/client-updates/policy/sites/${siteId}`, bq(businessId)),
  computers: (businessId?: string | null) => api.get('/client-updates/computers', bq(businessId)),
  // 0.35: device-group policies. Removing one needs fresh authentication.
  removeGroupPolicy: (businessId: string, groupId: string) => api.delete(`/client-updates/policy/groups/${groupId}`, bq(businessId)),
  /** The effective policy for one computer, and why (the device page). */
  endpointPolicy: (endpointId: string) => api.get(`/client-updates/computers/${endpointId}/policy`),
};

// Automatic agent self-update (0.36): the platform-wide settings, Platform
// Admin only; a change needs fresh authentication (the step-up dialog).
export type AgentAutoUpdateSettings = {
  enabled: boolean; perHour: number; maxAttempts: number; processOn: boolean;
  /** signedVersion (0.70.1): the release label the published signed agent was last published under. */
  served: { version: string; signedSha256: string | null; signedVersion?: string | null };
  pace: { usedLastHour: number; perHour: number };
  lastDay: { started: number; updated: number; open: number; superseded: number };
  failing: { count: number; computers: { id: string; name: string; business: { id: string; name: string } | null; agentVersion: string | null; versionView?: AgentVersionView; attempts: number; lastAt: string | null }[] };
};
export const agentAutoUpdateApi = {
  get: () => api.get<{ data: AgentAutoUpdateSettings }>('/admin/agent-auto-update'),
  put: (body: { enabled?: boolean; perHour?: number; maxAttempts?: number }) => api.put('/admin/agent-auto-update', body),
};

// Devices → Full agent (0.37): the move to the signed agent, step by step,
// read live (computers:view; counts only of visible computers), and the
// automatic migration's controls (Platform Admin). Turning it on, shortening
// the soak, resuming and restarting need fresh authentication (the
// interceptor prompts and retries); turning it off does not.
// Managed Secure Access readiness (0.69): read-only, computers:view, only
// visible computers. Nothing here changes a computer.
export const msaApi = {
  fleet: (params?: { businessId?: string; state?: string }) => api.get('/msa/readiness', { params }),
  forEndpoint: (endpointId: string) => api.get(`/msa/readiness/${endpointId}`),
};

// Managed Secure Access cutover (0.72, build step 4), behind MSA_GRANTS: every
// route answers 404 MSA_NOT_ENABLED while the switch is off, and the card
// then shows nothing new. Changes are a Platform Admin's, one computer at a
// time; cutover, confirm, the test grant and the reveal need fresh
// authentication (the interceptor prompts and retries); rollback never does.
export const msaManagedApi = {
  view: (endpointId: string) => api.get(`/msa/managed/${endpointId}`),
  cutover: (endpointId: string) => api.post(`/msa/managed/${endpointId}/cutover`),
  testGrant: (endpointId: string) => api.post(`/msa/grants/test/${endpointId}`, { mode: 'view', consent: 'required', maxMinutes: 30, idleMinutes: 10 }),
  reveal: (grantId: string) => api.post(`/msa/managed/grants/${grantId}/reveal`),
  confirm: (endpointId: string) => api.post(`/msa/managed/${endpointId}/confirm`),
  rollback: (endpointId: string, force = false) => api.post(`/msa/managed/${endpointId}/rollback`, force ? { force: true } : {}),
};

// Managed Secure Access sessions (0.73, build step 5), behind MSA_GRANTS like
// the routes above: call these only after an ungated readiness answer said
// `managedControls: true`. Connect on a managed and verified computer issues a
// session grant; the Connect script for it carries the one-time password and
// works once. Disconnect (revoke) never asks for fresh authentication.
export type MsaRevokeBody =
  | { scope: 'sessions'; grantIds: string[] }
  | { scope: 'computer'; endpointId: string }
  | { scope: 'technician'; technicianId: string; businessId?: string }
  | { scope: 'business'; businessId: string };
export const msaSessionsApi = {
  connect: (endpointId: string, mode?: 'view_only' | 'control' | 'unattended') =>
    api.post(`/msa/sessions/connect/${endpointId}`, mode ? { mode } : {}),
  grant: (grantId: string) => api.get(`/msa/sessions/grants/${grantId}`),
  connectScriptUrl: (grantId: string) => `${BASE_URL}/msa/sessions/grants/${grantId}/connect.cmd`,
  forEndpoint: (endpointId: string) => api.get(`/msa/sessions/endpoint/${endpointId}`),
  active: (businessId?: string) => api.get('/msa/sessions/active', { params: businessId ? { businessId } : undefined }),
  revokeGrant: (grantId: string) => api.post(`/msa/sessions/grants/${grantId}/revoke`),
  revoke: (body: MsaRevokeBody) => api.post('/msa/sessions/revoke', body),
};

// Managed Secure Access cutover runs (0.73): a device group or a business,
// canary first, one batch per Advance, never automatic. Platform Admin.
// Start, Advance and Confirm need fresh authentication (the interceptor
// prompts and retries); Halt and Roll back never do.
export const msaCutoverRunsApi = {
  list: () => api.get('/msa/cutover-runs'),
  get: (runId: string) => api.get(`/msa/cutover-runs/${runId}`),
  start: (body: { scope: 'group' | 'business'; businessId: string; groupId?: string; canaryEndpointId?: string; batchSize?: number }) =>
    api.post('/msa/cutover-runs', body),
  advance: (runId: string) => api.post(`/msa/cutover-runs/${runId}/advance`),
  confirm: (runId: string) => api.post(`/msa/cutover-runs/${runId}/confirm`),
  halt: (runId: string) => api.post(`/msa/cutover-runs/${runId}/halt`),
  rollback: (runId: string) => api.post(`/msa/cutover-runs/${runId}/rollback`),
};

export const agentSigningApi = {
  overview: (businessId?: string) => api.get('/agent-signing/overview', { params: businessId ? { businessId } : undefined }),
  putAuto: (body: { mode?: 'off' | 'canary_then_all'; soakMinutes?: number }) => api.put('/admin/agent-auto-migration', body),
  resume: () => api.post('/admin/agent-auto-migration/resume'),
  restart: () => api.post('/admin/agent-auto-migration/restart'),
};

// Outbound email (0.34). Saving the relay, and adding, re-sending or removing
// a recipient, need fresh authentication (the interceptor prompts and retries).
export type TlsMode = 'implicit' | 'starttls' | 'none';
export interface SmtpSettingsView {
  configured: boolean; enabled: boolean; host?: string; port?: number; tlsMode?: TlsMode; username?: string | null; passwordSet?: boolean;
  fromAddress?: string; fromName?: string | null; updatedAt?: string; lastTestAt?: string | null; lastTestResult?: string | null;
  localRelay: 'none' | 'loopback' | 'private'; passwordChange?: string;
}
export interface EmailRecipientView {
  id: string; scopeKey: string; businessId: string | null; address: string; label: string | null; verified: boolean;
  verifiedAt: string | null; lastSentAt: string | null; tokenExpiresAt: string | null; createdAt: string;
}
export const emailApi = {
  status: () => api.get('/email/status'),
  settings: () => api.get('/email/settings'),
  saveSettings: (data: { enabled: boolean; host: string; port: number; tlsMode: TlsMode; username?: string | null; password?: string | null; fromAddress: string; fromName?: string | null }) =>
    api.put('/email/settings', data),
  test: (recipientId?: string) => api.post('/email/settings/test', recipientId ? { recipientId } : {}),
  recipients: (scope: 'global' | 'business', businessId?: string | null) => api.get('/email/recipients', { params: { scope, ...(businessId ? { businessId } : {}) } }),
  addRecipient: (data: { scope: 'global' | 'business'; businessId?: string; address: string; label?: string }) => api.post('/email/recipients', data),
  resend: (id: string) => api.post(`/email/recipients/${id}/resend`),
  removeRecipient: (id: string) => api.delete(`/email/recipients/${id}`),
  verify: (token: string) => api.post('/email/verify', { token }),
};

// AI providers and Ask AI (0.48). Saving the provider or its key needs fresh
// authentication (the interceptor prompts and retries). The key is write-only:
// the settings view says only whether one is set and its last four characters.
export type AiProvider = 'anthropic' | 'openai' | 'openai_compatible';
export type AiAuthStyle = 'bearer' | 'api-key';
export interface AiSettingsView {
  configured: boolean; enabled: boolean; provider: AiProvider | null; providerLabel?: string; model: string | null; baseUrl: string | null;
  authStyle: AiAuthStyle; keySet: boolean; keyLast4: string | null; updatedAt?: string; lastTestAt?: string | null; lastTestResult?: string | null;
  defaults: Record<AiProvider, string>; keyChange?: string;
}
export interface AiStatus { enabled: boolean; provider: AiProvider | null; providerLabel: string | null; model: string | null }
/** What an Ask AI or Create ticket button names: never the entry's text, which the server reads itself. */
export type EntrySource = { source: 'event'; commandId: string; index: number } | { source: 'alert'; alertId: string };
export interface AiAnswer { answer: string; provider: AiProvider; model: string; cached: boolean; redactions: Record<string, number>; askedAt: string }
export const aiApi = {
  settings: () => api.get('/ai/settings'),
  saveSettings: (data: { enabled: boolean; provider: AiProvider; model?: string; baseUrl?: string | null; authStyle?: AiAuthStyle; apiKey?: string | null }) => api.put('/ai/settings', data),
  test: () => api.post('/ai/settings/test'),
  status: () => api.get('/ai/status'),
  explain: (endpointId: string, src: EntrySource) => api.post(`/endpoints/${endpointId}/ai/explain`, src),
  preview: (endpointId: string, src: EntrySource) => api.post(`/endpoints/${endpointId}/ai/preview`, src),
};

// Hardware warranty and support links (0.56).
export type WarrantyStateId = 'expired' | 'expiring_30' | 'expiring_60' | 'expiring_90' | 'active' | 'unknown';
export interface WarrantyView {
  warranty: {
    startsAt: string | null; endsAt: string | null; coverage: string | null; source: string | null; sourceLabel: string | null;
    checkedAt: string | null; state: WarrantyStateId; daysLeft: number | null;
  };
  support: import('./hardware-support').SupportInfo;
  lookup: {
    vendor: import('./hardware-support').LookupVendor | null; vendorLabel: string | null; implemented: boolean; enabled: boolean;
    lastAttemptAt: string | null; lastResult: string | null; intervalDays: number;
  };
  /** 0.61: why there is no date (null when there is one). */
  gap: import('./hardware-support').WarrantyGap | null;
}
export interface WarrantyVendorView {
  vendor: import('./hardware-support').LookupVendor; label: string; enabled: boolean; clientId: string | null; keyId: string | null; secretSet: boolean; secretLast4: string | null;
  updatedAt: string | null; lastResultAt: string | null; lastResult: string | null; keyChange?: string;
}
export interface WarrantySettingsView {
  vendors: WarrantyVendorView[]; manualOnly: { vendor: string; label: string; reason: string }[];
  sweep: { enabled: boolean; perHour: number; intervalDays: number };
}
export const warrantyApi = {
  get: (endpointId: string) => api.get(`/endpoints/${endpointId}/warranty`),
  set: (endpointId: string, body: { startsAt?: string | null; endsAt: string | null; coverage?: string | null }) => api.put(`/endpoints/${endpointId}/warranty`, body),
  lookup: (endpointId: string) => api.post(`/endpoints/${endpointId}/warranty/lookup`, {}),
  settings: () => api.get('/warranty/settings'),
  saveVendor: (vendor: import('./hardware-support').LookupVendor, body: { enabled: boolean; clientId?: string | null; keyId?: string | null; secret?: string | null }) => api.put(`/warranty/settings/${vendor}`, body),
  report: (params: Record<string, string>) => api.get('/reports/warranty', { params }),
};

// PSA tickets (0.48). Connector writes need fresh authentication.
export type PsaKind = 'email' | 'webhook' | 'clientst0r';
export interface PsaConnectorView {
  id: string; scopeKey: string; kind: PsaKind; kindLabel: string; enabled: boolean; label: string | null; updatedAt: string;
  emailRecipientId?: string | null; address?: string | null; confirmed?: boolean;
  webhookHost?: string | null; webhookUrlSet?: boolean; signed?: boolean; integrationConfigured?: boolean;
}
export interface PsaScopeView {
  scopeKey: string; businessId: string | null; name: string; connector: PsaConnectorView | null;
  platformDefault: { kind: PsaKind; kindLabel: string; enabled: boolean } | null; kinds: { kind: PsaKind; label: string }[];
}
export interface PsaTicketRow { id: string; sourceRef: string; fingerprint: string; connectorKind: PsaKind; ref: string | null; url: string | null; createdAt: string }
export interface PsaTicketStatus {
  available: boolean; reason: string | null; canCreate: boolean; requires: string[];
  connector: { kind: PsaKind; kindLabel: string; label: string | null; scope: 'business' | 'global' } | null; tickets: PsaTicketRow[];
}
export interface PsaTicketResult { id: string; ref: string | null; url: string | null; connectorKind: PsaKind; kindLabel: string; status: string; sourceRef: string; aiIncluded: boolean; createdAt: string }
export const psaApi = {
  connector: (scope: 'global' | 'business', businessId?: string | null) => api.get('/psa/connectors', { params: { scope, ...(businessId ? { businessId } : {}) } }),
  saveConnector: (data: { scope: 'global' | 'business'; businessId?: string; kind: PsaKind; enabled: boolean; label?: string | null; emailRecipientId?: string; webhookUrl?: string; webhookSecret?: string | null }) =>
    api.put('/psa/connectors', data),
  removeConnector: (scope: 'global' | 'business', businessId?: string | null) => api.delete('/psa/connectors', { params: { scope, ...(businessId ? { businessId } : {}) } }),
  ticketStatus: (endpointId: string) => api.get(`/endpoints/${endpointId}/tickets`),
  draft: (endpointId: string, src: EntrySource) => api.post(`/endpoints/${endpointId}/tickets/draft`, src),
  create: (endpointId: string, data: EntrySource & { subject?: string; note?: string; includeAi?: boolean }) => api.post(`/endpoints/${endpointId}/tickets`, data),
};

// Scheduled reports (0.34). Creating or changing one needs fresh authentication.
export type ScheduledReportKey = 'patch-compliance' | 'agent-coverage' | 'alert-frequency' | 'offline-time';
export interface ReportScheduleInput {
  report: ScheduledReportKey; businessId?: string | null; siteId?: string | null; silentDays?: number;
  frequency: 'weekly' | 'monthly'; dayOfWeek?: number | null; dayOfMonth?: number | null; time: string; timeZone: string;
  attachCsv: boolean; recipientIds: string[]; enabled?: boolean;
}
export const reportSchedulesApi = {
  list: (businessId?: string | null) => api.get('/reports/schedules', bq(businessId)),
  create: (data: ReportScheduleInput) => api.post('/reports/schedules', data),
  update: (id: string, data: Partial<ReportScheduleInput>) => api.patch(`/reports/schedules/${id}`, data),
  remove: (id: string) => api.delete(`/reports/schedules/${id}`),
};

// API keys for the public API (/api/v1/pub/v1, docs/PUBLIC-API.md). The raw key is returned once, at creation.
export const API_KEY_SCOPES = [
  'companies:read', 'companies:write', 'users:read', 'users:write',
  'computers:read', 'computers:write', 'sessions:read', 'enrollment:write', 'audit:read',
] as const;
export const apiKeysApi = {
  list: (businessId?: string | null) => api.get('/apikeys', bq(businessId)),
  create: (data: { name: string; scopes: string[]; expiresInDays?: number; businessId?: string }) => api.post('/apikeys', data),
  revoke: (id: string) => api.delete(`/apikeys/${id}`),
};

// Script library: write, version, diff and review. There is no run call —
// scripts cannot be run from the portal (docs/script-library.md).
export type ScriptParameter =
  | { name: string; type: 'string'; description?: string; required: boolean; charset: 'alphanumeric' | 'identifier' | 'hostname' | 'safe_text'; maxLength: number }
  | { name: string; type: 'integer'; description?: string; required: boolean; min: number; max: number }
  | { name: string; type: 'boolean'; description?: string; required: boolean }
  | { name: string; type: 'choice'; description?: string; required: boolean; choices: string[] };
export type ScriptRisk = 'low' | 'medium' | 'high';
export interface ScriptVersionInput { description: string; risk: ScriptRisk; parameters: ScriptParameter[]; content: string }
export const scriptsApi = {
  list: (businessId?: string | null) => api.get('/scripts', bq(businessId)),
  get: (id: string) => api.get(`/scripts/${id}`),
  version: (id: string, version: number) => api.get(`/scripts/${id}/versions/${version}`),
  diff: (id: string, from: number, to: number) => api.get(`/scripts/${id}/diff`, { params: { from, to } }),
  create: (data: ScriptVersionInput & { scope: 'global' | 'business'; businessId?: string; name: string }) => api.post('/scripts', data),
  newVersion: (id: string, data: ScriptVersionInput & { basedOnVersion: number }) => api.post(`/scripts/${id}/versions`, data),
  submit: (id: string, version: number) => api.post(`/scripts/${id}/versions/${version}/submit`),
  withdraw: (id: string, version: number) => api.post(`/scripts/${id}/versions/${version}/withdraw`),
  review: (id: string, version: number, data: { decision: 'approve' | 'reject'; expectedSha256: string; note: string }) =>
    api.post(`/scripts/${id}/versions/${version}/review`, data),
};

// Running an approved library version (0.34). The portal proposes a version to
// the approval signer's own allowlist and requests runs; it cannot add to the
// allowlist or approve a run — both happen on the approval signer's page.
export type ScriptArgument = string | number | boolean;
export const scriptRunsApi = {
  readiness: (versionId: string) => api.get(`/script-runs/versions/${versionId}`),
  propose: (versionId: string) => api.post(`/script-runs/versions/${versionId}/allowlist`),
  revoke: (versionId: string, reason: string) => api.post(`/script-runs/versions/${versionId}/allowlist/revoke`, { reason }),
  run: (data: { scriptVersionId: string; endpointIds: string[]; parameters: Record<string, ScriptArgument>; timeoutMinutes: number; reason: string; windowHours?: number; schedule?: { local: string; timeZone: string } }) =>
    api.post('/script-runs', data),
};

// ─── v0.58: automation schedules (docs/automation.md) ───────────────────────
// Proposed here, approved on the approval signer with passkeys (or, in direct
// mode, active at once), and every run signed there under the policy. There
// is no approve route. Create, resume and revoke ask for a fresh sign-in
// (automation.policy); pause never does.
export type AutomationRecurrenceInput =
  | { kind: 'hourly'; everyHours: number; minute: number; windowMinutes: number; timezone: string }
  | PolicyWindowInputLite;
type PolicyWindowInputLite =
  | { days: string[]; start: string; end: string; timezone: string }
  | { kind: 'monthly'; week: string; weekday: string; offsetDays: number; start: string; end: string; timezone: string }
  | { kind: 'monthly'; day: number; start: string; end: string; timezone: string };
export type AutomationOfflineInput = { mode: 'run_when_online' } | { mode: 'skip_if_offline' } | { mode: 'expire_after'; hours: number };
export interface AutomationCreateInput {
  businessId: string; name: string; reason: string;
  task: { kind: 'script'; scriptVersionId: string; parameters: Record<string, ScriptArgument>; timeoutMinutes: number } | { kind: 'software'; entryId: string; operation: 'install' | 'uninstall' };
  targets: { kind: 'computers'; endpointIds: string[] } | { kind: 'group'; groupId: string; maxTargets: number };
  recurrence: AutomationRecurrenceInput; offline: AutomationOfflineInput; maxRunsPerOccurrence: number; supersedes?: string;
}
export const automationApi = {
  list: (businessId?: string | null) => api.get('/automation/schedules', bq(businessId)),
  get: (id: string) => api.get(`/automation/schedules/${id}`),
  create: (body: AutomationCreateInput) => api.post('/automation/schedules', body),
  preview: (body: { recurrence: AutomationRecurrenceInput }) => api.post('/automation/schedules/preview', body),
  pause: (id: string, reason: string) => api.post(`/automation/schedules/${id}/pause`, { reason }),
  resume: (id: string) => api.post(`/automation/schedules/${id}/resume`),
  revoke: (id: string, reason: string) => api.post(`/automation/schedules/${id}/revoke`, { reason }),
  groups: (businessId: string) => api.get('/device-groups', { params: { businessId } }),
};

// Restart windows (0.60): a business's, a device group's and one computer's.
// Setting a window, or removing a group's or computer's own setting (so it
// inherits one), needs fresh authentication (restart.window; the interceptor
// prompts and retries). "No automatic restarts" and removing a business's
// window never do. A window is approved on the approval signer, never here.
export type RestartWindowBody =
  | { mode: 'window'; rule: 'if_required' | 'always'; window: PolicyWindowInput; ignoreRemoteSession?: true; priority?: number; reason?: string }
  | { mode: 'off'; priority?: number; reason?: string };
export const restartWindowsApi = {
  business: (businessId: string) => api.get(`/restart-windows/businesses/${encodeURIComponent(businessId)}`),
  setBusiness: (businessId: string, body: RestartWindowBody) => api.put(`/restart-windows/businesses/${encodeURIComponent(businessId)}`, body),
  clearBusiness: (businessId: string) => api.delete(`/restart-windows/businesses/${encodeURIComponent(businessId)}`, { data: {} }),
  setGroup: (businessId: string, groupId: string, body: RestartWindowBody) => api.put(`/restart-windows/businesses/${encodeURIComponent(businessId)}/groups/${encodeURIComponent(groupId)}`, body),
  clearGroup: (businessId: string, groupId: string) => api.delete(`/restart-windows/businesses/${encodeURIComponent(businessId)}/groups/${encodeURIComponent(groupId)}`, { data: {} }),
  computer: (endpointId: string) => api.get(`/restart-windows/computers/${encodeURIComponent(endpointId)}`),
  setComputer: (endpointId: string, body: RestartWindowBody) => api.put(`/restart-windows/computers/${encodeURIComponent(endpointId)}`, body),
  clearComputer: (endpointId: string) => api.delete(`/restart-windows/computers/${encodeURIComponent(endpointId)}`, { data: {} }),
  bulk: (endpointIds: string[], mode: 'off' | 'inherit') => api.post('/restart-windows/computers/bulk', { endpointIds, mode }),
};
