ALTER TYPE "AutomationMode" ADD VALUE 'FILL_AND_REVIEW';

ALTER TABLE "ApplicationRun"
    ADD COLUMN "fillAttemptId" TEXT,
    ADD COLUMN "fillLeaseExpiresAt" TIMESTAMP(3);
