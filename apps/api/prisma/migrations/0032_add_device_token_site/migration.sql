-- Add device: an enrolment token can name the site the device lands in.
--
-- The site travels with the token for the same reason the business does: the
-- machine that redeems the token must not be able to choose where it lands,
-- and a site set by the browser after the device appears would be lost
-- whenever the person closed the page first. Nullable, so every existing
-- token, and every token minted without a site, enrols exactly as before.
-- SET NULL on delete: removing a site never invalidates an outstanding token,
-- it only drops the site from it.
ALTER TABLE "DeviceClaimToken" ADD COLUMN "siteId" TEXT;

ALTER TABLE "DeviceClaimToken"
  ADD CONSTRAINT "DeviceClaimToken_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
