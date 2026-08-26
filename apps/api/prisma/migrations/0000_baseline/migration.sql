-- Baseline: the full schema as of v0.8.2.
--
-- The migration history began at 0001, which ALTERs tables nothing in the
-- history ever created — the original schema was produced with `prisma db
-- push` and never captured. `prisma migrate deploy` therefore failed on any
-- empty database, so a fresh install could not be provisioned from migrations.
--
-- Existing deployments must NOT run this. Mark it applied instead:
--   npx prisma migrate resolve --applied 0000_baseline
-- install.sh does this automatically for databases that already have tables.
--
-- `updatedAt` carries DEFAULT CURRENT_TIMESTAMP here even though Prisma's
-- @updatedAt does not emit one: later migrations INSERT rows in raw SQL
-- without supplying it (0009's PlatformSettings singleton), and those inserts
-- fail against a column with no default. Prisma always sets the value
-- explicitly, so the default only ever applies to raw SQL.

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "MfaMethodType" AS ENUM ('TOTP', 'RECOVERY_CODE', 'WEBAUTHN');

-- CreateEnum
CREATE TYPE "RoleType" AS ENUM ('PLATFORM_ADMIN', 'BUSINESS_OWNER', 'BUSINESS_USER', 'TENANT_OWNER', 'TENANT_ADMIN', 'TECHNICIAN', 'BILLING_ADMIN', 'READ_ONLY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "EndpointStatus" AS ENUM ('ACTIVE', 'OFFLINE', 'ARCHIVED', 'PENDING_ENROLLMENT');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'CLAIMED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PENDING', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED', 'SESSION_STARTED', 'SESSION_COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "NoteVisibility" AS ENUM ('INTERNAL', 'CUSTOMER_VISIBLE');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'MFA_ENROLLED', 'MFA_RESET', 'MFA_VERIFIED', 'RECOVERY_CODE_USED', 'PASSWORD_CHANGED', 'USER_CREATED', 'USER_UPDATED', 'USER_SUSPENDED', 'USER_DELETED', 'USER_INVITED', 'ROLE_ASSIGNED', 'ROLE_REVOKED', 'ROLE_CHANGED', 'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_ARCHIVED', 'SITE_CREATED', 'SITE_UPDATED', 'SITE_DELETED', 'ENDPOINT_CREATED', 'ENDPOINT_UPDATED', 'ENDPOINT_ARCHIVED', 'ENDPOINT_CLAIMED', 'ENDPOINT_ENROLLED', 'ENDPOINT_UNASSIGNED', 'ENDPOINT_ACCESS_GRANTED', 'ENDPOINT_ACCESS_REVOKED', 'ENDPOINT_CREDENTIAL_ROTATION_STAGED', 'ENDPOINT_CREDENTIAL_ROTATED', 'CONNECTION_GRANT_CREATED', 'CONNECTION_GRANT_REDEEMED', 'CONNECTION_GRANT_DENIED', 'SESSION_LAUNCHED', 'SESSION_COMPLETED', 'SESSION_CANCELED', 'LAUNCHER_TOKEN_ISSUED', 'LAUNCHER_TOKEN_USED', 'NOTE_CREATED', 'NOTE_UPDATED', 'NOTE_DELETED', 'NOTE_COMMENT_ADDED', 'ENDPOINT_PASSWORD_REVEALED', 'RECOVERY_CODE_BLOCKED', 'RECOVERY_CODE_LOCKOUT', 'BRANDING_UPDATED', 'SETTINGS_UPDATED', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'TENANT_CREATED', 'TENANT_UPDATED', 'CLAIM_TOKEN_CREATED', 'INVITATION_SENT', 'BUSINESS_CREATED', 'BUSINESS_UPDATED', 'BUSINESS_DISABLED', 'BUSINESS_DELETED', 'USER_CAPABILITIES_UPDATED', 'PLATFORM_SETTINGS_UPDATED', 'QUICK_CONNECT_INITIATED', 'QUICK_CONNECT_ENDED', 'QUICK_CONNECT_DENIED', 'QUICK_CONNECT_SETTING_CHANGED');

-- CreateEnum
CREATE TYPE "EndpointAccessMode" AS ENUM ('ASSIGNED_USERS', 'COMPANY_WIDE');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requireMfa" BOOLEAN NOT NULL DEFAULT false,
    "allowPasswordReset" BOOLEAN NOT NULL DEFAULT true,
    "sessionTimeoutMinutes" INTEGER NOT NULL DEFAULT 480,
    "maxSessionsPerUser" INTEGER NOT NULL DEFAULT 5,
    "passwordMinLength" INTEGER NOT NULL DEFAULT 12,
    "passwordRequireMixed" BOOLEAN NOT NULL DEFAULT true,
    "passwordRequireSpecial" BOOLEAN NOT NULL DEFAULT true,
    "rustdeskRelayHost" TEXT,
    "rustdeskRelayPort" INTEGER,
    "rustdeskPublicKey" TEXT,
    "showDownloadPage" BOOLEAN NOT NULL DEFAULT true,
    "allowCustomerPortal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantBranding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "portalTitle" TEXT NOT NULL DEFAULT 'Remote Support Portal',
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#3B82F6',
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "footerText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "jobTitle" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "timeZone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMfaMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MfaMethodType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totpSecret" TEXT,
    "codeHash" TEXT,
    "usedAt" TIMESTAMP(3),
    "credentialId" TEXT,
    "publicKey" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMfaMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "type" "RoleType" NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customerId" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "domain" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "portalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quickConnectEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postalCode" TEXT,
    "timezone" TEXT,
    "notes" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Endpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "siteId" TEXT,
    "endpointGroupId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "EndpointStatus" NOT NULL DEFAULT 'PENDING_ENROLLMENT',
    "hostname" TEXT,
    "platform" TEXT,
    "osVersion" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "serialNumber" TEXT,
    "isManaged" BOOLEAN NOT NULL DEFAULT false,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "accessMode" "EndpointAccessMode" NOT NULL DEFAULT 'ASSIGNED_USERS',
    "aiTimeline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputerAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ComputerAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndpointGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndpointTag" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "EndpointTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndpointAlias" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RustdeskNode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "endpointId" TEXT NOT NULL,
    "rustdeskId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "platform" TEXT,
    "version" TEXT,
    "hostname" TEXT,
    "publicKey" TEXT,
    "permanentPassword" TEXT,
    "pendingPassword" TEXT,
    "pendingPasswordAt" TIMESTAMP(3),
    "updateRequestedAt" TIMESTAMP(3),
    "updateTargetVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RustdeskNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByIp" TEXT,
    "createdByIp" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'REMOTE_ACCESS',

    CONSTRAINT "ConnectionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceClaimToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpointId" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedByIp" TEXT,
    "customerName" TEXT,
    "siteName" TEXT,
    "description" TEXT,
    "customerId" TEXT,
    "accessMode" "EndpointAccessMode" NOT NULL DEFAULT 'ASSIGNED_USERS',
    "assignedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "endpointGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "DeviceClaimToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndpointEnrollment" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "enrolledAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "enrollmentIp" TEXT,
    "enrollmentUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicianDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicianDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LauncherToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "technicianDeviceId" TEXT,
    "supportSessionId" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "targetEndpointId" TEXT,
    "targetRustdeskId" TEXT,
    "targetAlias" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LauncherToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "technicianId" TEXT NOT NULL,
    "endpointId" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "isAdHoc" BOOLEAN NOT NULL DEFAULT false,
    "adHocRustdeskId" TEXT,
    "issueDescription" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "notes" TEXT,
    "disposition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSessionEvent" (
    "id" TEXT NOT NULL,
    "supportSessionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "endpointId" TEXT,
    "customerId" TEXT,
    "sessionId" TEXT,
    "content" TEXT NOT NULL,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'INTERNAL',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteComment" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "actorId" TEXT,
    "actorIp" TEXT,
    "actorAgent" TEXT,
    "action" "ActivityAction" NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "columns" TEXT[],
    "sortField" TEXT,
    "sortDir" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "quickConnectEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quickConnectWindows" BOOLEAN NOT NULL DEFAULT true,
    "quickConnectMacos" BOOLEAN NOT NULL DEFAULT false,
    "quickConnectLinux" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSecurityConfig" (
    "id" TEXT NOT NULL,
    "geoipBlockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ipAllowlistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "blockedCountries" TEXT[],
    "blockedIpRanges" TEXT[],
    "allowedIpRanges" TEXT[],
    "maxLoginAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSecurityConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_slug_idx" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSettings_tenantId_key" ON "TenantSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantBranding_tenantId_key" ON "TenantBranding"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "UserMfaMethod_userId_idx" ON "UserMfaMethod"("userId");

-- CreateIndex
CREATE INDEX "UserMfaMethod_type_idx" ON "UserMfaMethod"("type");

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "Role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_resource_action_key" ON "Permission"("resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "Membership_tenantId_idx" ON "Membership"("tenantId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_tenantId_key" ON "Membership"("userId", "tenantId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_name_idx" ON "Customer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Site_customerId_idx" ON "Site"("customerId");

-- CreateIndex
CREATE INDEX "Site_tenantId_idx" ON "Site"("tenantId");

-- CreateIndex
CREATE INDEX "Endpoint_tenantId_idx" ON "Endpoint"("tenantId");

-- CreateIndex
CREATE INDEX "Endpoint_customerId_idx" ON "Endpoint"("customerId");

-- CreateIndex
CREATE INDEX "Endpoint_status_idx" ON "Endpoint"("status");

-- CreateIndex
CREATE INDEX "Endpoint_tenantId_status_idx" ON "Endpoint"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComputerAccess_tenantId_idx" ON "ComputerAccess"("tenantId");

-- CreateIndex
CREATE INDEX "ComputerAccess_endpointId_idx" ON "ComputerAccess"("endpointId");

-- CreateIndex
CREATE INDEX "ComputerAccess_userId_idx" ON "ComputerAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ComputerAccess_userId_endpointId_key" ON "ComputerAccess"("userId", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "EndpointGroup_tenantId_name_key" ON "EndpointGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "EndpointTag_tag_idx" ON "EndpointTag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "EndpointTag_endpointId_tag_key" ON "EndpointTag"("endpointId", "tag");

-- CreateIndex
CREATE INDEX "EndpointAlias_alias_idx" ON "EndpointAlias"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "EndpointAlias_endpointId_alias_key" ON "EndpointAlias"("endpointId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "RustdeskNode_endpointId_key" ON "RustdeskNode"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "RustdeskNode_rustdeskId_key" ON "RustdeskNode"("rustdeskId");

-- CreateIndex
CREATE INDEX "RustdeskNode_rustdeskId_idx" ON "RustdeskNode"("rustdeskId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionGrant_tokenHash_key" ON "ConnectionGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "ConnectionGrant_tenantId_idx" ON "ConnectionGrant"("tenantId");

-- CreateIndex
CREATE INDEX "ConnectionGrant_endpointId_idx" ON "ConnectionGrant"("endpointId");

-- CreateIndex
CREATE INDEX "ConnectionGrant_userId_idx" ON "ConnectionGrant"("userId");

-- CreateIndex
CREATE INDEX "ConnectionGrant_expiresAt_idx" ON "ConnectionGrant"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceClaimToken_token_key" ON "DeviceClaimToken"("token");

-- CreateIndex
CREATE INDEX "DeviceClaimToken_token_idx" ON "DeviceClaimToken"("token");

-- CreateIndex
CREATE INDEX "DeviceClaimToken_tenantId_idx" ON "DeviceClaimToken"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EndpointEnrollment_endpointId_key" ON "EndpointEnrollment"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianDevice_fingerprint_key" ON "TechnicianDevice"("fingerprint");

-- CreateIndex
CREATE INDEX "TechnicianDevice_userId_idx" ON "TechnicianDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LauncherToken_supportSessionId_key" ON "LauncherToken"("supportSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "LauncherToken_token_key" ON "LauncherToken"("token");

-- CreateIndex
CREATE INDEX "LauncherToken_token_idx" ON "LauncherToken"("token");

-- CreateIndex
CREATE INDEX "LauncherToken_userId_idx" ON "LauncherToken"("userId");

-- CreateIndex
CREATE INDEX "SupportSession_tenantId_idx" ON "SupportSession"("tenantId");

-- CreateIndex
CREATE INDEX "SupportSession_customerId_idx" ON "SupportSession"("customerId");

-- CreateIndex
CREATE INDEX "SupportSession_technicianId_idx" ON "SupportSession"("technicianId");

-- CreateIndex
CREATE INDEX "SupportSession_endpointId_idx" ON "SupportSession"("endpointId");

-- CreateIndex
CREATE INDEX "SupportSession_status_idx" ON "SupportSession"("status");

-- CreateIndex
CREATE INDEX "SupportSession_customerId_createdAt_idx" ON "SupportSession"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportSession_tenantId_createdAt_idx" ON "SupportSession"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportSessionEvent_supportSessionId_idx" ON "SupportSessionEvent"("supportSessionId");

-- CreateIndex
CREATE INDEX "Note_endpointId_idx" ON "Note"("endpointId");

-- CreateIndex
CREATE INDEX "Note_customerId_idx" ON "Note"("customerId");

-- CreateIndex
CREATE INDEX "Note_tenantId_idx" ON "Note"("tenantId");

-- CreateIndex
CREATE INDEX "NoteComment_noteId_idx" ON "NoteComment"("noteId");

-- CreateIndex
CREATE INDEX "ActivityLog_tenantId_idx" ON "ActivityLog"("tenantId");

-- CreateIndex
CREATE INDEX "ActivityLog_customerId_idx" ON "ActivityLog"("customerId");

-- CreateIndex
CREATE INDEX "ActivityLog_actorId_idx" ON "ActivityLog"("actorId");

-- CreateIndex
CREATE INDEX "ActivityLog_action_idx" ON "ActivityLog"("action");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_customerId_createdAt_idx" ON "ActivityLog"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_tenantId_createdAt_idx" ON "ActivityLog"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "ApiKey_customerId_idx" ON "ApiKey"("customerId");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- CreateIndex
CREATE INDEX "Invitation_token_idx" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "SavedView_tenantId_idx" ON "SavedView"("tenantId");

-- CreateIndex
CREATE INDEX "TenantPolicy_tenantId_idx" ON "TenantPolicy"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantBranding" ADD CONSTRAINT "TenantBranding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMfaMethod" ADD CONSTRAINT "UserMfaMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_endpointGroupId_fkey" FOREIGN KEY ("endpointGroupId") REFERENCES "EndpointGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputerAccess" ADD CONSTRAINT "ComputerAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputerAccess" ADD CONSTRAINT "ComputerAccess_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputerAccess" ADD CONSTRAINT "ComputerAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointGroup" ADD CONSTRAINT "EndpointGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointTag" ADD CONSTRAINT "EndpointTag_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointAlias" ADD CONSTRAINT "EndpointAlias_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RustdeskNode" ADD CONSTRAINT "RustdeskNode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RustdeskNode" ADD CONSTRAINT "RustdeskNode_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaimToken" ADD CONSTRAINT "DeviceClaimToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaimToken" ADD CONSTRAINT "DeviceClaimToken_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointEnrollment" ADD CONSTRAINT "EndpointEnrollment_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianDevice" ADD CONSTRAINT "TechnicianDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LauncherToken" ADD CONSTRAINT "LauncherToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LauncherToken" ADD CONSTRAINT "LauncherToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LauncherToken" ADD CONSTRAINT "LauncherToken_technicianDeviceId_fkey" FOREIGN KEY ("technicianDeviceId") REFERENCES "TechnicianDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LauncherToken" ADD CONSTRAINT "LauncherToken_supportSessionId_fkey" FOREIGN KEY ("supportSessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSessionEvent" ADD CONSTRAINT "SupportSessionEvent_supportSessionId_fkey" FOREIGN KEY ("supportSessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteComment" ADD CONSTRAINT "NoteComment_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteComment" ADD CONSTRAINT "NoteComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantPolicy" ADD CONSTRAINT "TenantPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

