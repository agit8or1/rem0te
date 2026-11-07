-- v0.21.0: the server's public address becomes a Platform Setting.
ALTER TABLE "PlatformSettings" ADD COLUMN "publicUrl" TEXT;

-- New step-up action, on by default. The column default covers a fresh
-- install; an existing row gets it appended so the protection is not silently
-- off on upgrade (an operator can still turn it off afterwards).
ALTER TABLE "PlatformSettings" ALTER COLUMN "stepUpActions" SET DEFAULT ARRAY['credential.reveal', 'permissions.change', 'technicians.manage', 'sso.configure', 'passkey.manage', 'platform.configure']::TEXT[];
UPDATE "PlatformSettings"
   SET "stepUpActions" = array_append("stepUpActions", 'platform.configure')
 WHERE NOT ('platform.configure' = ANY("stepUpActions"));
