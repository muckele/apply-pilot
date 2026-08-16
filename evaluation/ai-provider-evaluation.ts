import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAiRuntimeMode } from "@/lib/ai/config";
import { scoreJobMatch, type MatchInput } from "@/lib/ai/job-match";
import { tailorResume } from "@/lib/ai/resume";
import { prisma } from "@/lib/prisma";

function normalizedEvidence(input: MatchInput) {
  return JSON.stringify({ resume: input.resume, profile: input.profile }).toLowerCase();
}

function numbers(value: string) {
  return new Set(value.match(/(?:\$|\b)\d+(?:\.\d+)?%?/g) ?? []);
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(maximum, parsed) : fallback;
}

async function main() {
  if (process.env.AI_EVALUATION_ACKNOWLEDGED !== "true") {
    throw new Error("Set AI_EVALUATION_ACKNOWLEDGED=true to confirm this command may make paid AI requests.");
  }
  if (process.env.AI_ENABLED !== "true") {
    throw new Error("Set AI_ENABLED=true only for the controlled evaluation run.");
  }
  const runtimeMode = getAiRuntimeMode();
  if (runtimeMode === "local") {
    throw new Error(
      "The controlled evaluation requires a configured paid provider. Disable AI mock mode and provide the selected provider key."
    );
  }

  const email = process.env.AI_EVAL_USER_EMAIL?.trim();
  if (!email) throw new Error("AI_EVAL_USER_EMAIL is required.");
  const tailorTop = boundedInteger(process.env.AI_EVAL_TAILOR_TOP, 3, 5);
  const delayMs = boundedInteger(process.env.AI_EVAL_DELAY_MS, 8_000, 60_000);
  let lastProviderCompletion = 0;
  const paceProviderCalls = async () => {
    const waitMs = Math.max(0, lastProviderCompletion + delayMs - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const [resume, profile, jobs] = await Promise.all([
    prisma.resume.findFirstOrThrow({ where: { userId: user.id, isMaster: true }, orderBy: { updatedAt: "desc" } }),
    prisma.userProfile.findUnique({ where: { userId: user.id } }),
    prisma.jobPosting.findMany({
      where: { userId: user.id, status: { notIn: ["ARCHIVED", "EXPIRED"] } },
      orderBy: [{ datePosted: "desc" }, { firstDiscoveredAt: "desc" }],
      take: 20
    })
  ]);

  const results = [];
  for (const [index, job] of jobs.entries()) {
    const input: MatchInput = {
      job: {
        title: job.title,
        company: job.company,
        location: job.location,
        remoteStatus: job.remoteStatus,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        description: job.description,
        requirements: job.requirements,
        preferredQualifications: job.preferredQualifications,
        detectedTechStack: job.detectedTechStack
      },
      resume: {
        summary: resume.summary,
        rawText: resume.rawText,
        skills: resume.skills,
        achievements: resume.achievements,
        workHistory: resume.workHistory
      },
      profile: profile
        ? {
            careerGoals: profile.careerGoals,
            preferredRoles: profile.preferredRoles,
            preferredLocations: profile.preferredLocations,
            remotePreference: profile.remotePreference,
            salaryTargetMin: profile.salaryTargetMin,
            skillsToEmphasize: profile.skillsToEmphasize,
            skillsNotToExaggerate: profile.skillsNotToExaggerate
          }
        : null
    };
    await paceProviderCalls();
    const match = await scoreJobMatch(input, user.id, { highCostConfirmed: true });
    if (!match.usage.cacheHit) lastProviderCompletion = Date.now();
    const evidence = normalizedEvidence(input);
    const unsupportedSupportedKeywords = match.supportedKeywords.filter(
      (keyword) => !evidence.includes(keyword.toLowerCase())
    );
    results.push({
      jobId: job.id,
      company: job.company,
      title: job.title,
      score: match.overallFitScore,
      confidence: match.confidenceScore,
      recommendation: match.recommendation,
      unsupportedSupportedKeywords,
      model: match.model,
      provider: match.usage.provider,
      costMicros: match.usage.estimatedCostMicros,
      cacheHit: match.usage.cacheHit,
      input
    });
    process.stderr.write(
      `Evaluated job ${index + 1}/${jobs.length} (${match.usage.cacheHit ? "cache" : match.usage.provider}).\n`
    );
  }

  const tailoringChecks = [];
  const tailoringCandidates = [...results].sort((a, b) => b.score - a.score).slice(0, tailorTop);
  for (const [index, candidate] of tailoringCandidates.entries()) {
    await paceProviderCalls();
    const tailored = await tailorResume(
      { job: candidate.input.job, resume, profile },
      resume.rawText ?? "",
      user.id,
      { highCostConfirmed: true }
    );
    if (!tailored.usage.cacheHit) lastProviderCompletion = Date.now();
    const sourceNumbers = numbers(resume.rawText ?? "");
    const inventedNumericClaims = tailored.bulletRewrites.flatMap((bullet) =>
      [...numbers(bullet.rewrite)].filter((value) => !sourceNumbers.has(value))
    );
    tailoringChecks.push({
      jobId: candidate.jobId,
      model: tailored.model,
      provider: tailored.usage.provider,
      costMicros: tailored.usage.estimatedCostMicros,
      unsupportedKeywordsDisclosed: tailored.unsupportedKeywords,
      inventedNumericClaims: [...new Set(inventedNumericClaims)]
    });
    process.stderr.write(
      `Tailored resume ${index + 1}/${tailoringCandidates.length} (${tailored.usage.cacheHit ? "cache" : tailored.usage.provider}).\n`
    );
  }

  const publicResults = results.map((result) => ({
    jobId: result.jobId,
    company: result.company,
    title: result.title,
    score: result.score,
    confidence: result.confidence,
    recommendation: result.recommendation,
    unsupportedSupportedKeywords: result.unsupportedSupportedKeywords,
    model: result.model,
    provider: result.provider,
    costMicros: result.costMicros,
    cacheHit: result.cacheHit
  }));
  const totalCostMicros = [
    ...publicResults.map((result) => result.costMicros),
    ...tailoringChecks.map((result) => result.costMicros)
  ].reduce((sum, value) => sum + value, 0);
  const gates = {
    twentyJobsEvaluated: jobs.length === 20,
    allSchemasValid: results.length === jobs.length,
    noUnsupportedSupportedKeywords: publicResults.every((result) => result.unsupportedSupportedKeywords.length === 0),
    noInventedNumericClaims: tailoringChecks.every((result) => result.inventedNumericClaims.length === 0)
  };
  const report = {
    generatedAt: new Date().toISOString(),
    userId: user.id,
    resumeId: resume.id,
    evaluatedJobs: jobs.length,
    tailoredJobs: tailoringChecks.length,
    totalCostMicros,
    totalCostUsd: totalCostMicros / 1_000_000,
    gates,
    passed: Object.values(gates).every(Boolean),
    results: publicResults,
    tailoringChecks
  };

  const outputDirectory = path.join(process.cwd(), "evaluation-results");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `gemini-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, results: undefined, tailoringChecks: undefined, outputPath }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
