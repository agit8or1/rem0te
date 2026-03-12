// Shared TypeScript types for Reboot Remote
// Used across apps/api and apps/web

export type RoleType =
  | 'PLATFORM_ADMIN'
  | 'TENANT_OWNER'
  | 'TENANT_ADMIN'
  | 'TECHNICIAN'
  | 'BILLING_ADMIN'
  | 'READ_ONLY';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'INVITED' | 'PENDING_MFA' | 'DELETED';

export type SessionStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';

export type EndpointStatus = 'ACTIVE' | 'ARCHIVED' | 'MAINTENANCE';

export type NoteVisibility = 'INTERNAL' | 'CUSTOMER';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: UserStatus;
  isPlatformAdmin: boolean;
  createdAt: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  settings?: TenantSettings;
  branding?: TenantBranding;
}

export interface TenantSettings {
  requireMfa: boolean;
  sessionTimeoutMinutes: number;
  passwordMinLength: number;
  allowPasswordReset: boolean;
  rustdeskRelayHost: string | null;
  rustdeskPublicKey: string | null;
}

export interface TenantBranding {
  portalTitle: string;
  logoUrl: string | null;
  accentColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
  footerText: string | null;
}

export interface Endpoint {
  id: string;
  tenantId: string;
  name: string;
  hostname: string | null;
  rustdeskId: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  status: EndpointStatus;
  isOnline: boolean;
  lastSeenAt: string | null;
  customerId: string | null;
  siteId: string | null;
  createdAt: string;
}

export interface SupportSession {
  id: string;
  tenantId: string;
  technicianId: string;
  endpointId: string | null;
  adHocRustdeskId: string | null;
  isAdHoc: boolean;
  contactName: string | null;
  contactEmail: string | null;
  issueDescription: string | null;
  status: SessionStatus;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  notes: string | null;
  disposition: string | null;
  createdAt: string;
}

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  isArchived: boolean;
  createdAt: string;
}

export interface Site {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface ActivityLog {
  id: string;
  tenantId: string | null;
  action: string;
  actorId: string | null;
  actorIp: string | null;
  resource: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
