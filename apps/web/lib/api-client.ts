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
    if (typeof window !== 'undefined' && error?.response?.status === 401) {
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
    timeZone?: string;
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
  // { rustdeskId, password, grantToken, launchUri }.
  connect: (id: string) => api.post(`/endpoints/${id}/connect`),
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
  generateTimeline: (id: string) => api.post(`/endpoints/${id}/timeline/generate`),
  saveTimeline: (id: string, aiTimeline: string) => api.patch(`/endpoints/${id}`, { aiTimeline }),
  getPassword: (id: string) => api.get(`/endpoints/${id}/password`),
  setPassword: (id: string, password: string | null) => api.patch(`/endpoints/${id}/password`, { password }),
  addTag: (id: string, tag: string) => api.post(`/endpoints/${id}/tags`, { tag }),
  removeTag: (id: string, tag: string) => api.delete(`/endpoints/${id}/tags/${encodeURIComponent(tag)}`),
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
  revokeToken: (id: string) => api.delete(`/enrollment/tokens/${id}`),
};

// ─── Admin ────────────────────────────────────────────────────────────────────
export const adminApi = {
  status: () => api.get('/admin/status'),
  listUnassigned: () => api.get('/admin/unassigned-devices'),
  assignDevice: (id: string, businessId: string) =>
    api.post(`/admin/unassigned-devices/${id}/assign`, { businessId }),
  /** Global search — scoped to the caller's business unless Platform Admin. */
  search: (q: string) => api.get('/admin/search', { params: { q } }),
};

// ─── Update ───────────────────────────────────────────────────────────────────
// ─── Technician client downloads ──────────────────────────────────────────
// Authenticated, unlike the Quick Connect downloads: these are for the people
// doing the supporting, not the person being helped.
export const downloadsApi = {
  manifest: () => api.get('/downloads'),
};

export const updateApi = {
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
