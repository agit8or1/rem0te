-- 0.78.0 Courier: background file transfer (remote-ops/, docs/file-transfer.md).
--
-- A Platform Admin sends a file to, or fetches one from, a Windows computer
-- running the signed agent. It goes through the same outbound remote worker
-- as the terminal (0094). Upload and download are separate capabilities.
--
-- Bytes pass through FileTransferChunk rows:
--   - each chunk is at most 512 KiB;
--   - at most eight chunks wait at a time;
--   - a chunk is deleted as soon as the other end has it, and with the
--     transfer. The server keeps no file.
--
-- The sender declares the SHA-256, the receiver checks it, and the audit log
-- records it. The audit log never records the content.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'FILE_TRANSFER_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'FILE_TRANSFER_COMPLETED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'FILE_TRANSFER_FAILED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'FILE_TRANSFER_CANCELLED';

-- The per-business size limit: 100 MB by default, 2 GB at most.
ALTER TABLE "RemoteOpsSetting" ADD COLUMN "fileMaxMb" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "RemoteOpsSetting" ADD CONSTRAINT "RemoteOpsSetting_fileMaxMb_check" CHECK ("fileMaxMb" BETWEEN 1 AND 2048);

CREATE TABLE "FileTransfer" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "overwrite" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "size" BIGINT,
    "sha256" TEXT,
    "maxBytes" BIGINT NOT NULL,
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "inSeq" INTEGER NOT NULL DEFAULT 0,
    "ackSeq" INTEGER NOT NULL DEFAULT 0,
    "bytesDone" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "lastProgressAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "endedById" TEXT,

    CONSTRAINT "FileTransfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FileTransfer_id_check" CHECK ("id" ~ '^[0-9a-f]{32}$'),
    CONSTRAINT "FileTransfer_direction_check" CHECK ("direction" IN ('to_computer', 'from_computer')),
    -- An absolute local path: a drive letter and a backslash, at most 1,024
    -- characters. The full rule (no UNC or device paths, "..", reserved names
    -- or streams) is in remote-ops/file-policy.ts and in the agent's
    -- internal/remote/filepath.go.
    CONSTRAINT "FileTransfer_path_check" CHECK ("path" ~ '^[A-Za-z]:\\[^\\]' AND char_length("path") BETWEEN 4 AND 1024
        AND position('..' in "path") = 0 AND position('/' in "path") = 0),
    CONSTRAINT "FileTransfer_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 500),
    CONSTRAINT "FileTransfer_state_check" CHECK ("state" IN ('pending', 'transferring', 'completed', 'failed', 'cancelled')),
    CONSTRAINT "FileTransfer_size_check" CHECK (
        "maxBytes" BETWEEN 1 AND 2147483648
        AND ("size" IS NULL OR "size" BETWEEN 0 AND "maxBytes")
        AND ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        -- An upload declares both before it exists.
        AND ("direction" = 'from_computer' OR ("size" IS NOT NULL AND "sha256" IS NOT NULL))
        -- A completed transfer has both.
        AND ("state" <> 'completed' OR ("size" IS NOT NULL AND "sha256" IS NOT NULL))),
    CONSTRAINT "FileTransfer_window_check" CHECK ("notAfter" > "createdAt" AND "notAfter" <= "createdAt" + interval '60 minutes'),
    CONSTRAINT "FileTransfer_counts_check" CHECK (
        "chunks" >= 0 AND "inSeq" >= 0 AND "ackSeq" >= 0 AND "ackSeq" <= "inSeq" AND "inSeq" - "ackSeq" <= 8 AND "bytesDone" >= 0),
    CONSTRAINT "FileTransfer_end_check" CHECK (
        ("state" IN ('completed', 'failed', 'cancelled')) = ("endedAt" IS NOT NULL)
        AND ("state" IN ('completed', 'failed', 'cancelled')) = ("endReason" IS NOT NULL)
        AND ("endReason" IS NULL OR "endReason" IN (
            'completed', 'cancelled', 'revoked', 'expired', 'stalled', 'paused', 'endpoint_unavailable', 'agent_error',
            'exists', 'not_found', 'not_a_file', 'no_folder', 'reparse_point', 'path_refused', 'path_changed',
            'too_large', 'hash_mismatch', 'size_mismatch', 'file_changed', 'write_failed', 'read_failed')))
);

CREATE TABLE "FileTransferChunk" (
    "transferId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileTransferChunk_pkey" PRIMARY KEY ("transferId", "seq"),
    CONSTRAINT "FileTransferChunk_check" CHECK ("seq" >= 1 AND octet_length("data") BETWEEN 1 AND 524288 AND "sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "FileTransfer_endpointId_state_idx" ON "FileTransfer"("endpointId", "state");
CREATE INDEX "FileTransfer_state_notAfter_idx" ON "FileTransfer"("state", "notAfter");

ALTER TABLE "FileTransfer" ADD CONSTRAINT "FileTransfer_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileTransferChunk" ADD CONSTRAINT "FileTransferChunk_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "FileTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A transfer always belongs to the computer's business.
CREATE FUNCTION file_transfer_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Endpoint" e WHERE e."id" = NEW."endpointId" AND e."customerId" = NEW."businessId") THEN
    RAISE EXCEPTION 'file transfer business does not match the computer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "FileTransfer_business_trg" BEFORE INSERT ON "FileTransfer"
  FOR EACH ROW EXECUTE FUNCTION file_transfer_business();
