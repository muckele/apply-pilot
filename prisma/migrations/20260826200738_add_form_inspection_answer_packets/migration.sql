BEGIN;

-- Fail closed before any application data or schema changes.
DO $$
DECLARE
    issue_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "confidence" NOT BETWEEN 0 AND 100;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'CONFIDENCE_OUT_OF_RANGE count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM (
        SELECT 1
        FROM "ApplicationRunAnswer"
        GROUP BY "runId", "normalizedFieldKey"
        HAVING COUNT(*) > 1
    ) AS duplicates;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'DUPLICATE_LEGACY_IDENTITY group_count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer" AS answer
    INNER JOIN "ApplicationRun" AS run ON run."id" = answer."runId"
    WHERE answer."userId" <> run."userId";
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'ANSWER_RUN_USER_MISMATCH count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'PENDING'
      AND (
        "reviewedByUser" IS NOT FALSE
        OR "reviewedAt" IS NOT NULL
        OR "finalValueHash" IS NOT NULL
      );
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'PENDING_REVIEW_METADATA_INVALID count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'APPROVED'
      AND ("reviewedByUser" IS NOT TRUE OR "reviewedAt" IS NULL);
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'APPROVED_REVIEW_METADATA_INVALID count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'APPROVED'
      AND ("proposedValue" IS NULL OR btrim("proposedValue") = '');
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'APPROVED_PROPOSED_VALUE_MISSING count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'APPROVED'
      AND ("finalValueHash" IS NULL OR "finalValueHash" !~ '^[0-9a-f]{64}$');
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'APPROVED_FINAL_HASH_MALFORMED count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'APPROVED'
      AND "proposedValue" IS NOT NULL
      AND "finalValueHash" ~ '^[0-9a-f]{64}$'
      AND "finalValueHash" <> encode(
        sha256(convert_to("proposedValue", 'UTF8')),
        'hex'
      );
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'APPROVED_FINAL_HASH_MISMATCH count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'REJECTED'
      AND ("reviewedByUser" IS NOT TRUE OR "reviewedAt" IS NULL);
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'REJECTED_REVIEW_METADATA_INVALID count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'REJECTED' AND "finalValueHash" IS NOT NULL;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'REJECTED_FINAL_HASH_PRESENT count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "reviewedByUser" <> ("reviewedAt" IS NOT NULL);
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'REVIEW_FLAG_TIME_INCONSISTENT count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "finalValueHash" IS NOT NULL
      AND "finalValueHash" !~ '^[0-9a-f]{64}$';
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'FINAL_HASH_MALFORMED count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "sensitive" IS TRUE AND "proposedValue" IS NOT NULL;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'SENSITIVE_PLAINTEXT_PRESENT count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "valueRedacted" IS TRUE AND "proposedValue" IS NOT NULL;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'REDACTED_PLAINTEXT_PRESENT count=%', issue_count;
    END IF;
END $$;

-- Repair only database-null legacy arrays, preserving every existing element and order.
ALTER TABLE "ApplicationRunAnswer"
    ALTER COLUMN "sourceIds" SET DEFAULT ARRAY[]::TEXT[],
    ALTER COLUMN "evidenceIds" SET DEFAULT ARRAY[]::TEXT[];

UPDATE "ApplicationRunAnswer"
SET "sourceIds" = ARRAY[]::TEXT[]
WHERE "sourceIds" IS NULL;

UPDATE "ApplicationRunAnswer"
SET "evidenceIds" = ARRAY[]::TEXT[]
WHERE "evidenceIds" IS NULL;

ALTER TABLE "ApplicationRunAnswer"
    ALTER COLUMN "sourceIds" SET NOT NULL,
    ALTER COLUMN "evidenceIds" SET NOT NULL;

-- The added source value is not used until after this transaction commits.
ALTER TYPE "ApplicationAnswerSourceType" ADD VALUE 'COVER_LETTER';

CREATE TYPE "ApplicationFormFieldType" AS ENUM (
    'TEXT',
    'EMAIL',
    'TEL',
    'URL',
    'TEXTAREA',
    'SELECT_ONE',
    'SELECT_MANY',
    'RADIO_GROUP',
    'CHECKBOX_BOOLEAN',
    'CHECKBOX_GROUP',
    'NUMBER',
    'DATE',
    'FILE_UPLOAD',
    'UNSUPPORTED'
);

