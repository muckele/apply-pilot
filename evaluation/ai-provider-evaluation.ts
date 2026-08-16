import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { planApplication, type ApplicationPlanInput } from "@/lib/ai/application-plan";
import { getAiProviderForFeature, getAiRuntimeMode } from "@/lib/ai/config";
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

type PlanningCheck = {
  jobId: string;
  mode: string;
  schemaError: boolean;
  provider: string;
  model?: string;
  promptVersion?: string;
  requestHash?: string;
  costMicros: number;
  cacheHit?: boolean;
  unknownRequirementIds?: string[];
  unknownEvidenceIds?: string[];
  exaggeratedEvidenceIds?: string[];
  inventedNumericClaims?: string[];
  error?: string;
};

// Fully synthetic fixture: fictional company, role, and candidate with no private user
// data, so the default planning evaluation never transmits real information.
function syntheticPlanInput(): ApplicationPlanInput {
  return {
    job: {
      title: "Synthetic Support Engineer",
      company: "ExampleCo",
      location: "Remote",
      remoteStatus: "REMOTE",
      salaryMin: 90_000,
      salaryMax: 120_000,
      description:
        "Synthetic fixture posting. Provide customer-facing technical support, write SQL diagnostics, and document workflows. This fixture contains no real user data.",
      requirements: ["Customer support experience", "SQL diagnostics"],
      preferredQualifications: ["SaaS operations familiarity"],
      detectedTechStack: ["SQL", "JavaScript"]
    },
    resume: {
      summary: "Synthetic fixture candidate: customer-facing technical generalist.",
      skills: ["SQL", "JavaScript", "Customer support"],
      achievements: ["Resolved 40 synthetic fixture tickets per week"],
      workHistory: [
        {
          title: "Support Engineer",
          company: "FixtureCorp",
          startDate: "2022",
          endDate: "2024",
          highlights: ["Wrote SQL diagnostics for synthetic fixture issues"]
        }
      ],
      projects: [],
      education: [],
      certifications: []
    },
    profile: {
      careerGoals: "Synthetic fixture career goal.",
      preferredRoles: ["Support Engineer"],
      preferredLocations: ["Remote"],
      remotePreference: "REMOTE",
      salaryTargetMin: null,
      skillsToEmphasize: ["SQL"],
      skillsNotToExaggerate: []
    }
  };
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

  const planTop = boundedInteger(process.env.AI_EVAL_PLAN_TOP, 0, 3);
  const planningMode = process.env.KIMI_EVAL_MODE?.trim() || "synthetic";
  const planningChecks: PlanningCheck[] = [];
  if (planTop > 0) {
    if (!["synthetic", "sanitized", "real"].includes(planningMode)) {
      throw new Error("KIMI_EVAL_MODE must be one of synthetic, sanitized, or real.");
    }
    const planningProvider = getAiProviderForFeature("APPLICATION_PLAN");
    if (planningProvider === "kimi") {
      process.stderr.write(
        "Application planning evaluation sends a privacy-minimized payload (no contact details, raw resume text, file data, or answer-vault content) to Moonshot. reasoning_content is never persisted.\n"
      );
      if (getAiRuntimeMode("kimi") === "local") {
        throw new Error("APPLICATION_PLAN routes to Kimi but Kimi is not configured (MOONSHOT_API_KEY missing or AI disabled).");
      }
      if (planningMode === "real" && process.env.KIMI_EVAL_DATA_ACKNOWLEDGED !== "true") {
        throw new Error(
          "Set KIMI_EVAL_DATA_ACKNOWLEDGED=true to approve sending real resume and job data to Moonshot for planning evaluation."
        );
      }
    }
    const planningCandidates: Array<{ jobId: string; input: ApplicationPlanInput }> =
      planningMode === "synthetic"
        ? [{ jobId: "synthetic", input: syntheticPlanInput() }]
        : tailoringCandidates.slice(0, planTop).map((candidate) => ({ jobId: candidate.jobId, input: candidate.input }));
    for (const [index, candidate] of planningCandidates.entries()) {
      await paceProviderCalls();
      try {
        const plan = await planApplication(candidate.input, user.id, { highCostConfirmed: true });
        if (!plan.usage.cacheHit) lastProviderCompletion = Date.now();
        planningChecks.push({
          jobId: candidate.jobId,
          mode: planningMode,
          schemaError: false,
          provider: plan.provider,
          model: plan.model,
          promptVersion: plan.promptVersion,
          requestHash: plan.requestHash,
          costMicros: plan.usage.estimatedCostMicros,
          cacheHit: plan.usage.cacheHit,
          unknownRequirementIds: plan.unknownRequirementIds,
          unknownEvidenceIds: plan.unknownEvidenceIds,
          exaggeratedEvidenceIds: plan.exaggeratedEvidenceIds,
          inventedNumericClaims: plan.inventedNumericClaims
        });
      } catch (error) {
        planningChecks.push({
          jobId: candidate.jobId,
          mode: planningMode,
          schemaError: true,
          provider: planningProvider,
          costMicros: 0,
          error: error instanceof Error ? error.name : "UnknownError"
        });
      }
      process.stderr.write(`Planned application ${index + 1}/${planningCandidates.length} (${planningMode}).\n`);
    }
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
    ...tailoringChecks.map((result) => result.costMicros),
    ...planningChecks.map((check) => check.costMicros)
  ].reduce((sum, value) => sum + value, 0);
  const gates = {
    twentyJobsEvaluated: jobs.length === 20,
    allSchemasValid: results.length === jobs.length,
    noUnsupportedSupportedKeywords: publicResults.every((result) => result.unsupportedSupportedKeywords.length === 0),
    noInventedNumericClaims: tailoringChecks.every((result) => result.inventedNumericClaims.length === 0),
    planSchemasValid: planningChecks.every((check) => !check.schemaError),
    noUnsupportedPlanEvidence: planningChecks.every(
      (check) =>
        (check.unknownRequirementIds?.length ?? 0) === 0 &&
        (check.unknownEvidenceIds?.length ?? 0) === 0 &&
        (check.exaggeratedEvidenceIds?.length ?? 0) === 0
    ),
    noPlanInventedNumbers: planningChecks.every((check) => (check.inventedNumericClaims?.length ?? 0) === 0),
    planProviderMatchesOverride: planningChecks.every(
      (check) => check.provider === getAiProviderForFeature("APPLICATION_PLAN")
    )
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
    tailoringChecks,
    planning: { mode: planTop > 0 ? planningMode : null, checks: planningChecks }
  };

  const outputDirectory = path.join(process.cwd(), "evaluation-results");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `gemini-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ...report, results: undefined, tailoringChecks: undefined, planning: { ...report.planning, checks: undefined }, outputPath }, null, 2)}\n`
  );
  if (!report.passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
