-- 0.86.0 Lighthouse: lost-device commands from Rem0te — lock, start lost mode,
-- stop lost mode — on Rem0te's own Apple MDM and Android EMM
-- (docs/own-mdm.md M4, invariant §95).
--
-- A Platform Admin, or a business member holding `mobile:act` through scope,
-- sends one of exactly three commands to one enrolled device, after a fresh
-- confirmation (mdm.act) and the device's own refusals (Apple lost mode only
-- on a supervised device; Android lost mode never on a personal one), with
-- the `actions` containment pause consulted first and the audit row written
-- before anything is sent. Erase, wipe, retire and removing work data stay
-- out (M5): they are in no list below.
--
-- Nothing here has run on a real iPhone, iPad or Android device, and no call
-- has been made to Apple or Google: the proof is mdmb, a loopback APNs stub
-- and a loopback stand-in in AMAPI's shape.
--
-- The lock-screen message and contact phone number are not kept on a
-- Rem0te command (MdmCommand) at all, and never in an audit row. Apple's own
-- queue must hold them until the device fetches the command, so
-- AppleCommand carries them while the command is open and the trigger below
-- clears them the moment it is final. Android's are sent once and not
-- stored anywhere.

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_COMMAND_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_COMMAND_SENT';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_COMMAND_SEND_FAILED';

-- The Apple queue's request types: the five inventory commands (0101), then
-- the three lost-device ones (protocol.ts REQUEST_TYPES, in order). No
-- EraseDevice, RemoveProfile or anything else.
ALTER TABLE "AppleCommand" DROP CONSTRAINT "AppleCommand_requestType_check";
ALTER TABLE "AppleCommand" ADD CONSTRAINT "AppleCommand_requestType_check" CHECK ("requestType" IN ('DeviceInformation', 'SecurityInfo', 'InstalledApplicationList', 'ProfileList', 'CertificateList', 'DeviceLock', 'EnableLostMode', 'DisableLostMode'));

-- The lock-screen text: only on a DeviceLock or EnableLostMode, only while it
-- is open, bounded and printable; lost mode needs a message or a number.
ALTER TABLE "AppleCommand" ADD COLUMN "lockMessage" TEXT, ADD COLUMN "lockPhone" TEXT;
ALTER TABLE "AppleCommand" ADD CONSTRAINT "AppleCommand_lockText_check" CHECK (
  (("lockMessage" IS NULL AND "lockPhone" IS NULL) OR ("requestType" IN ('DeviceLock', 'EnableLostMode') AND "state" IN ('queued', 'sent')))
  AND ("lockMessage" IS NULL OR (char_length("lockMessage") BETWEEN 1 AND 160 AND "lockMessage" !~ '[[:cntrl:]]'))
  AND ("lockPhone" IS NULL OR "lockPhone" ~ '^[+0-9][0-9 ().-]{2,30}$')
  AND ("requestType" <> 'EnableLostMode' OR "state" NOT IN ('queued', 'sent') OR "lockMessage" IS NOT NULL OR "lockPhone" IS NOT NULL));

-- Final clears the text, and the text never changes to something else. A
-- BEFORE trigger runs before the CHECK above is evaluated, so every writer
-- that finishes a command (Acknowledged, Error, CheckOut's cancel, the
-- sweep's expiry) drops it without having to remember to.
CREATE FUNCTION apple_command_lock_text() RETURNS trigger AS $$
BEGIN
  IF NEW."state" IN ('acknowledged', 'error', 'cancelled', 'expired') THEN
    NEW."lockMessage" := NULL;
    NEW."lockPhone" := NULL;
  ELSIF (NEW."lockMessage" IS DISTINCT FROM OLD."lockMessage" AND NEW."lockMessage" IS NOT NULL)
     OR (NEW."lockPhone" IS DISTINCT FROM OLD."lockPhone" AND NEW."lockPhone" IS NOT NULL) THEN
    RAISE EXCEPTION 'a queued command''s lock-screen text never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleCommand_lock_text_trg" BEFORE UPDATE ON "AppleCommand"
  FOR EACH ROW EXECUTE FUNCTION apple_command_lock_text();

-- A command sent from Rem0te (origin `portal`) names who asked and Rem0te's
-- own id for it, and is one of the three lost-device kinds (lost-device.ts
-- LOST_DEVICE_KINDS, in order). M5 widens this with a second approver.
ALTER TABLE "MdmCommand" ADD CONSTRAINT "MdmCommand_portal_check" CHECK (
  "origin" <> 'portal' OR ("requestedById" IS NOT NULL AND "providerCommandId" IS NOT NULL AND "kind" IN ('lock', 'lost_mode_start', 'lost_mode_stop')));

-- One not-yet-accepted command of a kind per device: a second Lock while the
-- first is still waiting for the provider is refused, not stacked.
CREATE UNIQUE INDEX "MdmCommand_open_portal_key" ON "MdmCommand"("mobileDeviceId", "kind") WHERE "origin" = 'portal' AND "state" IN ('queued', 'sent');
