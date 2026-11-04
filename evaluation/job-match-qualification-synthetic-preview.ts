import type { ApplicantQualificationSnapshot } from "@/lib/ai/job-match-qualification";

// Public, synthetic-only fixture for exercising the owner review command and
// screen. It must never be replaced with a real applicant projection.
export const SYNTHETIC_QUALIFICATION_SNAPSHOT: ApplicantQualificationSnapshot = Object.freeze({
  masterResumeId: "synthetic-owner-review-preview",
  parsedAt: "2026-10-05T16:00:00.000Z",
  resume: {
    summary: "Synthetic owner evidence for a customer-facing technical operator.",
    rawText: [
      "SYNTHETIC OWNER REVIEW PREVIEW",
      "Solutions Operations Lead — Example Systems",
      "Built source-backed customer workflows with TypeScript and SQL.",
      "Presented technical demonstrations and documented implementation plans."
    ].join("\n"),
    skills: ["TypeScript", "SQL", "Customer discovery", "Technical demonstrations"],
    achievements: ["Reduced a synthetic onboarding workflow from five steps to three."],
    workHistory: [{
      title: "Solutions Operations Lead",
      company: "Example Systems",
      bullets: [
        "Led synthetic customer discovery and technical demonstrations.",
        "Built source-backed workflows with TypeScript and SQL."
      ]
    }],
    projects: [{
      name: "Synthetic evidence workspace",
      bullets: ["Mapped customer requirements to cited implementation evidence."]
    }],
    education: [{
      institution: "Example University",
      credential: "Bachelor of Arts",
      fieldOfStudy: "Business Administration"
    }],
    certifications: [{ name: "Synthetic Technical Program", details: ["480 hours"] }]
  },
  profile: {
    careerGoals: "Work in customer-facing technical delivery.",
    preferredRoles: ["Solutions Engineer", "Customer Success Engineer"],
    preferredLocations: ["Los Angeles", "Remote"],
    remotePreference: "HYBRID",
    salaryTargetMin: 75_000,
    salaryTargetMax: 130_000,
    skillsToEmphasize: ["TypeScript", "SQL", "Customer discovery"],
    skillsNotToExaggerate: ["Kubernetes", "Programmatic advertising"]
  }
});
