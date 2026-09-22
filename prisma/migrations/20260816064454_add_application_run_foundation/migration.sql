-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('PREPARE_ONLY');

-- CreateEnum
CREATE TYPE "SensitiveAnswerPolicy" AS ENUM ('EXCLUDE');

-- CreateEnum
CREATE TYPE "ApplicationRunState" AS ENUM ('DRAFT', 'PREPARING', 'READY', 'FILLING', 'REVIEW_REQUIRED', 'READY_FOR_USER_SUBMISSION', 'COMPLETED_BY_USER', 'BLOCKED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationAnswerSourceType" AS ENUM ('PROFILE', 'ANSWER_VAULT', 'MASTER_RESUME', 'TAILORED_RESUME', 'APPLICATION_PLAN', 'USER_PROVIDED', 'GENERATED_WITH_EVIDENCE');

-- CreateEnum
CREATE TYPE "ApplicationRunAnswerStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApplicationRunStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ApplicationExecutionScope" AS ENUM ('APPLICATION_READ', 'APPLICATION_FILL', 'APPLICATION_EVENT_WRITE');

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'APPLICATION_RUN_EVENT';

-- CreateTable
CREATE TABLE "ApplicationAutomationPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "AutomationMode" NOT NULL DEFAULT 'PREPARE_ONLY',
    "minimumFitScore" INTEGER NOT NULL DEFAULT 85,
    "minimumConfidenceScore" INTEGER NOT NULL DEFAULT 85,
    "dailyApplicationCap" INTEGER NOT NULL DEFAULT 5,
    "allowedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permittedAdapters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverLetterRequired" BOOLEAN NOT NULL DEFAULT true,
    "sensitiveAnswerPolicy" "SensitiveAnswerPolicy" NOT NULL DEFAULT 'EXCLUDE',
    "finalReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationAutomationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "state" "ApplicationRunState" NOT NULL DEFAULT 'DRAFT',
    "idempotencyKey" TEXT NOT NULL,
    "activeRunKey" TEXT,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "prepareAttemptId" TEXT,
    "prepareLeaseExpiresAt" TIMESTAMP(3),
    "firstPreparingAt" TIMESTAMP(3),
    "applyUrlSnapshot" TEXT NOT NULL,
    "applyHost" TEXT NOT NULL,
    "detectedAdapter" TEXT,
    "policySnapshot" JSONB,
    "policyHash" TEXT,
    "fitScoreSnapshot" INTEGER,
    "matchConfidenceScoreSnapshot" INTEGER,
    "plannerConfidenceScoreSnapshot" INTEGER,
    "resumeVersionId" TEXT,
    "resumeContentHash" TEXT,
    "coverLetterVersionId" TEXT,
    "coverLetterContentHash" TEXT,
    "applicationPlanSnapshot" JSONB,
    "requirementCatalogSnapshot" JSONB,
    "evidenceCatalogSnapshot" JSONB,
    "plannerProvider" TEXT,
    "plannerModel" TEXT,
    "plannerPromptVersion" TEXT,
    "plannerRequestHash" TEXT,
    "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewAcknowledgedAt" TIMESTAMP(3),
    "blockingReason" TEXT,
    "errorCategory" TEXT,
    "preparedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationRunAnswer" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "normalizedFieldKey" TEXT NOT NULL,
    "originalQuestion" TEXT NOT NULL,
    "proposedValue" TEXT,
    "valueRedacted" BOOLEAN NOT NULL DEFAULT false,
    "sourceType" "ApplicationAnswerSourceType",
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "requiresReview" BOOLEAN NOT NULL DEFAULT true,
    "status" "ApplicationRunAnswerStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUser" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),
    "finalValueHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationRunAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "semanticFieldKey" TEXT,
    "adapter" TEXT,
    "status" "ApplicationRunStepStatus" NOT NULL DEFAULT 'PENDING',
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "redactedValueSummary" TEXT,
    "errorCategory" TEXT,
    "artifactReference" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationExecutionToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "scope" "ApplicationExecutionScope" NOT NULL,
    "singleUse" BOOLEAN NOT NULL DEFAULT true,
    "consumedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationExecutionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAutomationPolicy_userId_key" ON "ApplicationAutomationPolicy"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRun_activeRunKey_key" ON "ApplicationRun"("activeRunKey");

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_state_idx" ON "ApplicationRun"("userId", "state");

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_firstPreparingAt_idx" ON "ApplicationRun"("userId", "firstPreparingAt");

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_createdAt_idx" ON "ApplicationRun"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRun_userId_idempotencyKey_key" ON "ApplicationRun"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ApplicationRunAnswer_userId_runId_idx" ON "ApplicationRunAnswer"("userId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRunAnswer_runId_normalizedFieldKey_key" ON "ApplicationRunAnswer"("runId", "normalizedFieldKey");

-- CreateIndex
CREATE INDEX "ApplicationRunStep_runId_sequence_idx" ON "ApplicationRunStep"("runId", "sequence");

-- CreateIndex
CREATE INDEX "ApplicationRunStep_userId_runId_idx" ON "ApplicationRunStep"("userId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRunStep_runId_stepKey_attemptNumber_key" ON "ApplicationRunStep"("runId", "stepKey", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationExecutionToken_tokenHash_key" ON "ApplicationExecutionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApplicationExecutionToken_userId_runId_idx" ON "ApplicationExecutionToken"("userId", "runId");

-- CreateIndex
CREATE INDEX "ApplicationExecutionToken_expiresAt_idx" ON "ApplicationExecutionToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ApplicationAutomationPolicy" ADD CONSTRAINT "ApplicationAutomationPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_resumeVersionId_fkey" FOREIGN KEY ("resumeVersionId") REFERENCES "ResumeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_coverLetterVersionId_fkey" FOREIGN KEY ("coverLetterVersionId") REFERENCES "GeneratedDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRunAnswer" ADD CONSTRAINT "ApplicationRunAnswer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRunAnswer" ADD CONSTRAINT "ApplicationRunAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRunStep" ADD CONSTRAINT "ApplicationRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRunStep" ADD CONSTRAINT "ApplicationRunStep_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationExecutionToken" ADD CONSTRAINT "ApplicationExecutionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationExecutionToken" ADD CONSTRAINT "ApplicationExecutionToken_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
