export const SYNTHETIC_CORRECTION_FLOW_REQUIREMENT =
  "Current Quenby certification in enterprise service operations";
export const SYNTHETIC_CORRECTION_FLOW_FACT =
  "I hold current Quenby certification in enterprise service operations.";
export const SYNTHETIC_CORRECTION_FLOW_FORBIDDEN_FACT =
  "Does not hold current Quenby certification in enterprise service operations.";
export const SYNTHETIC_CORRECTION_FLOW_FABRICATED_FACT =
  "Led a lunar logistics program.";
export const SYNTHETIC_CORRECTION_FLOW_DEGREE =
  "Bachelor of Arts in Business Administration";

const rawText = [
  "Taylor Boundary",
  "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
  "Service Operations Leader",
  "",
  "SUMMARY",
  "Service operations leader with nine years of experience improving enterprise support, incident governance, and customer delivery.",
  "",
  "SKILLS",
  "Operations: Enterprise service delivery, incident governance, capacity planning, service-level reporting",
  "Technology: TypeScript, PostgreSQL, SQL, API integrations, operational dashboards",
  "Leadership: Cross-functional programs, executive communication, team coaching, vendor coordination",
  "",
  "EXPERIENCE",
  "Contoso Service Systems | Senior Service Operations Manager | Remote | 2021–Present",
  "• Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",
  "• Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.",
  "• Built weekly operational governance reviews that tracked service levels, capacity risks, and corrective actions.",
  "• Developed TypeScript and PostgreSQL workflow checks that identified incomplete incident records before review.",
  "Fabrikam Customer Platforms | Service Delivery Manager | Seattle, WA | 2017–2021",
  "• Managed onboarding and support programs for enterprise customers across three product teams.",
  "• Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",
  "• Coordinated incident communications among customer leaders, support specialists, and engineering owners.",
  "• Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.",
  "",
  "PROJECTS",
  "Service Evidence Console | Audit-ready incident workflow | 2026",
  "Technologies: TypeScript, PostgreSQL",
  "• Built an evidence-review console that linked incident decisions to source records and accountable owners.",
  "• Created deterministic exports for weekly governance meetings and corrective-action follow-up.",
  "Capacity Health Board | Enterprise workload planning | 2025",
  "Technologies: SQL, API integrations",
  "• Created a capacity dashboard that combined queue volume, staffing coverage, and service-level trends.",
  "• Partnered with support and engineering managers to define escalation thresholds and review cadence.",
  "",
  "EDUCATION",
  "Synthetic Institute | Graduate Certificate in Service Operations and Analytics | 2020–2021",
  "• Completed a 480-hour applied program in service design, operational measurement, responsible data use, and change leadership.",
  "Example State University | Bachelor of Arts in Business Administration | 2012–2016",
  "• Completed interdisciplinary coursework in organizational behavior, statistics, economics, and professional communication.",
  "",
  "CERTIFICATIONS",
  "Certified Service Operations Professional | Example Standards Board | 2024",
  "Credential ID: CSOP-24017",
  "",
  "ACHIEVEMENTS",
  "Operational Excellence: Received the 2024 Process Improvement Award for incident-review modernization.",
  "Customer Impact: Recognized for clear executive communications during a multi-team service recovery.",
  "",
  "ADDITIONAL INFORMATION",
  "Volunteer mentor for early-career service operations professionals.",
  "Professional interests include responsible automation and evidence-based service management."
].join("\n");

