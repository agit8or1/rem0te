-- Add AI-generated timeline field to Endpoint
ALTER TABLE "Endpoint" ADD COLUMN IF NOT EXISTS "aiTimeline" TEXT;
