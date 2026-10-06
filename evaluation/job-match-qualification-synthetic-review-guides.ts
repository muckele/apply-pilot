import type { QualificationPreparation } from "@/lib/ai/job-match-qualification";
import {
  QUALIFICATION_REVIEW_GUIDE_VERSION,
  type QualificationReviewGuide
} from "@/lib/ai/job-match-qualification-review-guide";

const SYNTHETIC_RESUME_PROJECTION_HASH = "a63c149f938e31c602bdcee155815392da410cf6f887c57937aa6919926bfb0b";
const SYNTHETIC_PROFILE_PROJECTION_HASH = "1642b14b94933d9cc59ab85a5e25b1b99fe1ca387d605fa7640fe799b8b4a0d6";

type GuideSeed = Readonly<{
  expectedJobProjectionHash: string;
  expectedInputHash: string;
  supported: Readonly<Record<string, readonly string[]>>;
  rationales: Readonly<Record<string, string>>;
  mustHave?: readonly string[];
  questions: readonly Readonly<{
    id: string;
    title: string;
    question: string;
    whyItMatters: string;
    jobRefs: readonly string[];
  }>[];
}>;

const GUIDE_SEEDS: Readonly<Record<string, GuideSeed>> = Object.freeze({
  "laserfiche-presales-engineer-i": {
    expectedJobProjectionHash: "52031f913656015dc6f2b790f2532f0e1f046e949b389e2d0c7c5ef49e2db3bc",
    expectedInputHash: "edbc88e878c1e847832cbcef3553128b21c6772563f8f1b3f16688c986a6cad0",
    supported: {
      "job.requirements[0]": ["resume.education[0]"],
      "job.requirements[1]": ["resume.projects[0]", "resume.achievements[0]"],
      "job.requirements[2]": ["resume.skills[0]", "resume.skills[1]", "resume.workHistory[0]"],
      "job.requirements[3]": ["resume.skills[3]", "resume.workHistory[0]"]
    },
    rationales: {
      "job.requirements[0]": "The source résumé records a Bachelor of Arts; a STEM field is preferred rather than required.",
      "job.requirements[1]": "The synthetic project and workflow improvement are direct problem-solving evidence.",
      "job.requirements[2]": "The source résumé names TypeScript, SQL, and technical workflow delivery.",
      "job.requirements[3]": "The source résumé explicitly records technical demonstrations and customer discovery."
    },
    mustHave: ["job.requirements[5]"],
    questions: [
      {
        id: "independent-and-team-work",
        title: "Independent and team delivery",
        question: "Can you provide a concrete example of working independently and as part of a team?",
        whyItMatters: "The source résumé does not explicitly establish both parts of this requirement.",
        jobRefs: ["job.requirements[4]"]
      },
      {
        id: "work-authorization",
        title: "Work authorization",
        question: "Are you authorized to work full-time in the United States without employer sponsorship for this role?",
        whyItMatters: "The posting states this as a must-have condition.",
        jobRefs: ["job.requirements[5]"]
      }
    ]
  },
  "sentry-solutions-engineer": {
    expectedJobProjectionHash: "ea8651b522a6ff3f6201e2260ab77e6189b62c031b23546c4daf1e155109915f",
    expectedInputHash: "8e48e236cfffb507c39b1ff1be3c923e54135e276a7dd25c0f047f579aa37117",
    supported: {
      "job.requirements[2]": ["resume.skills[3]", "resume.workHistory[0]"],
      "job.requirements[3]": ["resume.projects[0]", "resume.achievements[0]"],
      "job.preferredQualifications[1]": ["resume.workHistory[0]", "resume.projects[0]"]
    },
    rationales: {
      "job.requirements[2]": "The source résumé explicitly records customer-facing technical demonstrations.",
      "job.requirements[3]": "The synthetic project and workflow improvement provide direct problem-solving evidence.",
      "job.preferredQualifications[1]": "The source résumé records building workflows, demonstrations, and implementation evidence."
    },
    questions: [
      {
        id: "relevant-years",
        title: "Relevant years",
        question: "Do you have at least three years in solutions engineering, implementation, support, or software development with customer or project responsibility?",
        whyItMatters: "The source résumé has no dates, so the stated experience duration remains unknown.",
        jobRefs: ["job.requirements[0]"]
      },
      {
        id: "listed-frameworks",
        title: "Programming languages and frameworks",
        question: "Which of the posting's listed languages or frameworks have you used hands-on?",
        whyItMatters: "TypeScript is present, but the exact listed framework coverage is not established.",
        jobRefs: ["job.requirements[1]"]
      },
      {
        id: "developer-tools-lifecycle",
        title: "Developer-tool lifecycle experience",
        question: "Do you have direct developer-tools, open-source, or software-development-lifecycle experience?",
        whyItMatters: "This preferred qualification could distinguish a borderline fit.",
        jobRefs: ["job.preferredQualifications[0]"]
      }
    ]
  },
  "flint-customer-success-engineer": {
    expectedJobProjectionHash: "fd86863498043f64aee0ff9357a0607dc04c8ea0d65b439433cc446e454874e1",
    expectedInputHash: "d25f097a35591c8501c3455b8ddc0182a1bc5e05b7ba0a334ce54592fbaf84d0",
    supported: {
      "job.requirements[1]": ["resume.achievements[0]", "resume.projects[0]"]
    },
    rationales: {
      "job.requirements[1]": "The source résumé records a measurable workflow outcome and requirements-to-evidence work."
    },
    questions: [
      {
        id: "customer-facing-years",
        title: "Customer-facing experience",
        question: "Do you have one to three years in Customer Success, Support, Operations, or a similar customer-facing role?",
        whyItMatters: "The role title is relevant, but the source résumé does not state duration.",
        jobRefs: ["job.requirements[0]"]
      },
      {
        id: "education-or-edtech",
        title: "Education or EdTech",
        question: "Do you have direct education, teaching, or EdTech experience?",
        whyItMatters: "This is a preferred qualification not established by the source résumé.",
        jobRefs: ["job.preferredQualifications[0]"]
      },
      {
        id: "startup-experience",
        title: "Startup experience",
        question: "Do you have direct startup experience?",
        whyItMatters: "This preferred qualification could affect the borderline recommendation.",
        jobRefs: ["job.preferredQualifications[1]"]
      }
    ]
  },
  "roku-technical-account-manager-10909": {
    expectedJobProjectionHash: "6b0bca5bc8bdd182022ede402fd8aa0679684c3b0a3bcd2862d8a8884147e493",
    expectedInputHash: "49e26391c12be5f7f70d8c9f378d0df841eab8561903829e7d009fcbb4f7354d",
    supported: {
      "job.requirements[2]": ["resume.skills[2]", "resume.skills[3]", "resume.workHistory[0]"],
      "job.requirements[6]": ["resume.skills[2]", "resume.workHistory[0]"],
      "job.requirements[7]": ["resume.skills[1]", "resume.workHistory[0]"]
    },
    rationales: {
      "job.requirements[2]": "The source résumé records customer discovery and technical demonstrations.",
      "job.requirements[6]": "The source résumé records customer-facing discovery and delivery.",
      "job.requirements[7]": "SQL is explicitly present in both skills and work evidence."
    },
    mustHave: [
      "job.requirements[0]", "job.requirements[3]", "job.requirements[4]", "job.requirements[5]",
      "job.requirements[8]", "job.requirements[11]", "job.requirements[13]"
    ],
    questions: [
      {
        id: "adtech-domain",
        title: "Advertising technology domain",
        question: "Do you have the required programmatic advertising, header bidding, CTV, video-format, and ad-tech experience? Answer Yes only if all apply; otherwise choose Not sure and explain what applies.",
        whyItMatters: "These are central stated requirements and the submitted positive evidence does not establish them.",
        jobRefs: [
          "job.requirements[0]", "job.requirements[3]", "job.requirements[4]", "job.requirements[5]"
        ]
      },
      {
        id: "integration-tooling",
        title: "Integration and troubleshooting tooling",
        question: "Do you have the required supply-integration, technical-specification, SDK, log-reading, Postman, network-troubleshooting, and video-ad-server experience? Answer Yes only if all apply.",
        whyItMatters: "This cluster represents the role's specialist implementation work.",
        jobRefs: [
          "job.requirements[8]", "job.requirements[9]", "job.requirements[10]", "job.requirements[11]",
          "job.requirements[12]", "job.requirements[13]", "job.preferredQualifications[0]"
        ]
      },
      {
        id: "ai-workflow-proficiency",
        title: "AI workflow proficiency",
        question: "Can you describe direct use of AI tools to optimize or execute operational workflows?",
        whyItMatters: "This stated requirement is not present in the submitted positive evidence.",
        jobRefs: ["job.requirements[1]"]
      }
    ]
  }
});