CREATE TYPE "ApplicationQuestionClassification" AS ENUM (
    'CONTACT',
    'PROFESSIONAL_LINK',
    'EXPERIENCE',
    'EDUCATION',
    'SKILL',
    'CITIZENSHIP_IMMIGRATION',
    'WORK_AUTHORIZATION',
    'SPONSORSHIP',
    'AVAILABILITY',
    'RELOCATION',
    'COMPENSATION',
    'DEMOGRAPHIC',
    'DISABILITY',
    'VETERAN',
    'CRIMINAL_HISTORY',
    'LEGAL_ATTESTATION',
    'DOCUMENT',
    'UNKNOWN'
);

CREATE TYPE "ApplicationAnswerDisposition" AS ENUM (
    'PROPOSABLE',
    'MANUAL_ONLY',
    'EXCLUDED',
    'UNSUPPORTED'
);

CREATE TYPE "ApplicationAnswerDispositionReason" AS ENUM (
    'NO_ELIGIBLE_SOURCE',
    'INVALID_SOURCE_VALUE',
    'AMBIGUOUS_SOURCE',
    'UNCONFIRMED_APPLICANT_CONTACT',
    'POLICY_EXCLUDED',
    'LEGAL_ATTESTATION',
    'V1_MANUAL_POLICY',
    'UNSUPPORTED_CONTROL',
    'AMBIGUOUS_FIELD',
    'AMBIGUOUS_CHOICES',
    'MULTIPLE_FILE_UPLOAD',
    'NO_SELECTED_DOCUMENT',
    'UNKNOWN_QUESTION'
);

CREATE TYPE "ApplicationAnswerReviewHashVersion" AS ENUM (
    'LEGACY_SCALAR_SHA256',
    'CANONICAL_PROPOSAL_V1'
);

CREATE TABLE "ApplicationRunFormInspection" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "normalizerVersion" INTEGER NOT NULL,
    "classifierVersion" INTEGER NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL,
    "formFingerprint" TEXT NOT NULL,
    "normalizedSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationRunFormInspection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationRunAnswerPacket" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "formInspectionId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "builderVersion" INTEGER NOT NULL,
    "policyHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "packetHash" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationRunAnswerPacket_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ApplicationRun"
    ADD COLUMN "currentAnswerPacketVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "currentFormInspectionVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ApplicationRunAnswer"
    ADD COLUMN "answerPacketId" TEXT,
    ADD COLUMN "classification" "ApplicationQuestionClassification",
    ADD COLUMN "disposition" "ApplicationAnswerDisposition",
    ADD COLUMN "dispositionReason" "ApplicationAnswerDispositionReason",
    ADD COLUMN "fieldFingerprint" TEXT,
    ADD COLUMN "fieldType" "ApplicationFormFieldType",
    ADD COLUMN "normalizedQuestion" TEXT,
    ADD COLUMN "proposal" JSONB,
    ADD COLUMN "reviewHashVersion" "ApplicationAnswerReviewHashVersion",
    ADD COLUMN "semanticFieldKey" TEXT,
    ADD COLUMN "sourceFingerprint" TEXT;

ALTER TABLE "ApplicationRunFormInspection"
    ADD CONSTRAINT "ApplicationRunFormInspection_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ApplicationRunFormInspection_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationRunAnswerPacket"
    ADD CONSTRAINT "ApplicationRunAnswerPacket_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "ApplicationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ApplicationRunAnswerPacket_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ApplicationRunAnswerPacket_formInspectionId_fkey"
        FOREIGN KEY ("formInspectionId") REFERENCES "ApplicationRunFormInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApplicationRunAnswer"
    ADD CONSTRAINT "ApplicationRunAnswer_answerPacketId_fkey"
        FOREIGN KEY ("answerPacketId") REFERENCES "ApplicationRunAnswerPacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ApplicationRunFormInspection_userId_runId_idx"
    ON "ApplicationRunFormInspection"("userId", "runId");
CREATE UNIQUE INDEX "ApplicationRunFormInspection_runId_version_key"
    ON "ApplicationRunFormInspection"("runId", "version");
CREATE INDEX "ApplicationRunAnswerPacket_userId_runId_idx"
    ON "ApplicationRunAnswerPacket"("userId", "runId");
CREATE INDEX "ApplicationRunAnswerPacket_formInspectionId_idx"
    ON "ApplicationRunAnswerPacket"("formInspectionId");
CREATE UNIQUE INDEX "ApplicationRunAnswerPacket_runId_version_key"
    ON "ApplicationRunAnswerPacket"("runId", "version");
