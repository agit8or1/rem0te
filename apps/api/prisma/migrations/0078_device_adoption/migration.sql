-- v0.57: device discovery and adoption.
--
-- Three things, all for computers that arrive without an operator choosing
-- their business one at a time:
--
--   * DeploymentKey: a multi-use enrolment key for fleet rollout (GPO,
--     Intune, an existing RMM, a Linux or macOS script). Bound to exactly one
--     business, optionally a site and a static group; a use counter with a
--     ceiling, an expiry at most 90 days out, and a revocation. Only the
--     SHA-256 of the key is stored; the key is shown once. By default
--     ("review") a computer that enrols with one lands in the unassigned pool
--     tagged with the key; only a key made with mode "active" puts it straight
--     into its business.
--   * AdoptionMapping: explicitly configured rules that SUGGEST a business
--     and site for an unassigned computer — by deployment key, AD domain,
--     public source address (CIDR) or hostname prefix. Never by user name or
--     e-mail address, and never applied by themselves.
--   * Endpoint: how a pooled computer arrived (and with which key), the
--     address the server saw it from, and who adopted it into a business.

CREATE TABLE "DeploymentKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "siteId" TEXT,
    "endpointGroupId" TEXT,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'review',
    "accessMode" "EndpointAccessMode" NOT NULL DEFAULT 'ASSIGNED_USERS',
    "maxUses" INTEGER NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeploymentKey_mode_check" CHECK ("mode" IN ('review', 'active')),
    CONSTRAINT "DeploymentKey_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DeploymentKey_hint_check" CHECK ("keyHint" ~ '^[0-9a-f]{4}$'),
    CONSTRAINT "DeploymentKey_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "DeploymentKey_uses_check" CHECK ("maxUses" BETWEEN 1 AND 10000 AND "useCount" >= 0 AND "useCount" <= "maxUses"),
    -- At most 90 days from creation, whatever the API is asked for.
    CONSTRAINT "DeploymentKey_expiry_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '90 days')
);
CREATE UNIQUE INDEX "DeploymentKey_keyHash_key" ON "DeploymentKey"("keyHash");
CREATE INDEX "DeploymentKey_customerId_idx" ON "DeploymentKey"("customerId");
ALTER TABLE "DeploymentKey" ADD CONSTRAINT "DeploymentKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeploymentKey" ADD CONSTRAINT "DeploymentKey_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeploymentKey" ADD CONSTRAINT "DeploymentKey_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeploymentKey" ADD CONSTRAINT "DeploymentKey_endpointGroupId_fkey" FOREIGN KEY ("endpointGroupId") REFERENCES "EndpointGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AdoptionMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "deploymentKeyId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdoptionMapping_pkey" PRIMARY KEY ("id"),
    -- The four explicit kinds. There is no kind for a user name or an e-mail
    -- address, and there must never be one (check-security-invariants §70).
    CONSTRAINT "AdoptionMapping_kind_check" CHECK ("kind" IN ('deployment_key', 'domain', 'cidr', 'hostname_prefix')),
    CONSTRAINT "AdoptionMapping_key_check" CHECK (("kind" = 'deployment_key') = ("deploymentKeyId" IS NOT NULL)),
    CONSTRAINT "AdoptionMapping_value_check" CHECK (char_length("value") BETWEEN 1 AND 253),
    CONSTRAINT "AdoptionMapping_priority_check" CHECK ("priority" BETWEEN 0 AND 1000)
);
CREATE UNIQUE INDEX "AdoptionMapping_kind_value_key" ON "AdoptionMapping"("kind", "value");
CREATE INDEX "AdoptionMapping_customerId_idx" ON "AdoptionMapping"("customerId");
ALTER TABLE "AdoptionMapping" ADD CONSTRAINT "AdoptionMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdoptionMapping" ADD CONSTRAINT "AdoptionMapping_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdoptionMapping" ADD CONSTRAINT "AdoptionMapping_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdoptionMapping" ADD CONSTRAINT "AdoptionMapping_deploymentKeyId_fkey" FOREIGN KEY ("deploymentKeyId") REFERENCES "DeploymentKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A key's site and group, and a mapping's site and key, are its own
-- business's. The API checks first; these make it true whatever writes.
CREATE OR REPLACE FUNCTION deployment_key_same_business() RETURNS trigger AS $$
BEGIN
  IF NEW."siteId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Site" WHERE "id" = NEW."siteId" AND "customerId" = NEW."customerId") THEN
    RAISE EXCEPTION 'a deployment key''s site belongs to its business' USING ERRCODE = '23514';
  END IF;
  IF NEW."endpointGroupId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EndpointGroup" WHERE "id" = NEW."endpointGroupId" AND "kind" = 'STATIC'
      AND ("customerId" = NEW."customerId" OR ("customerId" IS NULL AND "tenantId" = NEW."tenantId"))
  ) THEN
    RAISE EXCEPTION 'a deployment key''s group is a static group of its business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER deployment_key_same_business BEFORE INSERT OR UPDATE OF "customerId", "siteId", "endpointGroupId" ON "DeploymentKey"
  FOR EACH ROW EXECUTE FUNCTION deployment_key_same_business();

