-- Add approved API aggregator source types.
ALTER TYPE "JobSourceType" ADD VALUE IF NOT EXISTS 'ADZUNA';
ALTER TYPE "JobSourceType" ADD VALUE IF NOT EXISTS 'THEIRSTACK';
