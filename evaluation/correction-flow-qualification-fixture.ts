export const SYNTHETIC_CORRECTION_FLOW_REQUIREMENT =
  "Current Quenby service certification for enterprise operations";
export const SYNTHETIC_CORRECTION_FLOW_FACT =
  "Synthetic owner confirms current Quenby service certification for enterprise operations.";
export const SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT =
  "Synthetic owner does not hold Quenby service certification.";
export const SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT =
  "Synthetic owner led an unsupported lunar logistics program.";
export const SYNTHETIC_CORRECTION_FLOW_DEGREE =
  "Bachelor of Arts in Business Administration";

const rawText = [
  "Taylor Boundary",
  "taylor.boundary@example.test | +1 555 010 0200 | Remote",
  "",
  "SUMMARY",
  "Service operations leader building reliable customer workflows.",
  "",
  "SKILLS",
  "Operations: Service delivery, incident review, process design",
  "Technology: TypeScript, PostgreSQL, API integrations",
  "Leadership: Cross-functional programs, stakeholder communication",
  "",
  "EXPERIENCE",
  "Example Systems | Service Operations Lead | Remote | 2022–Present",
  "Led source-backed service delivery and cross-functional portfolio reviews.",
  "Improved incident workflows using TypeScript and PostgreSQL.",
  "",
  "PROJECTS",
  "Evidence Console | Audit-ready workflow | 2026",
  "Technologies: TypeScript, PostgreSQL",
  "Built a synthetic evidence-review console with deterministic exports.",
  "",
  "EDUCATION",
  "Example University | Bachelor of Arts in Business Administration | 2014–2018",
  "",
  "CERTIFICATIONS",
  "Service Operations Certificate | Example Institute | 2020",
  "Completed a 480-hour-style synthetic operations program.",
  "",
  "ACHIEVEMENTS",
  "Reduced synthetic incident review time while preserving audit evidence.",
  "",
  "ADDITIONAL",
  "Volunteer mentor for synthetic operations workshops."
].join("\n");

export const SYNTHETIC_CORRECTION_FLOW_FIXTURE = Object.freeze({
  safeLabel: "Synthetic service-operations correction flow",
  job: Object.freeze({
    title: "Service Operations Director",
    company: "Synthetic Employer",
    location: "Remote",
    remoteStatus: "REMOTE",
    salaryMin: null,
    salaryMax: null,
    description: "Lead enterprise service delivery, operational governance, TypeScript, and PostgreSQL programs.",
    requirements: Object.freeze([
      SYNTHETIC_CORRECTION_FLOW_REQUIREMENT,
      "Experience leading enterprise service delivery programs"
    ]),
    preferredQualifications: Object.freeze(["Business education"]),
    detectedTechStack: Object.freeze(["TypeScript", "PostgreSQL"])
  }),
  resume: Object.freeze({
    rawText,
    summary: "Service operations leader building reliable customer workflows.",
    skills: Object.freeze([
      "Operations: Service delivery, incident review, process design",
      "Technology: TypeScript, PostgreSQL, API integrations",
      "Leadership: Cross-functional programs, stakeholder communication"
    ]),
    achievements: Object.freeze([
      "Reduced synthetic incident review time while preserving audit evidence."
    ]),
    workHistory: Object.freeze([Object.freeze({
      sourceText: "Example Systems | Service Operations Lead | Remote | 2022–Present\nLed source-backed service delivery and cross-functional portfolio reviews.\nImproved incident workflows using TypeScript and PostgreSQL.",
      company: "Example Systems",
      title: "Service Operations Lead",
      location: "Remote",
      startDate: "2022",
      endDate: "Present",
      bullets: Object.freeze([
        "Led source-backed service delivery and cross-functional portfolio reviews.",
        "Improved incident workflows using TypeScript and PostgreSQL."
      ])
    })]),
    projects: Object.freeze([Object.freeze({
      sourceText: "Evidence Console | Audit-ready workflow | 2026\nTechnologies: TypeScript, PostgreSQL\nBuilt a synthetic evidence-review console with deterministic exports.",
      name: "Evidence Console",
      description: "Audit-ready workflow",
      date: "2026",
      technologies: Object.freeze(["TypeScript", "PostgreSQL"]),
      bullets: Object.freeze(["Built a synthetic evidence-review console with deterministic exports."])
    })]),
    education: Object.freeze([Object.freeze({
      sourceText: "Example University | Bachelor of Arts in Business Administration | 2014–2018",
      institution: "Example University",
      credential: "Bachelor of Arts",
      fieldOfStudy: "Business Administration",
      startDate: "2014",
      endDate: "2018",
      details: Object.freeze([] as string[])
    })]),
    certifications: Object.freeze([Object.freeze({
      sourceText: "Service Operations Certificate | Example Institute | 2020\nCompleted a 480-hour-style synthetic operations program.",
      name: "Service Operations Certificate",
      issuer: "Example Institute",
      date: "2020",
      expirationDate: null,
      details: Object.freeze(["Completed a 480-hour-style synthetic operations program."])
    })])
  }),
  profile: Object.freeze({
    careerGoals: "Lead reliable enterprise service operations.",
    preferredRoles: Object.freeze(["Service Operations Director"]),
    preferredLocations: Object.freeze(["Remote"]),
    remotePreference: "REMOTE",
    salaryTargetMin: null,
    salaryTargetMax: null,
    skillsToEmphasize: Object.freeze(["Service delivery", "TypeScript", "PostgreSQL"]),
    skillsNotToExaggerate: Object.freeze(["Kubernetes"])
  }),
  predeterminedCorrection: Object.freeze({
    kind: "OWNER_ATTESTATION" as const,
    fact: SYNTHETIC_CORRECTION_FLOW_FACT,
    reuseScope: "JOB_ONLY" as const,
    masterProfileOptIn: false as const
  })
});
