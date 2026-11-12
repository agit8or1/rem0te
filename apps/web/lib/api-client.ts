import axios from 'axios';

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
// on the approval signer's own origin, with a passkey on its roster.
export const actionsApi = {
  catalog: () => api.get('/actions/catalog'),
  list: (endpointId: string) => api.get(`/endpoints/${endpointId}/actions`),
  request: (endpointId: string, body: { actionId: string; version: number; params: Record<string, unknown>; reason: string; windowHours?: number }) =>
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
  create: (body: { businessId: string; name: string; updates: UpdateIdentity[]; rings: string[][]; soakHours: number; failureThreshold: number; windowHours: number; reboot?: 'never' | 'if_required_in_window' }) =>
    api.post('/patching/deployments', body),
  requestRing: (id: string, ring: number, body: { reason: string; startsInMinutes?: number; exclude?: { endpointId: string; why: string }[] }) =>
    api.post(`/patching/deployments/${id}/rings/${ring}/request`, body),
  pause: (id: string, reason: string) => api.post(`/patching/deployments/${id}/pause`, { reason }),
  resume: (id: string, reason: string) => api.post(`/patching/deployments/${id}/resume`, { reason }),
  cancel: (id: string, reason: string) => api.post(`/patching/deployments/${id}/cancel`, { reason }),
  // 0.32. "Install updates" builds a one-computer deployment; its canary
  // still needs two approvals on the approval signer.
  install: (endpointId: string, body: { updates: UpdateIdentity[]; reboot: 'never' | 'if_required_in_window'; reason: string; windowHours: number }) =>
    api.post(`/endpoints/${endpointId}/patches/install`, body),
  preflight: () => api.get('/patching/preflight'),
  policies: (businessId: string) => api.get('/patching/policies', { params: { businessId } }),
  policy: (id: string) => api.get(`/patching/policies/${id}`),
  // Creating and revoking need a fresh sign-in (the interceptor prompts).
  createPolicy: (body: PatchPolicyInput) => api.post('/patching/policies', body),
  revokePolicy: (id: string, reason: string) => api.post(`/patching/policies/${id}/revoke`, { reason }),
};

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
  requestRing: (id: string, ring: number, body: { reason: string; startsInMinutes?: number; exclude?: { endpointId: string; why: string }[] }) =>
    api.post(`/software/deployments/${id}/rings/${ring}/request`, body),
  pause: (id: string, reason: string) => api.post(`/software/deployments/${id}/pause`, { reason }),
  resume: (id: string, reason: string) => api.post(`/software/deployments/${id}/resume`, { reason }),
  cancel: (id: string, reason: string) => api.post(`/software/deployments/${id}/cancel`, { reason }),
  endpoint: (endpointId: string) => api.get(`/endpoints/${endpointId}/software/catalog`),
  // One computer: a one-ring deployment; the returned job carries the approval link.
  single: (endpointId: string, entryId: string, operation: 'install' | 'uninstall', body: { reason: string; windowHours: number; startsInMinutes?: number }) =>
    api.post(`/endpoints/${endpointId}/software/${entryId}/${operation}`, body),
  // The report (report-kit's useReport/ExportButton call the same two routes).
  compliance: (params: Record<string, string>) => api.get('/reports/software-compliance', { params }),
  complianceCsv: (params: Record<string, string>) => api.get('/reports/software-compliance/export.csv', { params, responseType: 'blob' }),
};

