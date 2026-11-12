-- Chat (0.34): two-way chat between a technician in the portal and the person
-- at a managed Windows computer, through the signed agent.
--   ChatConversation  one per chat, belonging to one computer
--   ChatMessage       plain text, ≤ 2,000 characters, with delivery times the
--                     agent confirms (delivered, shown, read)
-- Message text is stored here only. The audit log gets CHAT_STARTED and
-- CHAT_ENDED with ids and counts, and CHAT_PRUNED for each retention pass
-- that deleted something (docs/chat.md).

-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('OPEN', 'ENDED');

-- CreateEnum
CREATE TYPE "ChatSender" AS ENUM ('TECHNICIAN', 'END_USER');

-- AlterEnum


ALTER TYPE "ActivityAction" ADD VALUE 'CHAT_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE 'CHAT_ENDED';
ALTER TYPE "ActivityAction" ADD VALUE 'CHAT_PRUNED';

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "chatProtocol" INTEGER;

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "endpointId" TEXT NOT NULL,
    "supportRequestId" TEXT,
    "status" "ChatStatus" NOT NULL DEFAULT 'OPEN',
    "startedById" TEXT NOT NULL,
    "technicianName" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "deviceState" TEXT,
    "deviceDetail" TEXT,
    "deviceUser" TEXT,
    "deviceStateAt" TIMESTAMP(3),
    "deviceSeenAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endedReason" TEXT,
    "technicianMessages" INTEGER NOT NULL DEFAULT 0,
    "endUserMessages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sender" "ChatSender" NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "shownAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatConversation_endpointId_createdAt_idx" ON "ChatConversation"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatConversation_status_lastActivityAt_idx" ON "ChatConversation"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "ChatConversation_endedAt_idx" ON "ChatConversation"("endedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationId_clientId_key" ON "ChatMessage"("conversationId", "clientId");

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backstops for what the service already enforces.
-- One open chat per computer: starting another returns the open one.
CREATE UNIQUE INDEX "ChatConversation_one_open_per_endpoint" ON "ChatConversation"("endpointId") WHERE "status" = 'OPEN';
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_device_state" CHECK (
    "deviceState" IS NULL OR "deviceState" IN ('connecting', 'window_open', 'no_user', 'window_failed', 'user_closed'));
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_ended_reason" CHECK (
    "endedReason" IS NULL OR "endedReason" IN ('technician', 'end_user', 'inactive'));
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_ended_consistent" CHECK (
    ("status" = 'OPEN' AND "endedAt" IS NULL) OR ("status" = 'ENDED' AND "endedAt" IS NOT NULL));
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_body_bounded" CHECK (
    char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_receipts_technician_only" CHECK (
    "sender" = 'TECHNICIAN' OR ("deliveredAt" IS NULL AND "shownAt" IS NULL AND "readAt" IS NULL));
