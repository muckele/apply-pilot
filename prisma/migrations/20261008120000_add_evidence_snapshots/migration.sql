CREATE TABLE "EvidenceSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobPostingId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "reviewedAnalysisId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceResumeUpdatedAt" TIMESTAMP(3) NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "sourceProjectionHash" TEXT NOT NULL,
    "gapProjectionHash" TEXT NOT NULL,
    "reviewPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvidenceSnapshot_schemaVersion_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "EvidenceSnapshot_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EvidenceSnapshot_snapshotHash_check" CHECK ("snapshotHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EvidenceSnapshot_sourceProjectionHash_check" CHECK ("sourceProjectionHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EvidenceSnapshot_gapProjectionHash_check" CHECK ("gapProjectionHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EvidenceSnapshot_reviewPayload_check" CHECK (jsonb_typeof("reviewPayload") = 'object')
);

ALTER TABLE "JobPosting" ADD COLUMN "currentEvidenceSnapshotId" TEXT;
ALTER TABLE "JobPosting" ADD COLUMN "evidenceSnapshotGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AIAnalysis" ADD COLUMN "evidenceSnapshotId" TEXT;
ALTER TABLE "ResumeVersion" ADD COLUMN "evidenceSnapshotId" TEXT;
ALTER TABLE "GeneratedDocument" ADD COLUMN "evidenceSnapshotId" TEXT;

CREATE UNIQUE INDEX "EvidenceSnapshot_userId_requestId_key"
    ON "EvidenceSnapshot"("userId", "requestId");
CREATE INDEX "EvidenceSnapshot_userId_jobPostingId_snapshotHash_idx"
    ON "EvidenceSnapshot"("userId", "jobPostingId", "snapshotHash");
CREATE INDEX "EvidenceSnapshot_userId_jobPostingId_createdAt_idx"
    ON "EvidenceSnapshot"("userId", "jobPostingId", "createdAt");
CREATE INDEX "EvidenceSnapshot_jobPostingId_idx"
    ON "EvidenceSnapshot"("jobPostingId");
CREATE INDEX "EvidenceSnapshot_resumeId_sourceResumeUpdatedAt_idx"
    ON "EvidenceSnapshot"("resumeId", "sourceResumeUpdatedAt");
CREATE INDEX "EvidenceSnapshot_reviewedAnalysisId_idx"
    ON "EvidenceSnapshot"("reviewedAnalysisId");
CREATE INDEX "JobPosting_currentEvidenceSnapshotId_idx"
    ON "JobPosting"("currentEvidenceSnapshotId");
CREATE INDEX "AIAnalysis_evidenceSnapshotId_idx"
    ON "AIAnalysis"("evidenceSnapshotId");
CREATE INDEX "ResumeVersion_evidenceSnapshotId_idx"
    ON "ResumeVersion"("evidenceSnapshotId");
CREATE INDEX "GeneratedDocument_evidenceSnapshotId_idx"
    ON "GeneratedDocument"("evidenceSnapshotId");

ALTER TABLE "JobPosting"
    ADD CONSTRAINT "JobPosting_evidenceSnapshotGeneration_check"
    CHECK ("evidenceSnapshotGeneration" >= 0);