export interface PatchPolicyInput {
  businessId: string; name: string; rings: string[][];
  allow: { classifications: string[]; severities?: string[]; excludeKbs?: string[] };
  soakHours: number; failureThreshold: number;
  window: { days: string[]; start: string; end: string; timezone: string };
  reboot: 'never' | 'if_required_in_window'; expiresInDays: number; reason: string;
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
  // Queues a re-collection for the endpoint's next heartbeat — up to ~3
  // minutes away. Nothing is synchronous here.
  refreshInventory: (id: string) => api.post(`/endpoints/${id}/inventory/refresh`, {}),
  // Re-runs the installer on the machine: upgrades the Rem0te agent while
  // keeping its config, password and enrolment. The only way to refresh the
  // agent on a computer whose RustDesk client is already current.
  reinstallAgent: (id: string) => api.post(`/endpoints/${id}/reinstall-agent`, {}),
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
  assignDevice: (id: string, businessId: string) =>
    api.post(`/admin/unassigned-devices/${id}/assign`, { businessId }),
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
export const securityApi = {
  getConfig: () => api.get('/admin/security/config'),
  updateConfig: (data: Record<string, unknown>) => api.patch('/admin/security/config', data),
  getFail2ban: () => api.get('/admin/security/fail2ban'),
  unbanIp: (jail: string, ip: string) => api.post('/admin/security/fail2ban/unban', { jail, ip }),
  banIp: (jail: string, ip: string) => api.post('/admin/security/fail2ban/ban', { jail, ip }),
  getIgnoreList: () => api.get('/admin/security/fail2ban/ignore'),
  addIgnoreIp: (ip: string) => api.post('/admin/security/fail2ban/ignore', { ip }),
  removeIgnoreIp: (ip: string) => api.delete(`/admin/security/fail2ban/ignore/${encodeURIComponent(ip)}`),
  getJailConfig: (jail: string) => api.get(`/admin/security/fail2ban/jail/${jail}/config`),
  updateJailConfig: (jail: string, cfg: { bantime?: number; findtime?: number; maxretry?: number }) => api.patch(`/admin/security/fail2ban/jail/${jail}/config`, cfg),
  installFail2ban: () => api.post('/admin/security/fail2ban/install'),
  getOsUpdates: () => api.get('/admin/security/os-updates'),
  runOsUpdate: () => api.post('/admin/security/os-updates/run'),
  getOsUpdateStatus: () => api.get('/admin/security/os-updates/status'),
  runAudit: () => api.get('/admin/security/audit'),
  runAuditFix: (force = false) => api.post('/admin/security/audit/fix', { force }),
  getTls: () => api.get('/admin/security/tls'),
  renewTls: () => api.post('/admin/security/tls/renew'),
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
export type ContainmentKind = 'actions' | 'remote' | 'updates' | 'integration';
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
export type MonitorScope = 'global' | 'business' | 'site' | 'endpoint';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type MonitorKindId = 'OFFLINE' | 'DISK_FREE' | 'CPU_HIGH' | 'MEMORY_HIGH' | 'SERVICE_STOPPED' | 'EVENT_MATCH' | 'REBOOT_PENDING';
const bq = (businessId?: string | null) => ({ params: businessId ? { businessId } : {} });
export const monitoringApi = {
  summary: (businessId?: string | null) => api.get('/monitoring/summary', bq(businessId)),
  alerts: (q: { state?: string; severity?: string; endpointId?: string; kind?: string; before?: string; limit?: number; businessId?: string | null }) => {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') params[k] = v as string | number;
    return api.get('/monitoring/alerts', { params });
  },
  alert: (id: string, businessId?: string | null) => api.get(`/monitoring/alerts/${id}`, bq(businessId)),
  acknowledge: (id: string, note?: string) => api.post(`/monitoring/alerts/${id}/acknowledge`, note ? { note } : {}),
  resolve: (id: string, note: string) => api.post(`/monitoring/alerts/${id}/resolve`, { note }),
  rules: (businessId?: string | null) => api.get('/monitoring/rules', bq(businessId)),
  createRule: (data: { scope: MonitorScope; businessId?: string; siteId?: string; endpointId?: string; key: string; kind: MonitorKindId; name: string; enabled?: boolean; severity: Severity; params: Record<string, unknown> }) =>
    api.post('/monitoring/rules', data),
  addRecommended: (scope: 'global' | 'business', businessId?: string) => api.post('/monitoring/rules/recommended', businessId ? { scope, businessId } : { scope }),
  updateRule: (id: string, data: { name?: string; enabled?: boolean; severity?: Severity; params?: Record<string, unknown> }) => api.patch(`/monitoring/rules/${id}`, data),
  deleteRule: (id: string) => api.delete(`/monitoring/rules/${id}`),
  suppressions: (businessId?: string | null) => api.get('/monitoring/suppressions', bq(businessId)),
  createSuppression: (data: { scope: MonitorScope; businessId?: string; siteId?: string; endpointId?: string; ruleKeys: string[]; reason: string; startsAt?: string; endsAt: string }) =>
    api.post('/monitoring/suppressions', data),
  revokeSuppression: (id: string) => api.post(`/monitoring/suppressions/${id}/revoke`),
  policy: (businessId?: string | null) => api.get('/monitoring/notify-policy', bq(businessId)),
  setPolicy: (data: { scope: 'global' | 'business'; businessId?: string; levels: { afterMinutes: number; minSeverity: Severity; destinations: { label: string; url: string }[] }[]; ticketing: { enabled: boolean; minSeverity: Severity } }) =>
    api.put('/monitoring/notify-policy', data),
  endpoint: (id: string) => api.get(`/monitoring/endpoints/${id}`),
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
    businessId: string; siteId?: string | null; enabled: boolean; timeZone: string;
    windows: { days: number[]; start: string; end: string }[]; skipActiveSession: boolean; skipLoggedOnUser: boolean;
  }) => api.put('/client-updates/policy', data),
  removeSiteOverride: (businessId: string, siteId: string) => api.delete(`/client-updates/policy/sites/${siteId}`, bq(businessId)),
  computers: (businessId?: string | null) => api.get('/client-updates/computers', bq(businessId)),
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
  run: (data: { scriptVersionId: string; endpointIds: string[]; parameters: Record<string, ScriptArgument>; timeoutMinutes: number; reason: string; windowHours?: number }) =>
    api.post('/script-runs', data),
};
