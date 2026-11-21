-- 0.75.1 Accepted risks on Admin → Security (admin/host-security/acceptance.ts).
--
-- A Platform Admin may accept one finding, with a reason and an optional
-- expiry, so a deliberate decision stops showing as a warning. The row binds
-- the acceptance to a fingerprint of the evidence; when the evidence changes,
-- the check resolves or the expiry passes, the API closes the row
-- (reopenedAt, reopenCause) and the finding is a warning again. Rows are
-- never deleted.
--
-- Numbered 0093, not 0092: 0092 is taken by the diagnostics palette branch
-- (0.76.0) that was in flight at the same time.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'SECURITY_FINDING_ACCEPTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'SECURITY_FINDING_UNACCEPTED';

CREATE TABLE "SecurityFindingAcceptance" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reopenCause" TEXT,
    "reopenedById" TEXT,
    CONSTRAINT "SecurityFindingAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityFindingAcceptance_findingId_acceptedAt_idx" ON "SecurityFindingAcceptance"("findingId", "acceptedAt");

-- One open acceptance per finding.
CREATE UNIQUE INDEX "SecurityFindingAcceptance_open_key" ON "SecurityFindingAcceptance"("findingId") WHERE "reopenedAt" IS NULL;

-- The closed list of checks that may be accepted: ACCEPTABLE_FINDINGS in
-- acceptance.ts, the same ids in the same order (§84 compares them). The
-- never-acceptable findings (a Platform Admin without MFA, break-glass
-- without both factors, the audit chain, empty SSH passwords, NODE_ENV,
-- test switches, TLS) are not in it.
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_findingId_check" CHECK ("findingId" IN (
    'host.ssh.root_login', 'host.ssh.password_auth', 'host.ssh.x11',
    'host.firewall', 'network.listeners',
    'host.updates.security', 'host.updates.other', 'host.updates.lists', 'host.updates.unattended', 'host.reboot',
    'host.fail2ban', 'host.fail2ban.sshd_unit',
    'web.public_https', 'web.headers', 'web.http_redirect',
    'web.header.hsts', 'web.header.csp', 'web.header.framing', 'web.header.nosniff', 'web.header.referrer', 'web.header.permissions',
    'portal.mfa.users', 'portal.apikeys', 'portal.audit_export', 'portal.lockout', 'portal.unenforced_rules',
    'portal.signed_releases', 'portal.release_root_keys', 'portal.approval_signer',
    'deps.npm'
));
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_status_check" CHECK ("status" IN ('fail', 'unknown'));
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_severity_check" CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info'));
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 300);
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_evidence_check" CHECK (char_length("evidence") <= 2000);
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_expiry_check" CHECK (
    "expiresAt" IS NULL OR ("expiresAt" > "acceptedAt" AND "expiresAt" <= "acceptedAt" + INTERVAL '365 days')
);
ALTER TABLE "SecurityFindingAcceptance" ADD CONSTRAINT "SecurityFindingAcceptance_reopen_check" CHECK (
    ("reopenedAt" IS NULL AND "reopenCause" IS NULL AND "reopenedById" IS NULL)
    OR ("reopenedAt" IS NOT NULL AND "reopenCause" IN ('evidence_changed', 'expired', 'resolved', 'unaccepted')
        AND ("reopenCause" = 'unaccepted' OR "reopenedById" IS NULL))
);