CREATE OR REPLACE FUNCTION adoption_mapping_same_business() RETURNS trigger AS $$
BEGIN
  IF NEW."siteId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Site" WHERE "id" = NEW."siteId" AND "customerId" = NEW."customerId") THEN
    RAISE EXCEPTION 'a mapping''s site belongs to its business' USING ERRCODE = '23514';
  END IF;
  IF NEW."deploymentKeyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DeploymentKey" WHERE "id" = NEW."deploymentKeyId" AND "customerId" = NEW."customerId") THEN
    RAISE EXCEPTION 'a deployment-key mapping names a key of the same business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER adoption_mapping_same_business BEFORE INSERT OR UPDATE ON "AdoptionMapping"
  FOR EACH ROW EXECUTE FUNCTION adoption_mapping_same_business();

ALTER TABLE "Endpoint" ADD COLUMN "deploymentKeyId" TEXT;
ALTER TABLE "Endpoint" ADD COLUMN "arrivedVia" TEXT;
ALTER TABLE "Endpoint" ADD COLUMN "sourceIp" TEXT;
ALTER TABLE "Endpoint" ADD COLUMN "adoptedAt" TIMESTAMP(3);
ALTER TABLE "Endpoint" ADD COLUMN "adoptedById" TEXT;
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_deploymentKeyId_fkey" FOREIGN KEY ("deploymentKeyId") REFERENCES "DeploymentKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_arrivedVia_check" CHECK ("arrivedVia" IS NULL OR "arrivedVia" IN ('heartbeat', 'install_script', 'deployment_key'));
CREATE INDEX "Endpoint_deploymentKeyId_idx" ON "Endpoint"("deploymentKeyId");
-- A computer with a business has a tenant. Before 0.57 the device edit route
-- could set a pooled computer's business and leave its tenant null; adoption
-- is now the only way out of the pool. NOT VALID: enforced on every write
-- from here on, without failing on a row an older release left like that.
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_business_has_tenant_check" CHECK ("customerId" IS NULL OR "tenantId" IS NOT NULL) NOT VALID;

ALTER TYPE "ActivityAction" ADD VALUE 'ENDPOINT_ADOPTED';
ALTER TYPE "ActivityAction" ADD VALUE 'ENDPOINT_FORGOTTEN';
ALTER TYPE "ActivityAction" ADD VALUE 'DEPLOYMENT_KEY_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEPLOYMENT_KEY_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEPLOYMENT_KEY_USED';
ALTER TYPE "ActivityAction" ADD VALUE 'ADOPTION_MAPPING_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'ADOPTION_MAPPING_DELETED';
