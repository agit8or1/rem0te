-- Add contact / address fields to User. All nullable so existing rows remain valid.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone"      TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "jobTitle"   TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "address"    TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city"       TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "state"      TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country"    TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timeZone"   TEXT;
