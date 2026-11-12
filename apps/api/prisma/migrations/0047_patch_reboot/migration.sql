-- 0.34: a deployment's restart rule. Every ring plan of the deployment
-- carries it as windows.update.install's closed `reboot` parameter. Existing
-- deployments were all created under "never".
ALTER TABLE "PatchDeployment" ADD COLUMN "reboot" TEXT NOT NULL DEFAULT 'never';
ALTER TABLE "PatchDeployment" ADD CONSTRAINT "PatchDeployment_reboot_check" CHECK ("reboot" IN ('never', 'if_required_in_window'));
