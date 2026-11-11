-- 0.34: the device page's AI summary goes through ClientSt0r's inference
-- gateway instead of a model provider called directly from rem0te. Each
-- request is audited before anything is sent (AI_TIMELINE_REQUESTED, with the
-- peer, organization, profile, request id, field list and redaction counts —
-- never the text), and again with the outcome (AI_TIMELINE_FINISHED). A
-- request refused before sending (not configured, not mapped, contained,
-- ClientSt0r not offering the operation) is AI_TIMELINE_REFUSED.

ALTER TYPE "ActivityAction" ADD VALUE 'AI_TIMELINE_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'AI_TIMELINE_FINISHED';
ALTER TYPE "ActivityAction" ADD VALUE 'AI_TIMELINE_REFUSED';