CREATE INDEX "ApplicationRunAnswer_runId_idx"
    ON "ApplicationRunAnswer"("runId");
CREATE UNIQUE INDEX "ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key"
    ON "ApplicationRunAnswer"("answerPacketId", "normalizedFieldKey");

-- Label only exact, fully valid legacy approvals; never rewrite their hashes.
UPDATE "ApplicationRunAnswer"
SET "reviewHashVersion" = 'LEGACY_SCALAR_SHA256'
WHERE "status" = 'APPROVED'
  AND "reviewedByUser" IS TRUE
  AND "reviewedAt" IS NOT NULL
  AND "proposedValue" IS NOT NULL
  AND btrim("proposedValue") <> ''
  AND "finalValueHash" ~ '^[0-9a-f]{64}$'
  AND "finalValueHash" = encode(
    sha256(convert_to("proposedValue", 'UTF8')),
    'hex'
  );

DO $$
DECLARE
    issue_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" = 'APPROVED'
      AND "reviewHashVersion" IS DISTINCT FROM 'LEGACY_SCALAR_SHA256';
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'LEGACY_APPROVED_HASH_VERSION_BACKFILL_INCOMPLETE count=%', issue_count;
    END IF;

    SELECT COUNT(*) INTO issue_count
    FROM "ApplicationRunAnswer"
    WHERE "status" <> 'APPROVED' AND "reviewHashVersion" IS NOT NULL;
    IF issue_count > 0 THEN
        RAISE EXCEPTION 'LEGACY_NONAPPROVED_HASH_VERSION_PRESENT count=%', issue_count;
    END IF;
END $$;

ALTER TABLE "ApplicationRun"
    ADD CONSTRAINT "application_run_form_inspection_version_nonnegative_ck"
        CHECK ("currentFormInspectionVersion" >= 0),
    ADD CONSTRAINT "application_run_answer_packet_version_nonnegative_ck"
        CHECK ("currentAnswerPacketVersion" >= 0);

