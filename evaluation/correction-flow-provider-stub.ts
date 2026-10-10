import {
  SYNTHETIC_CORRECTION_FLOW_FACT,
  SYNTHETIC_CORRECTION_FLOW_FIXTURE,
  SYNTHETIC_CORRECTION_FLOW_REQUIREMENT
} from "@/evaluation/correction-flow-qualification-fixture";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import type {
  CorrectionFlowProviderFetches,
  CorrectionFlowProviderCredentials
} from "@/lib/ai/correction-flow-provider-adapter";
import type { CorrectionFlowProviderStage } from "@/lib/ai/correction-flow-qualification";
import type { MatchInput } from "@/lib/ai/job-match";

export const SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS: CorrectionFlowProviderCredentials =
  Object.freeze({
    geminiApiKey: "offline-dummy-gemini-key"
  });

export function syntheticCorrectionFlowMatchInput(reviewed: boolean): MatchInput {
  return {
    job: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.job) as MatchInput["job"],
    resume: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume) as NonNullable<MatchInput["resume"]>,
    profile: structuredClone(SYNTHETIC_CORRECTION_FLOW_FIXTURE.profile) as NonNullable<MatchInput["profile"]>,
    reviewedEvidence: reviewed ? {
      schema: "apply-pilot/job-match-reviewed-evidence/v1",
      snapshotId: "synthetic-snapshot",
      snapshotHash: "a".repeat(64),
      facts: [{
        gapId: "gap:0",
        fact: SYNTHETIC_CORRECTION_FLOW_FACT,
        sourceRef: null,
        provenance: "OWNER_ATTESTED"
      }],
      unresolvedGapIds: []
    } : null
  };
}

export function syntheticCorrectionFlowDocumentPayload(): ApplicationDocumentPayload {
  const input = syntheticCorrectionFlowMatchInput(true);
  return {
    job: input.job,
    resume: input.resume,
    profile: input.profile,
    reviewedEvidence: input.reviewedEvidence as unknown as Record<string, unknown>
  };
}

export function syntheticInitialMatchOutput() {
  return {
    contractVersion: "3",
    overallFitScore: 55,
    resumeKeywordScore: 70,
    skillsMatchScore: 70,
    experienceMatchScore: 70,
    careerGoalScore: 80,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 80,
    confidenceBasis: "Synthetic qualification fixture.",
    factualMatches: [],
    requirementGaps: [{
      requirement: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT,
      jobRequirement: { ref: "job.requirements[0]", excerpt: SYNTHETIC_CORRECTION_FLOW_REQUIREMENT },
      missingKeywords: ["Quenby"]
    }],
    advice: {
      keywordsToEmphasize: [],
      resumeAngle: "Use current reviewed evidence.",
      coverLetterAngle: "Use current reviewed evidence."
    },
    recommendation: "consider"
  } as const;
}

export function syntheticUpdatedMatchOutput() {
  return {
    ...syntheticInitialMatchOutput(),
    overallFitScore: 90,
    requirementGaps: [],
    recommendation: "apply now"
  } as const;
}

export function syntheticTailoredResumeOutput() {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const facts = buildApplicationDocumentFactCatalog(payload);
  const summaryFactId = facts.find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary)?.factId;
  const reviewedFactId = facts.find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FACT)?.factId;
  if (!summaryFactId || !reviewedFactId) throw new Error("Synthetic document facts are incomplete.");
  return {
    professionalSummary: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
    professionalSummaryFactId: summaryFactId,
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims: [{ claim: SYNTHETIC_CORRECTION_FLOW_FACT, factId: reviewedFactId }],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: `${SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary}\n${SYNTHETIC_CORRECTION_FLOW_FACT}`
  };
}

export function syntheticCoverLetterOutput() {
  const reviewedFactId = buildApplicationDocumentFactCatalog(syntheticCorrectionFlowDocumentPayload())
    .find((fact) => fact.excerpt === SYNTHETIC_CORRECTION_FLOW_FACT)?.factId;
  if (!reviewedFactId) throw new Error("Synthetic reviewed fact is missing.");
  return {
    title: "Synthetic Employer Service Operations Director cover letter",
    coverLetter: `Dear Synthetic Employer Hiring Team,\n\nI am writing to apply for the Service Operations Director position.\n\n${SYNTHETIC_CORRECTION_FLOW_FACT}\n\nSincerely,\nTaylor Boundary`,
    angle: "Use only current reviewed evidence.",
    claimsUsed: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      factId: reviewedFactId
    }]
  };
}

function providerResponse(value: unknown) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 0,
      totalTokenCount: 150
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "safe-gemini-id" }
  });
}

export function createSyntheticCorrectionFlowProviderFetches({
  onRequest
}: {
  onRequest?: (stage: CorrectionFlowProviderStage, body: unknown) => void;
} = {}): CorrectionFlowProviderFetches {
  let geminiCall = 0;
  return {
    gemini: async (_input, init) => {
      const stages = ["initial_match", "updated_match", "tailored_resume", "cover_letter"] as const;
      const outputs = [
        syntheticInitialMatchOutput(),
        syntheticUpdatedMatchOutput(),
        syntheticTailoredResumeOutput(),
        syntheticCoverLetterOutput()
      ] as const;
      const stage = stages[geminiCall];
      const output = outputs[geminiCall];
      if (!stage || !output) throw new Error("Unexpected synthetic Gemini call.");
      onRequest?.(stage, JSON.parse(String(init?.body)));
      geminiCall += 1;
      return providerResponse(output);
    }
  };
}
