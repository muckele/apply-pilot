ALTER TABLE "AISettings"
ALTER COLUMN "monthlyBudgetCents" SET DEFAULT 500,
ADD COLUMN "automationBudgetCents" INTEGER NOT NULL DEFAULT 150;

UPDATE "AISettings"
SET "monthlyBudgetCents" = LEAST("monthlyBudgetCents", 500),
    "automationBudgetCents" = LEAST(150, LEAST("monthlyBudgetCents", 500));

ALTER TABLE "AIUsageEvent"
ADD COLUMN "reservationId" TEXT,
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'openai',
ADD COLUMN "automation" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AIBudgetLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3) NOT NULL,
  "budgetMicros" INTEGER NOT NULL,
  "spentMicros" INTEGER NOT NULL DEFAULT 0,
  "reservedMicros" INTEGER NOT NULL DEFAULT 0,
  "remainingMicros" INTEGER NOT NULL,
  "automationBudgetMicros" INTEGER NOT NULL,
  "automationSpentMicros" INTEGER NOT NULL DEFAULT 0,
  "automationReservedMicros" INTEGER NOT NULL DEFAULT 0,
  "automationRemainingMicros" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIBudgetLedger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AIBudgetReservation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "promptName" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL DEFAULT '1',
  "requestHash" TEXT NOT NULL,
  "dedupeKey" TEXT,
  "maximumCostMicros" INTEGER NOT NULL,
  "actualCostMicros" INTEGER,
  "automation" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciledAt" TIMESTAMP(3),
  CONSTRAINT "AIBudgetReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AIResponseCache" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptName" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL DEFAULT '1',
  "requestHash" TEXT NOT NULL,
  "output" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "AIResponseCache_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AIBudgetLedger" (
  "id",
  "userId",
  "monthStart",
  "budgetMicros",
  "spentMicros",
  "reservedMicros",
  "remainingMicros",
  "automationBudgetMicros",
  "automationSpentMicros",
  "automationReservedMicros",
  "automationRemainingMicros",
  "createdAt",
  "updatedAt"
)
SELECT
  CONCAT('ledger_', MD5("userId" || DATE_TRUNC('month', CURRENT_TIMESTAMP)::TEXT)),
  "userId",
  DATE_TRUNC('month', CURRENT_TIMESTAMP),
  5000000,
  LEAST(5000000::BIGINT, COALESCE(SUM("estimatedCostMicros"), 0))::INTEGER,
  0,
  GREATEST(0::BIGINT, 5000000::BIGINT - COALESCE(SUM("estimatedCostMicros"), 0))::INTEGER,
  1500000,
  0,
  0,
  1500000,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "AIUsageEvent"
WHERE "createdAt" >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
  AND "createdAt" < DATE_TRUNC('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'
GROUP BY "userId";

CREATE UNIQUE INDEX "AIUsageEvent_reservationId_key" ON "AIUsageEvent"("reservationId");
CREATE UNIQUE INDEX "AIBudgetLedger_userId_monthStart_key" ON "AIBudgetLedger"("userId", "monthStart");
CREATE INDEX "AIBudgetLedger_userId_updatedAt_idx" ON "AIBudgetLedger"("userId", "updatedAt");
CREATE UNIQUE INDEX "AIBudgetReservation_dedupeKey_key" ON "AIBudgetReservation"("dedupeKey");
CREATE INDEX "AIBudgetReservation_userId_createdAt_idx" ON "AIBudgetReservation"("userId", "createdAt");
CREATE INDEX "AIBudgetReservation_ledgerId_status_idx" ON "AIBudgetReservation"("ledgerId", "status");
CREATE INDEX "AIBudgetReservation_userId_feature_requestHash_idx" ON "AIBudgetReservation"("userId", "feature", "requestHash");
CREATE UNIQUE INDEX "ai_response_cache_key"
ON "AIResponseCache"("userId", "provider", "model", "promptName", "promptVersion", "requestHash");
CREATE INDEX "AIResponseCache_userId_expiresAt_idx" ON "AIResponseCache"("userId", "expiresAt");

ALTER TABLE "AIBudgetLedger" ADD CONSTRAINT "AIBudgetLedger_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIBudgetReservation" ADD CONSTRAINT "AIBudgetReservation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIBudgetReservation" ADD CONSTRAINT "AIBudgetReservation_ledgerId_fkey"
FOREIGN KEY ("ledgerId") REFERENCES "AIBudgetLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIResponseCache" ADD CONSTRAINT "AIResponseCache_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIUsageEvent" ADD CONSTRAINT "AIUsageEvent_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "AIBudgetReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
