-- 0.78.1 (F1): a control grant enforces its permissions.
--
-- The signed agent now also sets RustDesk's six remaining permission options
-- to N on every grant and reads them back (msa/managed.ts LOCKED_KEYS, Go
-- enforce.Locked). A readback, drift or restore report may name one, so the
-- two failedKeys CHECKs from 0089 take them: the preflight's eleven, the six,
-- and the password. Nothing else changes. (Numbered 0098 because 0096 and
-- 0097 are taken by releases built alongside this one.)
ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_failedKeys_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_failedKeys_check" CHECK (
  cardinality("failedKeys") <= 18 AND "failedKeys" <@ ARRAY['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer',
  'enable-audio', 'enable-tunnel', 'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect',
  'auto-disconnect-timeout', 'enable-terminal', 'enable-camera', 'enable-remote-printer', 'enable-block-input',
  'enable-privacy-mode', 'enable-record-session', 'password']::TEXT[]);

ALTER TABLE "MsaManagedComputer" DROP CONSTRAINT "MsaManagedComputer_failedKeys_check";
ALTER TABLE "MsaManagedComputer" ADD CONSTRAINT "MsaManagedComputer_failedKeys_check" CHECK (
  cardinality("failedKeys") <= 18 AND "failedKeys" <@ ARRAY['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer',
  'enable-audio', 'enable-tunnel', 'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect',
  'auto-disconnect-timeout', 'enable-terminal', 'enable-camera', 'enable-remote-printer', 'enable-block-input',
  'enable-privacy-mode', 'enable-record-session', 'password']::TEXT[]);
