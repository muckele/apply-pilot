-- Additive: when a board sync found the ATS-hosted job page switched off, so the job is applied
-- for on the company's own site. One nullable column, no backfill; no existing column changes.
-- Production applies it with forward-only `prisma migrate deploy`.
-- AlterTable
ALTER TABLE "JobPosting" ADD COLUMN     "atsApplyPageOffAt" TIMESTAMP(3);