ALTER TABLE "EvidenceSnapshot"
    ADD CONSTRAINT "EvidenceSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceSnapshot"
    ADD CONSTRAINT "EvidenceSnapshot_jobPostingId_fkey"
    FOREIGN KEY ("jobPostingId") REFERENCES "JobPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceSnapshot"
    ADD CONSTRAINT "EvidenceSnapshot_resumeId_fkey"
    FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceSnapshot"
    ADD CONSTRAINT "EvidenceSnapshot_reviewedAnalysisId_fkey"
    FOREIGN KEY ("reviewedAnalysisId") REFERENCES "AIAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobPosting"
    ADD CONSTRAINT "JobPosting_currentEvidenceSnapshotId_fkey"
    FOREIGN KEY ("currentEvidenceSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIAnalysis"
    ADD CONSTRAINT "AIAnalysis_evidenceSnapshotId_fkey"
    FOREIGN KEY ("evidenceSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResumeVersion"
    ADD CONSTRAINT "ResumeVersion_evidenceSnapshotId_fkey"
    FOREIGN KEY ("evidenceSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeneratedDocument"
    ADD CONSTRAINT "GeneratedDocument_evidenceSnapshotId_fkey"
    FOREIGN KEY ("evidenceSnapshotId") REFERENCES "EvidenceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "enforce_evidence_snapshot_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'EvidenceSnapshot rows are immutable'
            USING ERRCODE = '23514';
    END IF;

    -- Keep this parent-lock order stable so concurrent snapshot saves cannot deadlock.
    -- FOR SHARE conflicts with edits to every scope field checked below; KEY SHARE does not.
    PERFORM 1
    FROM "JobPosting" AS job
    WHERE job."id" = NEW."jobPostingId"
      AND job."userId" = NEW."userId"
    FOR SHARE OF job;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EvidenceSnapshot source scope is invalid'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM "Resume" AS resume
    WHERE resume."id" = NEW."resumeId"
      AND resume."userId" = NEW."userId"
      AND resume."updatedAt" = NEW."sourceResumeUpdatedAt"
    FOR SHARE OF resume;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EvidenceSnapshot source scope is invalid'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM "AIAnalysis" AS analysis
    WHERE analysis."id" = NEW."reviewedAnalysisId"
      AND analysis."userId" = NEW."userId"
      AND analysis."jobPostingId" = NEW."jobPostingId"
      AND analysis."type" = 'JOB_MATCH'
    FOR SHARE OF analysis;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EvidenceSnapshot source scope is invalid'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "EvidenceSnapshot_scope_and_immutability"
    BEFORE INSERT OR UPDATE ON "EvidenceSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "enforce_evidence_snapshot_scope"();

CREATE FUNCTION "enforce_evidence_binding_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    bound_owner_id TEXT;
    bound_snapshot_id TEXT;
    bound_job_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'JobPosting' THEN
        IF TG_OP = 'UPDATE' THEN
            IF NEW."evidenceSnapshotGeneration" < OLD."evidenceSnapshotGeneration" THEN
                RAISE EXCEPTION 'Evidence snapshot generation cannot decrease'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW."currentEvidenceSnapshotId" IS NOT NULL
               AND NEW."currentEvidenceSnapshotId" IS DISTINCT FROM OLD."currentEvidenceSnapshotId"
               AND NEW."evidenceSnapshotGeneration" <> OLD."evidenceSnapshotGeneration" + 1 THEN
                RAISE EXCEPTION 'A new current evidence snapshot must advance generation exactly once'
                    USING ERRCODE = '23514';
            END IF;
            IF NEW."currentEvidenceSnapshotId" IS NOT DISTINCT FROM OLD."currentEvidenceSnapshotId"
               AND NEW."evidenceSnapshotGeneration" <> OLD."evidenceSnapshotGeneration" THEN
                RAISE EXCEPTION 'Evidence snapshot generation requires a new current snapshot'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        SELECT "userId", "id", "currentEvidenceSnapshotId"
          INTO bound_owner_id, bound_job_id, bound_snapshot_id
          FROM "JobPosting"
         WHERE "id" = NEW."id";
    ELSIF TG_TABLE_NAME = 'AIAnalysis' THEN
        SELECT "userId", "jobPostingId", "evidenceSnapshotId"
          INTO bound_owner_id, bound_job_id, bound_snapshot_id
          FROM "AIAnalysis"
         WHERE "id" = NEW."id";
    ELSIF TG_TABLE_NAME = 'ResumeVersion' THEN
        SELECT "userId", "jobPostingId", "evidenceSnapshotId"
          INTO bound_owner_id, bound_job_id, bound_snapshot_id
          FROM "ResumeVersion"
         WHERE "id" = NEW."id";
    ELSIF TG_TABLE_NAME = 'GeneratedDocument' THEN
        SELECT "userId", "jobPostingId", "evidenceSnapshotId"
          INTO bound_owner_id, bound_job_id, bound_snapshot_id
          FROM "GeneratedDocument"
         WHERE "id" = NEW."id";
    ELSE
        RAISE EXCEPTION 'Unsupported evidence snapshot binding table'
            USING ERRCODE = '23514';
    END IF;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF bound_snapshot_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF bound_job_id IS NULL THEN
        RAISE EXCEPTION 'Evidence snapshot binding requires a job'
            USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM "EvidenceSnapshot" AS snapshot
    WHERE snapshot."id" = bound_snapshot_id
      AND snapshot."userId" = bound_owner_id
      AND snapshot."jobPostingId" = bound_job_id
    FOR KEY SHARE OF snapshot;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evidence snapshot binding scope is invalid'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "JobPosting_evidence_binding_scope"
    AFTER INSERT OR UPDATE ON "JobPosting"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_evidence_binding_scope"();
CREATE CONSTRAINT TRIGGER "AIAnalysis_evidence_binding_scope"
    AFTER INSERT OR UPDATE ON "AIAnalysis"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_evidence_binding_scope"();
CREATE CONSTRAINT TRIGGER "ResumeVersion_evidence_binding_scope"
    AFTER INSERT OR UPDATE ON "ResumeVersion"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_evidence_binding_scope"();
CREATE CONSTRAINT TRIGGER "GeneratedDocument_evidence_binding_scope"
    AFTER INSERT OR UPDATE ON "GeneratedDocument"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_evidence_binding_scope"();
