-- Add SerpApi Google Jobs as an approved API job source.
ALTER TYPE "JobSourceType" ADD VALUE IF NOT EXISTS 'SERPAPI';
