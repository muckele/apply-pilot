-- D031 editable documents: generation citations, per-line edit provenance and review
-- confirmations for tailored résumés. Additive and nullable; existing rows stay NULL and are
-- treated as legacy documents until their owner reviews them. GeneratedDocument already has
-- a nullable "metadata" JSONB column, so no change is needed there.
ALTER TABLE "ResumeVersion" ADD COLUMN "metadata" JSONB;
