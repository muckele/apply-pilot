import {
  SYNTHETIC_CORRECTION_FLOW_FACT,
  SYNTHETIC_CORRECTION_FLOW_FIXTURE,
  SYNTHETIC_CORRECTION_FLOW_REQUIREMENT
} from "@/evaluation/correction-flow-qualification-fixture";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";
import type {
  CorrectionFlowProviderFetches,
  CorrectionFlowProviderCredentials
} from "@/lib/ai/correction-flow-provider-adapter";
import type { CorrectionFlowProviderStage } from "@/lib/ai/correction-flow-qualification";
import type { MatchInput } from "@/lib/ai/job-match";

export const SYNTHETIC_CORRECTION_FLOW_DUMMY_CREDENTIALS: CorrectionFlowProviderCredentials =
  Object.freeze({
    geminiApiKey: "offline-dummy-gemini-key",
    openAiApiKey: "offline-dummy-openai-key"
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
  return {
    professionalSummary: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
    skillsSection: [],
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText: `${SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary}\n${SYNTHETIC_CORRECTION_FLOW_FACT}`,
    claimEvidence: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary,
      citations: [{
        ref: "resume.summary",
        excerpt: SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.summary
      }]
    }, {
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
    }]
  };
}

export function syntheticCoverLetterOutput() {
  return {
    title: "Synthetic Employer Service Operations Director cover letter",
    coverLetter: `Dear Synthetic Employer Hiring Team,\n\nI am writing to apply for the Service Operations Director position.\n\n${SYNTHETIC_CORRECTION_FLOW_FACT}\n\nSincerely,\nTaylor Boundary`,
    angle: "Use only current reviewed evidence.",
    claimsUsed: [{
      claim: SYNTHETIC_CORRECTION_FLOW_FACT,
      citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: SYNTHETIC_CORRECTION_FLOW_FACT }]
    }]
  };
}

function providerResponse(value: unknown, provider: "gemini" | "openai") {
  if (provider === "gemini") {
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
  return new Response(JSON.stringify({
    id: "safe-openai-id",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(value) }
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0 }
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "safe-openai-id" }
  });
}

export function createSyntheticCorrectionFlowProviderFetches({
  onRequest
}: {
  onRequest?: (stage: CorrectionFlowProviderStage, body: unknown) => void;
} = {}): CorrectionFlowProviderFetches {
  let geminiCall = 0;
  let openAiCall = 0;
  return {
    gemini: async (_input, init) => {
      const stage = geminiCall === 0 ? "initial_match" : "updated_match";
      onRequest?.(stage, JSON.parse(String(init?.body)));
      const output = geminiCall++ === 0
        ? syntheticInitialMatchOutput()
        : syntheticUpdatedMatchOutput();
      return providerResponse(output, "gemini");
    },
    openai: async (_input, init) => {
      const stage = openAiCall === 0 ? "tailored_resume" : "cover_letter";
      onRequest?.(stage, JSON.parse(String(init?.body)));
      const output = openAiCall++ === 0
        ? syntheticTailoredResumeOutput()
        : syntheticCoverLetterOutput();
      return providerResponse(output, "openai");
    }
  };
}
