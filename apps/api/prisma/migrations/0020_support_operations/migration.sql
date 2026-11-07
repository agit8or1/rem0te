-- CreateEnum
CREATE TYPE "AssignmentApproval" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "SupportRequestStatus" AS ENUM ('WAITING', 'CLAIMED', 'CONNECTING', 'COMPLETED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "UpdateComponent" AS ENUM ('RUSTDESK', 'AGENT');

-- CreateEnum
CREATE TYPE "RolloutStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "UpdateJobStatus" AS ENUM ('REQUESTED', 'DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_APPROVED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_DENIED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_ASSIGNMENT_EXPIRED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_GROUP_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_GROUP_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_GROUP_DELETED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_GROUP_MEMBER_ADDED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_GROUP_MEMBER_REMOVED';
ALTER TYPE "ActivityAction" ADD VALUE 'PLATFORM_PERMISSIONS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'COMPUTER_ACCESS_EXPIRED';
ALTER TYPE "ActivityAction" ADD VALUE 'OFFBOARDING_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE 'OFFBOARDING_STEP';
ALTER TYPE "ActivityAction" ADD VALUE 'DIAGNOSTICS_RUN';
ALTER TYPE "ActivityAction" ADD VALUE 'DIAGNOSTICS_REPORT_DOWNLOADED';
ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_DIAGNOSTIC_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'SESSION_STATE_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_REQUEST_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_REQUEST_CLAIMED';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_REQUEST_HANDED_OFF';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_REQUEST_COMPLETED';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_REQUEST_CANCELED';
ALTER TYPE "ActivityAction" ADD VALUE 'SUPPORT_INTAKE_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_ROLLOUT_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_ROLLOUT_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_ROLLOUT_PAUSED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_ROLLOUT_RESUMED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_ROLLOUT_CANCELED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_JOB_SUCCEEDED';
ALTER TYPE "ActivityAction" ADD VALUE 'UPDATE_JOB_FAILED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_PROVIDER_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_LOGIN';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_LOGIN_DENIED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_LINKED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_UNLINKED';
ALTER TYPE "ActivityAction" ADD VALUE 'PASSKEY_REGISTERED';
ALTER TYPE "ActivityAction" ADD VALUE 'PASSKEY_REMOVED';
ALTER TYPE "ActivityAction" ADD VALUE 'PASSKEY_LOGIN';
ALTER TYPE "ActivityAction" ADD VALUE 'STEP_UP_VERIFIED';
ALTER TYPE "ActivityAction" ADD VALUE 'STEP_UP_FAILED';

-- AlterEnum
ALTER TYPE "SessionStatus" ADD VALUE 'STATUS_UNKNOWN';

-- AlterTable
ALTER TABLE "ComputerAccess" ADD COLUMN     "expiryAuditedAt" TIMESTAMP(3),
ADD COLUMN     "schedule" JSONB,
ADD COLUMN     "startsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "supportIntakeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supportIntakeSlug" TEXT,
ADD COLUMN     "technicianApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EndpointInventory" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "rustdeskPinnedVersion" TEXT,
ADD COLUMN     "stepUpActions" TEXT[] DEFAULT ARRAY['credential.reveal', 'permissions.change', 'technicians.manage', 'sso.configure', 'passkey.manage']::TEXT[];

-- AlterTable
ALTER TABLE "RustdeskNode" ADD COLUMN     "rdSessionsActive" INTEGER,
ADD COLUMN     "rdSessionsObservedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SupportSession" ADD COLUMN     "clientOpenedAt" TIMESTAMP(3),
ADD COLUMN     "connectionConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "endInferred" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "endReason" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "lastSignalAt" TIMESTAMP(3),
ADD COLUMN     "launchRequestedAt" TIMESTAMP(3),
ADD COLUMN     "launcherAckAt" TIMESTAMP(3),
ADD COLUMN     "manualWorkMinutes" INTEGER,
ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusSource" TEXT,
ADD COLUMN     "supportRequestId" TEXT,
ADD COLUMN     "telemetryTokenHash" TEXT,
ADD COLUMN     "timingQuality" TEXT NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "SupportSessionEvent" ADD COLUMN     "applied" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "platformPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "UserMfaMethod" ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "signCount" INTEGER,
ADD COLUMN     "transports" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "TechnicianGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicianGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicianGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicianGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicianAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "endpointIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "schedule" JSONB,
    "reason" TEXT,
    "approvalStatus" "AssignmentApproval" NOT NULL DEFAULT 'NOT_REQUIRED',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "expiryAuditedAt" TIMESTAMP(3),

    CONSTRAINT "TechnicianAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffboardingCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "subjectUserId" TEXT NOT NULL,
    "customerId" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "steps" JSONB NOT NULL,
    "notes" TEXT,

    CONSTRAINT "OffboardingCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicianDiagnostic" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedIp" TEXT,
    "report" JSONB,

    CONSTRAINT "TechnicianDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'PUBLIC',
    "submittedById" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "description" TEXT,
    "endpointId" TEXT,
    "reportedRustdeskId" TEXT,
    "unmanaged" BOOLEAN NOT NULL DEFAULT false,
    "status" "SupportRequestStatus" NOT NULL DEFAULT 'WAITING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "claimedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "statusTokenHash" TEXT NOT NULL,
    "statusExpiresAt" TIMESTAMP(3) NOT NULL,
    "submitIpHash" TEXT,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT,
    "event" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdatePilotGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdatePilotGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdatePilotMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,

    CONSTRAINT "UpdatePilotMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateRollout" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "component" "UpdateComponent" NOT NULL,
    "targetVersion" TEXT NOT NULL,
    "artifactName" TEXT,
    "artifactSha256" TEXT,
    "status" "RolloutStatus" NOT NULL DEFAULT 'DRAFT',
    "pilotGroupId" TEXT,
    "batchSize" INTEGER NOT NULL DEFAULT 10,
    "currentBatch" INTEGER NOT NULL DEFAULT 0,
    "failureThreshold" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "backoffMinutes" INTEGER NOT NULL DEFAULT 30,
    "verifyTimeoutMinutes" INTEGER NOT NULL DEFAULT 60,
    "maintenanceWindow" JSONB,
    "deferOnUnknownSession" BOOLEAN NOT NULL DEFAULT true,
    "pausedReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),

    CONSTRAINT "UpdateRollout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateJob" (
    "id" TEXT NOT NULL,
    "rolloutId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT,
    "batch" INTEGER NOT NULL DEFAULT 1,
    "status" "UpdateJobStatus" NOT NULL DEFAULT 'REQUESTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "dispatchNonce" TEXT,
    "installStartedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "fromVersion" TEXT,
    "installedVersion" TEXT,
    "failureReason" TEXT,
    "deferReason" TEXT,
    "credentialSync" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpdateJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" "UpdateJobStatus",
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpdateJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'openid email profile',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowProvisioning" BOOLEAN NOT NULL DEFAULT false,
    "groupsClaim" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcGroupMapping" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "groupValue" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcGroupMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcLoginState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "returnTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcLoginState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianGroup_tenantId_name_key" ON "TechnicianGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TechnicianGroupMember_userId_idx" ON "TechnicianGroupMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianGroupMember_groupId_userId_key" ON "TechnicianGroupMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "TechnicianAssignment_userId_idx" ON "TechnicianAssignment"("userId");

-- CreateIndex
CREATE INDEX "TechnicianAssignment_groupId_idx" ON "TechnicianAssignment"("groupId");

-- CreateIndex
CREATE INDEX "TechnicianAssignment_customerId_idx" ON "TechnicianAssignment"("customerId");

-- CreateIndex
CREATE INDEX "OffboardingCase_subjectUserId_idx" ON "OffboardingCase"("subjectUserId");

-- CreateIndex
CREATE INDEX "OffboardingCase_customerId_idx" ON "OffboardingCase"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianDiagnostic_tokenHash_key" ON "TechnicianDiagnostic"("tokenHash");

-- CreateIndex
CREATE INDEX "TechnicianDiagnostic_userId_createdAt_idx" ON "TechnicianDiagnostic"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_statusTokenHash_key" ON "SupportRequest"("statusTokenHash");

-- CreateIndex
CREATE INDEX "SupportRequest_customerId_status_idx" ON "SupportRequest"("customerId", "status");

-- CreateIndex
CREATE INDEX "SupportRequest_status_createdAt_idx" ON "SupportRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportRequestEvent_requestId_idx" ON "SupportRequestEvent"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "UpdatePilotGroup_name_key" ON "UpdatePilotGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UpdatePilotMember_groupId_endpointId_key" ON "UpdatePilotMember"("groupId", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateJob_dispatchNonce_key" ON "UpdateJob"("dispatchNonce");

-- CreateIndex
CREATE INDEX "UpdateJob_endpointId_status_idx" ON "UpdateJob"("endpointId", "status");

-- CreateIndex
CREATE INDEX "UpdateJob_status_idx" ON "UpdateJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "UpdateJob_rolloutId_endpointId_key" ON "UpdateJob"("rolloutId", "endpointId");

-- CreateIndex
CREATE INDEX "UpdateJobEvent_jobId_idx" ON "UpdateJobEvent"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcProvider_issuer_key" ON "OidcProvider"("issuer");

-- CreateIndex
CREATE UNIQUE INDEX "OidcGroupMapping_providerId_groupValue_key" ON "OidcGroupMapping"("providerId", "groupValue");

-- CreateIndex
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_issuer_subject_key" ON "ExternalIdentity"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "OidcLoginState_stateHash_key" ON "OidcLoginState"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_supportIntakeSlug_key" ON "Customer"("supportIntakeSlug");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_telemetryTokenHash_key" ON "SupportSession"("telemetryTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSessionEvent_supportSessionId_dedupeKey_key" ON "SupportSessionEvent"("supportSessionId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "SupportRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianGroupMember" ADD CONSTRAINT "TechnicianGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TechnicianGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianGroupMember" ADD CONSTRAINT "TechnicianGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianAssignment" ADD CONSTRAINT "TechnicianAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianAssignment" ADD CONSTRAINT "TechnicianAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianAssignment" ADD CONSTRAINT "TechnicianAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TechnicianGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequestEvent" ADD CONSTRAINT "SupportRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdatePilotMember" ADD CONSTRAINT "UpdatePilotMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UpdatePilotGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateRollout" ADD CONSTRAINT "UpdateRollout_pilotGroupId_fkey" FOREIGN KEY ("pilotGroupId") REFERENCES "UpdatePilotGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateJob" ADD CONSTRAINT "UpdateJob_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES "UpdateRollout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpdateJobEvent" ADD CONSTRAINT "UpdateJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "UpdateJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcGroupMapping" ADD CONSTRAINT "OidcGroupMapping_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Legacy session timing ───────────────────────────────────────────────────
-- Before 0.20.0 the browser Connect path wrote status CLIENT_OPENED and
-- startedAt at the moment the credential was released, and the 12-hour sweep
-- closed those rows as SESSION_COMPLETED. Neither is evidence that a remote
-- desktop connection happened, so every pre-existing row is labelled LEGACY:
-- its startedAt is shown as "launched", and its duration is not counted as
-- measured connection time.
UPDATE "SupportSession"
   SET "timingQuality"     = 'LEGACY',
       "launchRequestedAt" = COALESCE("startedAt", "createdAt");
