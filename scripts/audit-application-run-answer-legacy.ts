import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

const AUDIT_MARKER = "APPLICATION_RUN_ANSWER_LEGACY_AUDIT";
const AUDIT_DATABASE_URL = "APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL";
const MAX_REPORTED_ROW_IDS = 25;

export type LegacyApplicationRunAnswerAuditSeverity = "BLOCKING" | "REPAIRABLE";

export type LegacyApplicationRunAnswerAuditFinding = {
  code: string;
  severity: LegacyApplicationRunAnswerAuditSeverity;
  count: number;
  rowIds: string[];
};

export type LegacyApplicationRunAnswerAuditConfig = {
  databaseUrl: string;
  expectedSchema: string;
};

type RawAuditFinding = {
  code: string;
  severity: LegacyApplicationRunAnswerAuditSeverity;
  count: number;
  rowIds: string[];
};

export class LegacyApplicationRunAnswerAuditSafetyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Legacy ApplicationRunAnswer audit safety validation failed.");
    this.name = "LegacyApplicationRunAnswerAuditSafetyError";
    this.code = code;
  }
}

export function resolveLegacyApplicationRunAnswerAuditConfig(
  environment: Readonly<Record<string, string | undefined>>
): LegacyApplicationRunAnswerAuditConfig {
  if (environment[AUDIT_MARKER] !== "1") {
    throw new LegacyApplicationRunAnswerAuditSafetyError("AUDIT_MARKER_REQUIRED");
  }

  const explicitUrl = environment[AUDIT_DATABASE_URL];
  if (!explicitUrl) {
    throw new LegacyApplicationRunAnswerAuditSafetyError("EXPLICIT_AUDIT_DATABASE_URL_REQUIRED");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(explicitUrl);
  } catch {
    throw new LegacyApplicationRunAnswerAuditSafetyError("INVALID_AUDIT_DATABASE_URL");
  }
  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new LegacyApplicationRunAnswerAuditSafetyError("POSTGRESQL_AUDIT_DATABASE_URL_REQUIRED");
  }

  const expectedSchema = parsedUrl.searchParams.get("schema") ?? "public";
  if (!expectedSchema) {
    throw new LegacyApplicationRunAnswerAuditSafetyError("EXPECTED_SCHEMA_REQUIRED");
  }

  return { databaseUrl: explicitUrl, expectedSchema };
}

export function formatLegacyApplicationRunAnswerAuditReport(
  findings: readonly LegacyApplicationRunAnswerAuditFinding[]
): string {
  return JSON.stringify(
    findings.map((finding) => ({
      code: finding.code,
      count: finding.count,
      rowIds: [...finding.rowIds].sort().slice(0, MAX_REPORTED_ROW_IDS)
    }))
  );
}

