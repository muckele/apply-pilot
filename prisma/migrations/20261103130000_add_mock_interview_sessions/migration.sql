-- Additive: text mock-interview practice sessions (WP1.8). One new table; no existing
-- table or column changes. Production applies it with forward-only `prisma migrate deploy`.
CREATE TABLE "MockInterviewSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "interviewId" TEXT,
    "applicationId" TEXT,
    "jobPostingId" TEXT,
    "title" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockInterviewSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MockInterviewSession_questions_check" CHECK (jsonb_typeof("questions") = 'array'),
    CONSTRAINT "MockInterviewSession_answers_check" CHECK (jsonb_typeof("answers") = 'object'),
    CONSTRAINT "MockInterviewSession_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "MockInterviewSession_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "MockInterviewSession_userId_createdAt_idx"
    ON "MockInterviewSession"("userId", "createdAt");
CREATE INDEX "MockInterviewSession_userId_interviewId_idx"
    ON "MockInterviewSession"("userId", "interviewId");
CREATE INDEX "MockInterviewSession_interviewId_idx"
    ON "MockInterviewSession"("interviewId");
CREATE INDEX "MockInterviewSession_applicationId_idx"
    ON "MockInterviewSession"("applicationId");
CREATE INDEX "MockInterviewSession_jobPostingId_idx"
    ON "MockInterviewSession"("jobPostingId");

ALTER TABLE "MockInterviewSession"
    ADD CONSTRAINT "MockInterviewSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockInterviewSession"
    ADD CONSTRAINT "MockInterviewSession_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MockInterviewSession"
    ADD CONSTRAINT "MockInterviewSession_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MockInterviewSession"
    ADD CONSTRAINT "MockInterviewSession_jobPostingId_fkey"
    FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
