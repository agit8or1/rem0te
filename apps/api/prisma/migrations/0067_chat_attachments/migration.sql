-- 0.44: chat attachments, per-user read state, and the message cap counted
-- the way the API and the agent count it.

-- One audit row per attachment: ids, kind, type and size, never the bytes or the name.
ALTER TYPE "ActivityAction" ADD VALUE 'CHAT_ATTACHMENT_SENT';

-- Attachments sent in a chat, claimed before each is written.
ALTER TABLE "ChatConversation" ADD COLUMN "attachmentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatConversation" ADD COLUMN "attachmentBytes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChatAttachment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sender" "ChatSender" NOT NULL,
    "authorId" TEXT,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatReadState" (
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("userId","conversationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatAttachment_messageId_key" ON "ChatAttachment"("messageId");

-- CreateIndex
CREATE INDEX "ChatAttachment_conversationId_createdAt_idx" ON "ChatAttachment"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatReadState_conversationId_idx" ON "ChatReadState"("conversationId");

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backstops for what the service already enforces (chat-attachment.ts).
-- At most 20 attachments and 50 MiB in one chat.
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_attachments_bounded" CHECK (
    "attachmentCount" BETWEEN 0 AND 20 AND "attachmentBytes" BETWEEN 0 AND 52428800);
-- 1 byte to 10 MiB, and the size is the bytes' own.
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_size_bounded" CHECK (
    "sizeBytes" BETWEEN 1 AND 10485760 AND octet_length("bytes") = "sizeBytes");
-- Shown inline only as one of four raster types; everything else is a download.
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_kind_type" CHECK (
    ("kind" = 'image' AND "contentType" IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp'))
    OR ("kind" = 'file' AND "contentType" = 'application/octet-stream'));
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_name_bounded" CHECK (
    char_length("fileName") BETWEEN 1 AND 120);
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_author" CHECK (
    ("sender" = 'TECHNICIAN') OR ("authorId" IS NULL));

-- The message cap in UTF-16 code units, as chat-policy.ts (String.length) and
-- the agent (internal/chat utf16Len) count it — and as a browser's textarea
-- maxlength does. char_length alone counts code points, so an emoji (one code
-- point, two units) counted once here and twice there: 1,500 emoji passed
-- this CHECK and were refused by both ends. Now all three agree.
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_body_bounded";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_body_bounded" CHECK (
    char_length("body") >= 1
    AND char_length("body") + char_length(regexp_replace("body", '[^\U00010000-\U0010FFFF]', '', 'g')) <= 2000);
