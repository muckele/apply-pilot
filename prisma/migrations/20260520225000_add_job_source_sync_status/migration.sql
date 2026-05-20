-- Track configurable job-source sync health for the settings UI and cron runs.
ALTER TABLE "JobSource" ADD COLUMN IF NOT EXISTS "lastSyncStatus" TEXT;
ALTER TABLE "JobSource" ADD COLUMN IF NOT EXISTS "lastSyncError" TEXT;

CREATE INDEX IF NOT EXISTS "JobSource_userId_syncEnabled_idx" ON "JobSource"("userId", "syncEnabled");
