import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";

// Authored source expansion for offline customer-quality review, separate from the frozen paid diagnostic.
export function realisticDocumentQualityPayload() {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const resume = payload.resume!;
  const coordinator = {
    company: "Harbor Customer Solutions", title: "Service Operations Coordinator", location: "Seattle, WA",
    startDate: "2014", endDate: "2017",
    bullets: [
      "Maintained incident records and handoff notes for customer support and engineering teams.",
      "Prepared service-level reports and checked underlying support records for completeness.",
      "Coordinated escalation updates and followed up on agreed corrective actions."
    ],
    sourceText: ""
  };
  coordinator.sourceText = [
    "Harbor Customer Solutions | Service Operations Coordinator | Seattle, WA | 2014–2017",
    ...coordinator.bullets
  ].join("\n");
  resume.workHistory = [...(resume.workHistory as unknown[]), coordinator];
  resume.summary = String(resume.summary).replace("nine years", "twelve years");
  resume.rawText = String(resume.rawText).replace("nine years", "twelve years")
    .replace("\n\nPROJECTS", `\n${coordinator.sourceText.split("\n").map((line,index) => index ? `• ${line}` : line).join("\n")}\n\nPROJECTS`);
  (payload.reviewedEvidence!.facts as unknown[]).push({
    gapId: "illustrative-source-correction", provenance: "SUBMITTED_RESUME", sourceRef: "resume.education[1]",
    fact: "Example State University | Bachelor of Arts in Business Administration | 2012–2016"
  });
  return payload;
}

export const DOCUMENT_QUALITY_CORRECTION_HISTORY = [
  {
    requirement: "Current Quenby certification in enterprise service operations",
    evidenceBefore: "The master résumé lists a different service-operations certificate; current Quenby status was unknown from that source. The applicant supplied the following job-only attestation.",
    fact: "I hold current Quenby certification in enterprise service operations.", provenance: "OWNER_ATTESTED" as const
  },
  {
    requirement: "Business or operations education",
    evidenceBefore: "This evidence is already in the master résumé. The correction restores the degree and field of study instead of asking the applicant to add a new qualification.",
    fact: "Example State University | Bachelor of Arts in Business Administration | 2012–2016", provenance: "SUBMITTED_RESUME" as const
  }
] as const;
