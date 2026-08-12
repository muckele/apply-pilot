ALTER TABLE "ResumeVersion"
ADD COLUMN "template" TEXT NOT NULL DEFAULT 'CLASSIC',
ADD COLUMN "pageSize" TEXT NOT NULL DEFAULT 'LETTER',
ADD COLUMN "fontFamily" TEXT NOT NULL DEFAULT 'ARIAL',
ADD COLUMN "accentColor" TEXT NOT NULL DEFAULT '#0F766E',
ADD COLUMN "fontSize" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "lineSpacing" INTEGER NOT NULL DEFAULT 115;

ALTER TABLE "AIAnalysis"
ADD COLUMN "promptVersion" TEXT NOT NULL DEFAULT '1',
ADD COLUMN "inputHash" TEXT;

CREATE TABLE "BrowserCaptureToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrowserCaptureToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationAnswer" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "normalizedQuestion" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationAnswer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterviewQuestion" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "jobPostingId" TEXT,
  "interviewId" TEXT,
  "question" TEXT NOT NULL,
  "normalizedQuestion" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'GENERAL',
  "answer" TEXT,
  "improvedAnswer" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "timesAsked" INTEGER NOT NULL DEFAULT 0,
  "lastAskedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InterviewQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StarStory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "situation" TEXT NOT NULL,
  "task" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "skills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "roleContext" TEXT,
  "isFavorite" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StarStory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AISettings" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 1000,
  "maxAnalysesPerSync" INTEGER NOT NULL DEFAULT 5,
  "aiDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "modelOverride" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AISettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AIUsageEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptName" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL DEFAULT '1',
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostMicros" INTEGER,
  "requestHash" TEXT,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrowserCaptureToken_tokenHash_key" ON "BrowserCaptureToken"("tokenHash");
CREATE INDEX "BrowserCaptureToken_userId_revokedAt_idx" ON "BrowserCaptureToken"("userId", "revokedAt");
CREATE UNIQUE INDEX "ApplicationAnswer_userId_normalizedQuestion_key" ON "ApplicationAnswer"("userId", "normalizedQuestion");
CREATE INDEX "ApplicationAnswer_userId_category_isActive_idx" ON "ApplicationAnswer"("userId", "category", "isActive");
CREATE INDEX "InterviewQuestion_userId_category_idx" ON "InterviewQuestion"("userId", "category");
CREATE INDEX "InterviewQuestion_userId_lastAskedAt_idx" ON "InterviewQuestion"("userId", "lastAskedAt");
CREATE UNIQUE INDEX "InterviewQuestion_userId_normalizedQuestion_key" ON "InterviewQuestion"("userId", "normalizedQuestion");
CREATE INDEX "StarStory_userId_isFavorite_idx" ON "StarStory"("userId", "isFavorite");
CREATE UNIQUE INDEX "AISettings_userId_key" ON "AISettings"("userId");
CREATE INDEX "AIUsageEvent_userId_createdAt_idx" ON "AIUsageEvent"("userId", "createdAt");
CREATE INDEX "AIUsageEvent_userId_feature_requestHash_idx" ON "AIUsageEvent"("userId", "feature", "requestHash");
CREATE INDEX "AIAnalysis_userId_type_inputHash_idx" ON "AIAnalysis"("userId", "type", "inputHash");

ALTER TABLE "BrowserCaptureToken" ADD CONSTRAINT "BrowserCaptureToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationAnswer" ADD CONSTRAINT "ApplicationAnswer_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InterviewQuestion" ADD CONSTRAINT "InterviewQuestion_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InterviewQuestion" ADD CONSTRAINT "InterviewQuestion_jobPostingId_fkey"
FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InterviewQuestion" ADD CONSTRAINT "InterviewQuestion_interviewId_fkey"
FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StarStory" ADD CONSTRAINT "StarStory_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AISettings" ADD CONSTRAINT "AISettings_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIUsageEvent" ADD CONSTRAINT "AIUsageEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