export function buildSyntheticQualificationReviewGuides(
  preparation: QualificationPreparation
): readonly QualificationReviewGuide[] {
  if (
    preparation.safeManifest.resumeProjectionHash !== SYNTHETIC_RESUME_PROJECTION_HASH
    || preparation.safeManifest.profileProjectionHash !== SYNTHETIC_PROFILE_PROJECTION_HASH
  ) {
    throw new Error("Synthetic review guides cannot be applied to a different applicant projection.");
  }
  return Object.freeze(preparation.privateInputs.map((prepared) => {
    const seed = GUIDE_SEEDS[prepared.caseId];
    if (!seed) throw new Error(`Synthetic review guide is missing ${prepared.caseId}.`);
    if (
      prepared.jobProjectionHash !== seed.expectedJobProjectionHash
      || prepared.inputHash !== seed.expectedInputHash
    ) {
      throw new Error(`Synthetic review guide does not match the exact frozen job and input for ${prepared.caseId}.`);
    }
    const requirements = [
      ...(prepared.input.job.requirements ?? []).map((_, index) => `job.requirements[${index}]`),
      ...(prepared.input.job.preferredQualifications ?? []).map((_, index) => `job.preferredQualifications[${index}]`)
    ];
    const questioned = new Set(seed.questions.flatMap((question) => question.jobRefs));
    return Object.freeze({
      version: QUALIFICATION_REVIEW_GUIDE_VERSION,
      caseId: prepared.caseId,
      inputHash: seed.expectedInputHash,
      jobProjectionHash: seed.expectedJobProjectionHash,
      requirements: Object.freeze(requirements.map((jobRef) => Object.freeze({
        jobRef,
        disposition: seed.supported[jobRef]
          ? "supported" as const
          : "unknown" as const,
        materiality: jobRef.startsWith("job.preferredQualifications[")
          ? "preferred" as const
          : seed.mustHave?.includes(jobRef)
            ? "must_have" as const
            : "important" as const,
        applicantRefs: Object.freeze([...(seed.supported[jobRef] ?? [])]),
        rationale: seed.rationales[jobRef]
          ?? (questioned.has(jobRef)
            ? "Independent review found no sufficient positive source evidence; ask the targeted question."
            : "Independent review left this requirement unknown without treating absence as a confirmed gap.")
      }))),
      clarifications: Object.freeze(seed.questions.map((question) => Object.freeze({
        ...question,
        decisionChanging: true as const,
        jobRefs: Object.freeze([...question.jobRefs])
      })))
    });
  }));
}