export const SYNTHETIC_CORRECTION_FLOW_FIXTURE = Object.freeze({
  safeLabel: "Synthetic service-operations correction flow",
  job: Object.freeze({
    title: "Service Operations Director",
    company: "Northwind Service Cloud",
    location: "Remote — United States",
    remoteStatus: "REMOTE",
    salaryMin: null,
    salaryMax: null,
    description: "Northwind Service Cloud is seeking a Service Operations Director to lead enterprise service delivery across support, engineering, and customer success. The role owns incident governance, service-level reporting, capacity planning, and executive operating reviews. The director will improve operational workflows, coach service leaders, and use reliable data to guide corrective action while maintaining clear accountability across teams.",
    requirements: Object.freeze([
      SYNTHETIC_CORRECTION_FLOW_REQUIREMENT,
      "Eight or more years of progressive service operations experience",
      "Experience leading enterprise service delivery across cross-functional teams",
      "Demonstrated incident governance and service-level reporting improvement",
      "Experience coaching service operations professionals",
      "Working knowledge of SQL and operational workflow automation"
    ]),
    preferredQualifications: Object.freeze([
      "Business or operations education",
      "Experience with TypeScript and PostgreSQL",
      "Experience presenting operational risk to executive stakeholders"
    ]),
    detectedTechStack: Object.freeze(["TypeScript", "PostgreSQL", "SQL", "API integrations"])
  }),
  resume: Object.freeze({
    rawText,
    summary: "Service operations leader with nine years of experience improving enterprise support, incident governance, and customer delivery.",
    skills: Object.freeze([
      "Operations: Enterprise service delivery, incident governance, capacity planning, service-level reporting",
      "Technology: TypeScript, PostgreSQL, SQL, API integrations, operational dashboards",
      "Leadership: Cross-functional programs, executive communication, team coaching, vendor coordination"
    ]),
    achievements: Object.freeze([
      "Operational Excellence: Received the 2024 Process Improvement Award for incident-review modernization.",
      "Customer Impact: Recognized for clear executive communications during a multi-team service recovery."
    ]),
    workHistory: Object.freeze([
      Object.freeze({
        sourceText: "Contoso Service Systems | Senior Service Operations Manager | Remote | 2021–Present\nDirected service delivery across support, engineering, and customer success for 42 enterprise accounts.\nReduced median incident review time from five business days to two by standardizing evidence capture and ownership.\nBuilt weekly operational governance reviews that tracked service levels, capacity risks, and corrective actions.\nDeveloped TypeScript and PostgreSQL workflow checks that identified incomplete incident records before review.",
        company: "Contoso Service Systems",
        title: "Senior Service Operations Manager",
        location: "Remote",
        startDate: "2021",
        endDate: "Present",
        bullets: Object.freeze([
          "Directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",
          "Reduced median incident review time from five business days to two by standardizing evidence capture and ownership.",
          "Built weekly operational governance reviews that tracked service levels, capacity risks, and corrective actions.",
          "Developed TypeScript and PostgreSQL workflow checks that identified incomplete incident records before review."
        ])
      }),
      Object.freeze({
        sourceText: "Fabrikam Customer Platforms | Service Delivery Manager | Seattle, WA | 2017–2021\nManaged onboarding and support programs for enterprise customers across three product teams.\nImproved monthly service-level reporting accuracy by 18% through documented SQL validation checks.\nCoordinated incident communications among customer leaders, support specialists, and engineering owners.\nMentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.",
        company: "Fabrikam Customer Platforms",
        title: "Service Delivery Manager",
        location: "Seattle, WA",
        startDate: "2017",
        endDate: "2021",
        bullets: Object.freeze([
          "Managed onboarding and support programs for enterprise customers across three product teams.",
          "Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",
          "Coordinated incident communications among customer leaders, support specialists, and engineering owners.",
          "Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication."
        ])
      })
    ]),
    projects: Object.freeze([
      Object.freeze({
        sourceText: "Service Evidence Console | Audit-ready incident workflow | 2026\nTechnologies: TypeScript, PostgreSQL\nBuilt an evidence-review console that linked incident decisions to source records and accountable owners.\nCreated deterministic exports for weekly governance meetings and corrective-action follow-up.",
        name: "Service Evidence Console",
        description: "Audit-ready incident workflow",
        date: "2026",
        technologies: Object.freeze(["TypeScript", "PostgreSQL"]),
        bullets: Object.freeze([
          "Built an evidence-review console that linked incident decisions to source records and accountable owners.",
          "Created deterministic exports for weekly governance meetings and corrective-action follow-up."
        ])
      }),
      Object.freeze({
        sourceText: "Capacity Health Board | Enterprise workload planning | 2025\nTechnologies: SQL, API integrations\nCreated a capacity dashboard that combined queue volume, staffing coverage, and service-level trends.\nPartnered with support and engineering managers to define escalation thresholds and review cadence.",
        name: "Capacity Health Board",
        description: "Enterprise workload planning",
        date: "2025",
        technologies: Object.freeze(["SQL", "API integrations"]),
        bullets: Object.freeze([
          "Created a capacity dashboard that combined queue volume, staffing coverage, and service-level trends.",
          "Partnered with support and engineering managers to define escalation thresholds and review cadence."
        ])
      })
    ]),
    education: Object.freeze([
      Object.freeze({
        sourceText: "Synthetic Institute | Graduate Certificate in Service Operations and Analytics | 2020–2021\nCompleted a 480-hour applied program in service design, operational measurement, responsible data use, and change leadership.",
        institution: "Synthetic Institute",
        credential: "Graduate Certificate in Service Operations and Analytics",
        fieldOfStudy: "Service Operations and Analytics",
        startDate: "2020",
        endDate: "2021",
        details: Object.freeze([
          "Completed a 480-hour applied program in service design, operational measurement, responsible data use, and change leadership."
        ])
      }),
      Object.freeze({
        sourceText: "Example State University | Bachelor of Arts in Business Administration | 2012–2016\nCompleted interdisciplinary coursework in organizational behavior, statistics, economics, and professional communication.",
        institution: "Example State University",
        credential: "Bachelor of Arts",
        fieldOfStudy: "Business Administration",
        startDate: "2012",
        endDate: "2016",
        details: Object.freeze([
          "Completed interdisciplinary coursework in organizational behavior, statistics, economics, and professional communication."
        ])
      })
    ]),
    certifications: Object.freeze([Object.freeze({
      sourceText: "Certified Service Operations Professional | Example Standards Board | 2024\nCredential ID: CSOP-24017",
      name: "Certified Service Operations Professional",
      issuer: "Example Standards Board",
      date: "2024",
      expirationDate: null,
      details: Object.freeze(["Credential ID: CSOP-24017"])
    })])
  }),
  profile: Object.freeze({
    careerGoals: "Lead reliable enterprise service operations and develop accountable service leaders.",
    preferredRoles: Object.freeze(["Service Operations Director", "Director of Service Delivery"]),
    preferredLocations: Object.freeze(["Remote", "Seattle, WA"]),
    remotePreference: "REMOTE",
    salaryTargetMin: null,
    salaryTargetMax: null,
    skillsToEmphasize: Object.freeze([
      "Enterprise service delivery",
      "Incident governance",
      "Executive communication",
      "TypeScript",
      "PostgreSQL"
    ]),
    skillsNotToExaggerate: Object.freeze(["Kubernetes"])
  }),
  predeterminedCorrection: Object.freeze({
    kind: "OWNER_ATTESTATION" as const,
    fact: SYNTHETIC_CORRECTION_FLOW_FACT,
    reuseScope: "JOB_ONLY" as const,
    masterProfileOptIn: false as const
  })
});