async function queryFindings(
  transaction: Prisma.TransactionClient
): Promise<LegacyApplicationRunAnswerAuditFinding[]> {
  const findings = await transaction.$queryRaw<RawAuditFinding[]>`
    WITH "auditFindings" ("code", "severity", "rowId") AS (
      SELECT 'SOURCE_IDS_NULL', 'REPAIRABLE', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."sourceIds" IS NULL

      UNION ALL

      SELECT 'EVIDENCE_IDS_NULL', 'REPAIRABLE', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."evidenceIds" IS NULL

      UNION ALL

      SELECT 'CONFIDENCE_OUT_OF_RANGE', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."confidence" NOT BETWEEN 0 AND 100

      UNION ALL

      SELECT 'DUPLICATE_LEGACY_IDENTITY', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      INNER JOIN (
        SELECT "runId", "normalizedFieldKey"
        FROM "ApplicationRunAnswer"
        GROUP BY "runId", "normalizedFieldKey"
        HAVING COUNT(*) > 1
      ) AS duplicate
        ON duplicate."runId" = answer."runId"
       AND duplicate."normalizedFieldKey" = answer."normalizedFieldKey"

      UNION ALL

      SELECT 'ANSWER_RUN_USER_MISMATCH', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      INNER JOIN "ApplicationRun" AS run ON run."id" = answer."runId"
      WHERE answer."userId" <> run."userId"

      UNION ALL

      SELECT 'PENDING_REVIEW_METADATA_INVALID', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'PENDING'
        AND (
          answer."reviewedByUser" IS NOT FALSE
          OR answer."reviewedAt" IS NOT NULL
          OR answer."finalValueHash" IS NOT NULL
        )

      UNION ALL

      SELECT 'APPROVED_REVIEW_METADATA_INVALID', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'APPROVED'
        AND (answer."reviewedByUser" IS NOT TRUE OR answer."reviewedAt" IS NULL)

      UNION ALL

      SELECT 'APPROVED_PROPOSED_VALUE_MISSING', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'APPROVED'
        AND (answer."proposedValue" IS NULL OR btrim(answer."proposedValue") = '')

      UNION ALL

      SELECT 'APPROVED_FINAL_HASH_MALFORMED', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'APPROVED'
        AND (
          answer."finalValueHash" IS NULL
          OR answer."finalValueHash" !~ '^[0-9a-f]{64}$'
        )

      UNION ALL

      SELECT 'APPROVED_FINAL_HASH_MISMATCH', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'APPROVED'
        AND answer."proposedValue" IS NOT NULL
        AND answer."finalValueHash" ~ '^[0-9a-f]{64}$'
        AND answer."finalValueHash" <>
          encode(sha256(convert_to(answer."proposedValue", 'UTF8')), 'hex')

      UNION ALL

      SELECT 'REJECTED_REVIEW_METADATA_INVALID', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'REJECTED'
        AND (answer."reviewedByUser" IS NOT TRUE OR answer."reviewedAt" IS NULL)

      UNION ALL

      SELECT 'REJECTED_FINAL_HASH_PRESENT', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."status" = 'REJECTED'
        AND answer."finalValueHash" IS NOT NULL

      UNION ALL

      SELECT 'REVIEW_FLAG_TIME_INCONSISTENT', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."reviewedByUser" <> (answer."reviewedAt" IS NOT NULL)

      UNION ALL

      SELECT 'FINAL_HASH_MALFORMED', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."finalValueHash" IS NOT NULL
        AND answer."finalValueHash" !~ '^[0-9a-f]{64}$'

      UNION ALL

      SELECT 'SENSITIVE_PLAINTEXT_PRESENT', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."sensitive" IS TRUE AND answer."proposedValue" IS NOT NULL

      UNION ALL

      SELECT 'REDACTED_PLAINTEXT_PRESENT', 'BLOCKING', answer."id"
      FROM "ApplicationRunAnswer" AS answer
      WHERE answer."valueRedacted" IS TRUE AND answer."proposedValue" IS NOT NULL
    )
    SELECT
      "code",
      "severity",
      COUNT(*)::int AS "count",
      (array_agg("rowId" ORDER BY "rowId"))[1:${MAX_REPORTED_ROW_IDS}] AS "rowIds"
    FROM "auditFindings"
    GROUP BY "code", "severity"
    ORDER BY "code"
  `;

  return findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    count: Number(finding.count),
    rowIds: finding.rowIds
  }));
}

export async function auditLegacyApplicationRunAnswers(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<LegacyApplicationRunAnswerAuditFinding[]> {
  const config = resolveLegacyApplicationRunAnswerAuditConfig(environment);
  const client = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  try {
    return await client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const readOnlyRows = await transaction.$queryRawUnsafe<Array<{ transaction_read_only: string }>>(
        "SHOW transaction_read_only"
      );
      if (readOnlyRows[0]?.transaction_read_only !== "on") {
        throw new LegacyApplicationRunAnswerAuditSafetyError("READ_ONLY_TRANSACTION_REQUIRED");
      }

      const schemaRows = await transaction.$queryRaw<Array<{ currentSchema: string | null }>>`
        SELECT current_schema() AS "currentSchema"
      `;
      if (schemaRows[0]?.currentSchema !== config.expectedSchema) {
        throw new LegacyApplicationRunAnswerAuditSafetyError("AUDIT_SCHEMA_MISMATCH");
      }

      return queryFindings(transaction);
    });
  } finally {
    await client.$disconnect();
  }
}

async function main(): Promise<void> {
  try {
    const findings = await auditLegacyApplicationRunAnswers(process.env);
    process.stdout.write(`${formatLegacyApplicationRunAnswerAuditReport(findings)}\n`);
    if (findings.some((finding) => finding.severity === "BLOCKING")) process.exitCode = 1;
  } catch (error: unknown) {
    const code =
      error instanceof LegacyApplicationRunAnswerAuditSafetyError ? error.code : "AUDIT_EXECUTION_FAILED";
    process.stderr.write(`[legacy-answer-audit] ${code}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void main();
}
