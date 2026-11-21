-- 0.77.0 Conduit: the background terminal (remote-ops/, docs/remote-terminal.md).
--
-- A Platform Admin opens a cmd or PowerShell on one Windows computer running
-- the signed agent, for one technician (the person who opened it), with a
-- reason. The agent's remote worker polls for it (outbound only; the computer
-- listens on nothing), starts the shell by its absolute System32 path inside a
-- Job Object, and streams it. A session lives at most 60 minutes from when it
-- was opened and 15 minutes without the technician's input; neither is ever
-- extended (TERMINAL_MAX_MS, TERMINAL_IDLE_MS in remote-ops/limits.ts, and
-- the same constants compiled into the agent).
--
-- Nothing typed or printed is kept unless the business turned transcripts on
-- (RemoteOpsSetting.terminalTranscripts, default off) before the session
-- opened. In transit a frame is a TerminalFrame row, deleted once delivered
-- and with the session. The audit log carries ids, the shell, the reason,
-- durations and byte counts only.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_OPENED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_CLOSED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_EXPIRED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'TERMINAL_ENDED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'REMOTE_OPS_SETTINGS_CHANGED';

CREATE TABLE "TerminalSession" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "shell" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "retained" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "endedById" TEXT,
    "inSeq" INTEGER NOT NULL DEFAULT 0,
    "inAcked" INTEGER NOT NULL DEFAULT 0,
    "outSeq" INTEGER NOT NULL DEFAULT 0,
    "bytesIn" INTEGER NOT NULL DEFAULT 0,
    "bytesOut" INTEGER NOT NULL DEFAULT 0,
    "exitCode" INTEGER,

    CONSTRAINT "TerminalSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TerminalSession_id_check" CHECK ("id" ~ '^[0-9a-f]{32}$'),
    -- Only these two: the agent starts exactly cmd.exe or powershell.exe from System32.
    CONSTRAINT "TerminalSession_shell_check" CHECK ("shell" IN ('cmd', 'powershell')),
    CONSTRAINT "TerminalSession_state_check" CHECK ("state" IN ('pending', 'open', 'ended')),
    CONSTRAINT "TerminalSession_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 500),
    -- The hard limit: never more than 60 minutes from when it was opened.
    CONSTRAINT "TerminalSession_window_check" CHECK ("notAfter" > "createdAt" AND "notAfter" <= "createdAt" + interval '60 minutes'),
    CONSTRAINT "TerminalSession_end_check" CHECK (
        ("state" = 'ended') = ("endedAt" IS NOT NULL)
        AND ("state" = 'ended') = ("endReason" IS NOT NULL)
        AND ("endReason" IS NULL OR "endReason" IN (
            'closed', 'revoked', 'expired_idle', 'expired_max', 'paused', 'exited',
            'agent_refused', 'agent_error', 'output_cap', 'input_cap', 'endpoint_unavailable'))),
    CONSTRAINT "TerminalSession_counts_check" CHECK (
        "inSeq" >= 0 AND "inAcked" >= 0 AND "inAcked" <= "inSeq" AND "outSeq" >= 0
        AND "bytesIn" BETWEEN 0 AND 1048576 AND "bytesOut" >= 0)
);

CREATE TABLE "TerminalFrame" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalFrame_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TerminalFrame_dir_check" CHECK (
        ("dir" = 'in' AND "stream" = 'stdin' AND octet_length("data") BETWEEN 1 AND 4096)
        OR ("dir" = 'out' AND "stream" IN ('stdout', 'stderr') AND octet_length("data") BETWEEN 1 AND 16384)),
    CONSTRAINT "TerminalFrame_seq_check" CHECK ("seq" >= 1)
);

CREATE TABLE "TerminalTranscriptChunk" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalTranscriptChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TerminalTranscriptChunk_dir_check" CHECK (
        ("dir" = 'in' AND "stream" = 'stdin' AND octet_length("data") BETWEEN 1 AND 4096)
        OR ("dir" = 'out' AND "stream" IN ('stdout', 'stderr') AND octet_length("data") BETWEEN 1 AND 16384))
);

CREATE TABLE "RemoteOpsSetting" (
    "businessId" TEXT NOT NULL,
    "terminalTranscripts" BOOLEAN NOT NULL DEFAULT false,
    "transcriptDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "RemoteOpsSetting_pkey" PRIMARY KEY ("businessId"),
    CONSTRAINT "RemoteOpsSetting_days_check" CHECK ("transcriptDays" BETWEEN 1 AND 365)
);

CREATE INDEX "TerminalSession_endpointId_state_idx" ON "TerminalSession"("endpointId", "state");
CREATE INDEX "TerminalSession_state_notAfter_idx" ON "TerminalSession"("state", "notAfter");
CREATE INDEX "TerminalSession_technicianId_state_idx" ON "TerminalSession"("technicianId", "state");
CREATE UNIQUE INDEX "TerminalFrame_sessionId_dir_seq_key" ON "TerminalFrame"("sessionId", "dir", "seq");
CREATE INDEX "TerminalTranscriptChunk_createdAt_idx" ON "TerminalTranscriptChunk"("createdAt");
CREATE UNIQUE INDEX "TerminalTranscriptChunk_sessionId_dir_seq_key" ON "TerminalTranscriptChunk"("sessionId", "dir", "seq");

-- One live terminal per technician per computer.
CREATE UNIQUE INDEX "TerminalSession_one_live_key" ON "TerminalSession"("endpointId", "technicianId") WHERE "state" <> 'ended';

ALTER TABLE "TerminalSession" ADD CONSTRAINT "TerminalSession_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TerminalFrame" ADD CONSTRAINT "TerminalFrame_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TerminalSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TerminalTranscriptChunk" ADD CONSTRAINT "TerminalTranscriptChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TerminalSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteOpsSetting" ADD CONSTRAINT "RemoteOpsSetting_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A session belongs to the computer's business, always.
CREATE FUNCTION terminal_session_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Endpoint" e WHERE e."id" = NEW."endpointId" AND e."customerId" = NEW."businessId") THEN
    RAISE EXCEPTION 'terminal session business does not match the computer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TerminalSession_business_trg" BEFORE INSERT ON "TerminalSession"
  FOR EACH ROW EXECUTE FUNCTION terminal_session_business();
