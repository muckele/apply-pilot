import { LASERFICHE_SYNTHETIC_QUALIFICATION } from "@/evaluation/job-match-qualification-laserfiche-public-projection";
import type { SyntheticReviewState } from "@/lib/jobs/synthetic-one-job-review";

const qualification = LASERFICHE_SYNTHETIC_QUALIFICATION;
const requirementLabels = qualification.requirementLabels as Readonly<Record<string, string>>;
const applicantEvidenceLabels = qualification.applicantEvidenceLabels as Readonly<Record<string, string>>;
const rationales = qualification.rationales as Readonly<Record<string, string>>;
const supportedRequirements = Object.entries(qualification.supported).map(([jobRef, applicantRefs]) => ({
  requirement: requirementLabels[jobRef],
  evidence: applicantRefs.map((ref) => applicantEvidenceLabels[ref]),
  rationale: rationales[jobRef]
}));

const resumeText = [
  "SYNTHETIC CANDIDATE",
  "Los Angeles | synthetic@example.test",
  "",
  "SUMMARY",
  "Customer-facing technical operator who builds source-backed workflows and presents implementation plans.",
  "",
  "SKILLS",
  "TypeScript | SQL | Customer discovery | Technical demonstrations",
  "",
  "EXPERIENCE",
  "Solutions Operations Lead — Example Systems",
  "• Led synthetic customer discovery and technical demonstrations.",
  "• Built source-backed workflows with TypeScript and SQL.",
  "",
  "PROJECTS",
  "Synthetic evidence workspace",
  "• Mapped customer requirements to cited implementation evidence.",
  "",
  "EDUCATION",
  "Bachelor of Arts in Business Administration — Example University",
  "",
  "CERTIFICATIONS",
  "Synthetic Technical Program — 480 hours"
].join("\n");

const coverLetterText = [
  "SYNTHETIC CANDIDATE",
  "Los Angeles | synthetic@example.test",
  "Presales Engineer I — Laserfiche",
  "",
  "Dear Hiring Team,",
  "",
  "I am interested in the Presales Engineer I role at Laserfiche. As Solutions Operations Lead at Example Systems, I led synthetic customer discovery and technical demonstrations and built source-backed workflows with TypeScript and SQL.",
  "",
  "My Synthetic evidence workspace maps customer requirements to cited implementation evidence. I would welcome the opportunity to discuss how this customer-facing technical experience could support Laserfiche's presales team.",
  "",
  "Sincerely,",
  "Synthetic Candidate"
].join("\n");

const review: SyntheticReviewState = Object.freeze({
  selectedResumeId: "synthetic-laserfiche-resume-v1",
  selectedCoverLetterId: "synthetic-laserfiche-cover-v1",
  resumeText,
  coverLetterText,
  validatedBaseline: Object.freeze({
    resumeId: "synthetic-laserfiche-resume-v1",
    coverLetterId: "synthetic-laserfiche-cover-v1",
    resumeText,
    coverLetterText
  }),
  questions: qualification.questions.map((group) => ({
    id: group.id,
    title: group.title,
    question: group.question,
    whyItMatters: group.whyItMatters,
    requirementLabels: group.jobRefs.map((ref) => requirementLabels[ref]),
    yesEvidencePrompt: group.id === "independent-and-team-work"
      ? "Add one factual example that shows both independent ownership and teamwork."
      : undefined
  })),
  answers: qualification.questions.map((group) => ({
    questionId: group.id,
    answer: "" as const,
    evidence: ""
  })),
  changes: [
    {
      id: "resume-technical-evidence",
      summary: "Prioritized customer discovery, technical demonstrations, TypeScript, and SQL.",
      sourceRefs: ["resume.skills[0]", "resume.skills[1]", "resume.workHistory[0]"],
      sourceExcerpts: ["TypeScript", "SQL", "Led synthetic customer discovery and technical demonstrations."]
    },
    {
      id: "resume-education",
      summary: "Preserved the complete degree and field of study.",
      sourceRefs: ["resume.education[0]"],
      sourceExcerpts: ["Bachelor of Arts in Business Administration — Example University"]
    },
    {
      id: "cover-boundaries",
      summary: "Kept unsupported work-authorization and team-delivery facts out of the letter.",
      sourceRefs: ["job.requirements[4]", "job.requirements[5]"],
      sourceExcerpts: qualification.questions.flatMap((group) => group.jobRefs.map((ref) => requirementLabels[ref]))
    }
  ]
});

export const SYNTHETIC_ONE_JOB_FIXTURE = Object.freeze({
  job: Object.freeze({
    id: qualification.caseId,
    title: qualification.job.title,
    company: qualification.job.company,
    location: qualification.job.location,
    workArrangement: qualification.job.workArrangement,
    compensation: qualification.job.compensation,
    fitScore: 82,
    recommendation: "eligibility review required",
    keyReason: `${supportedRequirements.length} experience requirements have source evidence; ${qualification.questions.length} applicant answers are still needed.`,
    hasFitAnalysis: true
  }),
  supportedRequirements: supportedRequirements.map((entry) => ({
    requirement: entry.requirement,
    evidence: [...entry.evidence],
    rationale: entry.rationale
  })),
  review
});

export type SyntheticOneJobFixture = typeof SYNTHETIC_ONE_JOB_FIXTURE;