ALTER TABLE "ApplicationRunFormInspection"
    ADD CONSTRAINT "form_inspection_component_versions_positive_ck"
        CHECK (
            "version" > 0
            AND "schemaVersion" > 0
            AND "normalizerVersion" > 0
            AND "classifierVersion" > 0
            AND "fingerprintVersion" > 0
        ),
    ADD CONSTRAINT "form_inspection_fingerprint_sha256_ck"
        CHECK ("formFingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "form_inspection_snapshot_object_ck"
        CHECK (jsonb_typeof("normalizedSnapshot") = 'object');

ALTER TABLE "ApplicationRunAnswerPacket"
    ADD CONSTRAINT "answer_packet_component_versions_positive_ck"
        CHECK ("version" > 0 AND "schemaVersion" > 0 AND "builderVersion" > 0),
    ADD CONSTRAINT "answer_packet_hashes_sha256_ck"
        CHECK (
            "policyHash" ~ '^[0-9a-f]{64}$'
            AND "inputHash" ~ '^[0-9a-f]{64}$'
            AND "packetHash" ~ '^[0-9a-f]{64}$'
        ),
    ADD CONSTRAINT "answer_packet_reviewed_after_created_ck"
        CHECK ("reviewedAt" IS NULL OR "reviewedAt" >= "createdAt");

ALTER TABLE "ApplicationRunAnswer"
    ADD CONSTRAINT "run_answer_confidence_range_ck"
        CHECK ("confidence" BETWEEN 0 AND 100),
    ADD CONSTRAINT "run_answer_proposal_shape_ck"
        CHECK (
            "proposal" IS NULL
            OR COALESCE(
                jsonb_typeof("proposal") = 'object'
                AND "proposal" ? 'kind'
                AND jsonb_typeof("proposal" -> 'kind') = 'string'
                AND "proposal" ->> 'kind' IN (
                    'SCALAR',
                    'BOOLEAN',
                    'OPTIONS',
                    'DOCUMENT_REFERENCE'
                ),
                false
            )
        ),
    ADD CONSTRAINT "run_answer_packet_identity_ck"
        CHECK (
            "answerPacketId" IS NULL
            OR (
                "normalizedQuestion" IS NOT NULL
                AND "normalizedFieldKey" IS NOT NULL
                AND "normalizedFieldKey" ~ '^[0-9a-f]{64}$'
                AND "fieldFingerprint" IS NOT NULL
                AND "fieldFingerprint" ~ '^[0-9a-f]{64}$'
                AND "fieldType" IS NOT NULL
                AND "classification" IS NOT NULL
                AND "disposition" IS NOT NULL
                AND "proposedValue" IS NULL
                AND cardinality("evidenceIds") = 0
            )
        ),
    ADD CONSTRAINT "run_answer_packet_disposition_ck"
        CHECK (
            "answerPacketId" IS NULL
            OR (
                "disposition" = 'PROPOSABLE'
                AND "proposal" IS NOT NULL
                AND "dispositionReason" IS NULL
                AND "requiresReview" IS TRUE
                AND "sensitive" IS FALSE
                AND "valueRedacted" IS FALSE
                AND "sourceType" IS NOT NULL
                AND cardinality("sourceIds") = 1
                AND "sourceFingerprint" IS NOT NULL
                AND "sourceFingerprint" ~ '^[0-9a-f]{64}$'
                AND cardinality("evidenceIds") = 0
                AND "confidence" BETWEEN 0 AND 100
            )
            OR (
                "disposition" IN ('MANUAL_ONLY', 'EXCLUDED', 'UNSUPPORTED')
                AND "proposal" IS NULL
                AND "dispositionReason" IS NOT NULL
                AND "requiresReview" IS FALSE
                AND "status" = 'PENDING'
                AND "reviewedByUser" IS FALSE
                AND "reviewedAt" IS NULL
                AND "finalValueHash" IS NULL
                AND "reviewHashVersion" IS NULL
                AND "sourceType" IS NULL
                AND cardinality("sourceIds") = 0
                AND cardinality("evidenceIds") = 0
                AND "sourceFingerprint" IS NULL
                AND "confidence" = 0
            )
        ),
    ADD CONSTRAINT "run_answer_packet_privacy_ck"
        CHECK (
            "answerPacketId" IS NULL
            OR (
                "disposition" = 'EXCLUDED'
                AND "sensitive" IS TRUE
                AND "valueRedacted" IS TRUE
            )
            OR (
                "disposition" <> 'EXCLUDED'
                AND "sensitive" IS FALSE
                AND "valueRedacted" IS FALSE
            )
        ),
    ADD CONSTRAINT "run_answer_packet_review_lifecycle_ck"
        CHECK (
            "answerPacketId" IS NULL
            OR (
                "status" = 'PENDING'
                AND "reviewedByUser" IS FALSE
                AND "reviewedAt" IS NULL
                AND "finalValueHash" IS NULL
            )
            OR (
                "status" = 'APPROVED'
                AND "disposition" = 'PROPOSABLE'
                AND "reviewedByUser" IS TRUE
                AND "reviewedAt" IS NOT NULL
                AND "finalValueHash" IS NOT NULL
                AND "finalValueHash" ~ '^[0-9a-f]{64}$'
            )
            OR (
                "status" = 'REJECTED'
                AND "disposition" = 'PROPOSABLE'
                AND "reviewedByUser" IS TRUE
                AND "reviewedAt" IS NOT NULL
                AND "finalValueHash" IS NULL
            )
        ),
    ADD CONSTRAINT "run_answer_packet_hash_versions_ck"
        CHECK (
            "answerPacketId" IS NULL
            OR (
                "status" = 'APPROVED'
                AND "reviewHashVersion" = 'CANONICAL_PROPOSAL_V1'
            )
            OR (
                "status" IN ('PENDING', 'REJECTED')
                AND "reviewHashVersion" IS NULL
            )
        );

CREATE UNIQUE INDEX "ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key"
    ON "ApplicationRunAnswer"("runId", "normalizedFieldKey")
    WHERE "answerPacketId" IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_metadata
        INNER JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
        WHERE index_relation.relname = 'ApplicationRunAnswer_answerPacketId_normalizedFieldKey_key'
          AND index_metadata.indisunique
          AND index_metadata.indisvalid
    ) THEN
        RAISE EXCEPTION 'PACKET_UNIQUE_INDEX_NOT_VALID';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_metadata
        INNER JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
        WHERE index_relation.relname = 'ApplicationRunAnswer_legacy_runId_normalizedFieldKey_key'
          AND index_metadata.indisunique
          AND index_metadata.indisvalid
    ) THEN
        RAISE EXCEPTION 'LEGACY_UNIQUE_INDEX_NOT_VALID';
    END IF;
END $$;

DROP INDEX "ApplicationRunAnswer_runId_normalizedFieldKey_key";

COMMIT;
