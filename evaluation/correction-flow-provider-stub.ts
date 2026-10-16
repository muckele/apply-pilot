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

export function syntheticTailoredResumeOutput(payload = syntheticCorrectionFlowDocumentPayload()) {
  if (!payload.resume || typeof payload.resume.rawText !== "string" || typeof payload.resume.summary !== "string" || !Array.isArray(payload.resume.skills)) throw new Error("Synthetic source resume is incomplete.");
  const facts = buildApplicationDocumentFactCatalog(payload);
  const factId = (value: string) => {
    const normalized = value.trim().replace(/^[-*•▪◦–—]\s+/u, "");
    const selected = facts.find((fact) => fact.excerpt === normalized)?.factId;
    if (!selected) throw new Error(`Synthetic document fact is missing: ${normalized}`);
    return selected;
  };
  const resumeText = payload.resume.rawText.replace(
    "Credential ID: CSOP-24017",
    `Credential ID: CSOP-24017\n${SYNTHETIC_CORRECTION_FLOW_FACT}`
  ).replace(
    "• Managed onboarding and support programs for enterprise customers across three product teams.\n• Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",
    "• Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.\n• Managed onboarding and support programs for enterprise customers across three product teams."
  ).replace(
    "• Maintained incident records and handoff notes for customer support and engineering teams.\n• Prepared service-level reports and checked underlying support records for completeness.",
    "• Prepared service-level reports and checked underlying support records for completeness.\n• Maintained incident records and handoff notes for customer support and engineering teams."
  );
  const heading = /^(?:SUMMARY|PROFILE|SKILLS|EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|ACHIEVEMENTS|ADDITIONAL INFORMATION)$/u;
  const resumeTextClaims = resumeText.split("\n")
    .map((line) => line.trim().replace(/^[-*•▪◦–—]\s+/u, ""))
    .filter((line) => line && !heading.test(line))
    .map((claim) => ({ claim, factId: factId(claim) }));
  return {
    professionalSummary: payload.resume.summary,
    professionalSummaryFactId: factId(payload.resume.summary),
    skillsSection: (payload.resume.skills as string[]).map((text) => ({
      text,
      factId: factId(text)
    })),
    bulletRewrites: [],
    rolesOrProjectsToEmphasize: [],
    resumeTextClaims,
    unsupportedKeywords: [],
    formattingWarnings: [],
    resumeText
  };
}

export function syntheticCoverLetterOutput(payload = syntheticCorrectionFlowDocumentPayload()) {
  const facts = buildApplicationDocumentFactCatalog(payload);
  if (!payload.resume || typeof payload.resume.summary !== "string") throw new Error("Synthetic source summary is missing.");
  const selectedFacts = [
    payload.resume.summary,
    "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",
    "Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.",
    "Built weekly operational governance reviews that tracked service levels, capacity risks, and corrective actions.",
    "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",
    "Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.",
    "Created a capacity dashboard that combined queue volume, staffing coverage, and service-level trends.",
    SYNTHETIC_CORRECTION_FLOW_FACT
  ];
  const factId = (claim: string, index: number) => {
    const source = selectedFacts[index];
    const id = facts.find((fact) => fact.excerpt === source)?.factId;
    if (!id) throw new Error(`Synthetic cover-letter fact is missing: ${source}`);
    return id;
  };
  const claims = selectedFacts.map((source, index) => index === 0 ? `I am a ${source.slice(0, 1).toLowerCase()}${source.slice(1)}` : source === SYNTHETIC_CORRECTION_FLOW_FACT
    ? source
    : `I ${source.slice(0, 1).toLowerCase()}${source.slice(1)}`);
  return {
    title: "Northwind Service Cloud — Service Operations Director",
    coverLetter: [
      "Taylor Boundary",
      "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
      "",
      "Dear Northwind Service Cloud Hiring Team,",
      "",
      "I am applying for the Service Operations Director position at Northwind Service Cloud.",
      claims[0],
      "",
      `${claims[1]} ${claims[2]} ${claims[5]}`,
      "",
      `${claims[3]} ${claims[4]} ${claims[6]} ${claims[7]}`,
      "",
      "Thank you for your time and consideration.",
      "",
      "Sincerely,",
      "Taylor Boundary"
    ].join("\n"),
    angle: "Enterprise service delivery, incident governance, and accountable operational leadership.",
    claimsUsed: claims.map((claim, index) => ({ claim, factId: factId(claim, index) }))
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
