-- Recovery for a machine whose device secret changed under it.
--
-- An installer re-run on a machine enrolled before 0.18.22 deleted its own
-- heartbeat.dat (the state-directory hardening treated a user-owned directory
-- as planted) and generated a new secret. The server, holding the old one,
-- rejected every heartbeat after that, and the only way back was to sit at the
-- machine and re-run the installer with a claim token — on a machine nobody
-- could now connect to, because its RustDesk password had changed too.
--
-- The rejected heartbeat's secret is now remembered, and an operator can
-- accept it. Nullable / defaulted: additive and safe on a live database.
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "candidateSecretHash" TEXT;
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "candidateSecretSeenAt" TIMESTAMP(3);
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "candidateSecretFirstAt" TIMESTAMP(3);
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "candidateSecretIp" TEXT;
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "candidateSecretConflict" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_DEVICE_SECRET_ACCEPTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_RESTORED';
