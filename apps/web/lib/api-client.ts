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
  switchTenant: (tenantId: string) => api.post('/auth/switch-tenant', { tenantId }),
  profile: () => api.get('/auth/profile'),
  updateProfile: (data: { firstName?: string; lastName?: string; email?: string }) =>
    api.patch('/auth/profile', data),
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
  stats: () => api.get('/dashboard'),
  platformStats: () => api.get('/dashboard/platform'),
};

// ─── Endpoints ───────────────────────────────────────────────────────────────
export const endpointsApi = {
  list: (params?: Record<string, string>) =>
    api.get('/endpoints', { params }),
  get: (id: string) => api.get(`/endpoints/${id}`),
  create: (data: Record<string, unknown>) => api.post('/endpoints', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/endpoints/${id}`, data),
  archive: (id: string) => api.patch(`/endpoints/${id}/archive`),
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

// ─── Customers ───────────────────────────────────────────────────────────────
export const customersApi = {
  list: (params?: Record<string, string>) => api.get('/customers', { params }),
  get: (id: string) => api.get(`/customers/${id}`),
  create: (data: Record<string, unknown>) => api.post('/customers', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/customers/${id}`, data),
  archive: (id: string) => api.patch(`/customers/${id}/archive`),
  sites: (id: string) => api.get(`/customers/${id}/sites`),
  invitePortalUser: (id: string, data: Record<string, unknown>) => api.post(`/customers/${id}/portal/invite`, data),
  togglePortal: (id: string, enabled: boolean) => api.patch(`/customers/${id}/portal`, { enabled }),
  listPortalUsers: (id: string) => api.get(`/customers/${id}/portal/users`),
};

// ─── Sites ───────────────────────────────────────────────────────────────────
export const sitesApi = {
  list: (customerId?: string) =>
    api.get('/sites', { params: customerId ? { customerId } : {} }),
  get: (id: string) => api.get(`/sites/${id}`),
  create: (data: Record<string, unknown>) => api.post('/sites', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/sites/${id}`, data),
  delete: (id: string) => api.delete(`/sites/${id}`),
};

// ─── Users / Members ─────────────────────────────────────────────────────────
export const usersApi = {
  listMembers: (tenantId: string) => api.get(`/tenants/${tenantId}/members`),
  invite: (tenantId: string, data: Record<string, unknown>) =>
    api.post(`/tenants/${tenantId}/invite`, data),
  assignRole: (tenantId: string, userId: string, roleId: string) =>
    api.patch(`/tenants/${tenantId}/members/${userId}/role`, { roleId }),
  listRoles: (tenantId: string) => api.get(`/tenants/${tenantId}/roles`),
  suspend: (_tenantId: string, userId: string) =>
    api.patch(`/users/${userId}/suspend`),
  activate: (_tenantId: string, userId: string) =>
    api.patch(`/users/${userId}/activate`),
  updateProfile: (userId: string, data: { firstName?: string; lastName?: string; email?: string }) =>
    api.patch(`/users/${userId}`, data),
  resetPassword: (userId: string, password: string) =>
    api.post(`/users/${userId}/reset-password`, { password }),
  changeRole: (userId: string, roleId: string) =>
    api.patch(`/users/${userId}/role`, { roleId }),
  remove: (userId: string) =>
    api.delete(`/users/${userId}`),
  resetMfa: (userId: string) =>
    api.post(`/users/${userId}/mfa/reset`),
  listPlatformAdmins: () =>
    api.get('/users/platform-admins'),
  findByEmail: (email: string) =>
    api.get('/users/find', { params: { email } }),
  setPlatformAdmin: (userId: string, enabled: boolean) =>
    api.patch(`/users/${userId}/platform-admin`, { enabled }),
};

// ─── Tenants ─────────────────────────────────────────────────────────────────
export const tenantsApi = {
  list: () => api.get('/tenants'),
  get: (id: string) => api.get(`/tenants/${id}`),
  create: (data: Record<string, unknown>) => api.post('/tenants', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/tenants/${id}`, data),
  updateBranding: (id: string, data: Record<string, unknown>) =>
    api.patch(`/tenants/${id}/branding`, data),
  uploadLogo: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/tenants/${id}/branding/logo`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  updateSettings: (id: string, data: Record<string, unknown>) =>
    api.patch(`/tenants/${id}/settings`, data),
  listMembers: (id: string) => api.get(`/tenants/${id}/members`),
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
};

// ─── Update ───────────────────────────────────────────────────────────────────
export const updateApi = {
  version: () => api.get('/admin/update/version'),
  check: () => api.get('/admin/update/check'),
  changelog: () => api.get('/admin/update/changelog'),
  progressUrl: () => `${BASE_URL}/admin/update/progress`,
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

// ─── Portal (customer-facing) ─────────────────────────────────────────────
export const portalApi = {
  me: () => api.get('/portal/me'),
  endpoints: () => api.get('/portal/endpoints'),
  sessions: () => api.get('/portal/sessions'),
  requestSupport: (data: Record<string, unknown>) => api.post('/portal/request-support', data),
  connect: (endpointId: string) => api.post('/portal/connect', { endpointId }),
};

// ─── Notes ───────────────────────────────────────────────────────────────────
export const notesApi = {
  list: (params: Record<string, string>) => api.get('/notes', { params }),
  create: (data: Record<string, unknown>) => api.post('/notes', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/notes/${id}`, data),
  delete: (id: string) => api.delete(`/notes/${id}`),
};
