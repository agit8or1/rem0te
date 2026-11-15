-- v0.52: task progress. Indexes only; no table, column or constraint changes.
--
-- The console polls GET /tasks/mine from every page (every 5 s while
-- something its user started is in flight, every 15 s otherwise) to toast
-- when it finishes. That read is "rows this person requested that finished
-- after T", which none of the existing indexes serve.

CREATE INDEX "ActionJob_requestedById_createdAt_idx" ON "ActionJob"("requestedById", "createdAt");
CREATE INDEX "ActionTarget_resultAt_idx" ON "ActionTarget"("resultAt");
CREATE INDEX "EndpointCommand_requestedById_completedAt_idx" ON "EndpointCommand"("requestedById", "completedAt");
