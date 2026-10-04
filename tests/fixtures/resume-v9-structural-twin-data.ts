import type { ParsedResumeV5 } from "@/lib/ai/resume";

type WorkFixture = {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  bullets: string[];
};

type ProjectFixture = {
  name: string;
  description: string;
  date: string;
  technologies: string[];
  bullet: string;
};

const contactLines = [
  "Casey Structure",
  "",
  "Operations Systems and Customer Delivery Leader",
  "",
  "casey.structure@example.test | +1 (555) 010-8642 | Riverton, CA",
  "https://portfolio.example.test/casey | https://www.linkedin.com/in/casey-structure | https://github.com/casey-structure"
];

const summary = "Operations systems and customer delivery leader who builds reliable, measurable workflows across service operations, implementation, reporting, and cross-functional programs. Translates ambiguous requirements into explicit ownership, source-linked evidence, bounded decisions, and practical improvements while coaching distributed teams, preserving customer context, and communicating unresolved risks without exaggeration.";

const skillGroups = [
  "Operations leadership: service delivery, incident coordination, capacity planning, quality controls, vendor governance, escalation design, risk reviews, operating cadences, process mapping, and continuous improvement.",
  "Data and platforms: SQL, PostgreSQL, TypeScript, Azure, reporting automation, dashboard design, data reconciliation, workflow instrumentation, access reviews, source tracing, and evidence catalogs.",
  "Program delivery: stakeholder communication, team coaching, change management, roadmap facilitation, executive briefings, documentation systems, launch planning, dependency mapping, customer discovery, and outcome measurement."
];

const bullet = (text: string, index: number) =>
  `• ${text} using private-free evidence for structural scenario ${index}.`;

const workRecords: WorkFixture[] = [
  {
    title: "Director of Service Operations",
    company: "Northwind Example Systems",
    startDate: "Jan 2022",
    endDate: "Present",
    bullets: [
      bullet("Designed a multi-team intake model with explicit ownership and measurable service levels", 1),
      bullet("Established operating reviews connecting customer impact, delivery risk, and remediation decisions", 2),
      bullet("Introduced reconciliation checks that detected reporting drift before planning cycles", 3),
      bullet("Coached managers on decision records and respectful incident communication", 4)
    ]
  },
  {
    title: "Senior Program Manager",
    company: "Contoso Example Delivery",
    startDate: "Mar 2019",
    endDate: "Dec 2021",
    bullets: [
      bullet("Led onboarding programs with milestones, dependency maps, and outcome measures", 5),
      bullet("Built capacity forecasts balancing demand, specialist availability, timing, and risk", 6),
      bullet("Created reusable launch checklists that reduced avoidable handoff defects", 7),
      bullet("Presented delivery findings with transparent assumptions and unresolved risks", 8)
    ]
  },
  {
    title: "Operations Analytics Manager",
    company: "Fabrikam Example Services",
    startDate: "Jul 2016",
    endDate: "Feb 2019",
    bullets: [
      bullet("Developed service-health reporting combining volume, quality, age, and sentiment", 9),
      bullet("Automated recurring preparation while retaining source references and exception logs", 10),
      bullet("Facilitated metric-definition workshops across finance, support, and product teams", 11),
      bullet("Investigated unusual trends with reproducible queries and bounded hypotheses", 12),
      bullet("Documented access boundaries, reviewer decisions, and follow-up ownership", 13)
    ]
  },
  {
    title: "Customer Experience Lead",
    company: "Adventure Example Cloud",
    startDate: "Apr 2013",
    endDate: "Jun 2016",
    bullets: [
      bullet("Redesigned escalation workflows so teams could identify urgency and ownership", 14),
      bullet("Produced journey reviews linking recurring friction to specific process gaps", 15),
      bullet("Mentored specialists on structured troubleshooting and evidence-based recommendations", 16)
    ]
  },
  {
    title: "Business Process Analyst",
    company: "Tailspin Example Consulting",
    startDate: "Sep 2010",
    endDate: "Mar 2013",
    bullets: [
      bullet("Mapped operational processes with owners, inputs, controls, and failure modes", 17),
      bullet("Created analyses that reconciled source systems before recommendations", 18),
      bullet("Documented implementation decisions so later teams understood tradeoffs", 19),
      bullet("Supported change workshops with accessible job aids and observable measures", 20),
      bullet("Maintained an ordered evidence register for open questions and outcomes", 21)
    ]
  }
];

const projects: ProjectFixture[] = [
  {
    name: "Service Reliability Workbench",
    description: "Auditable Operations Dashboard",
    date: "2025",
    technologies: ["TypeScript", "PostgreSQL"],
    bullet: bullet("Built a TypeScript and PostgreSQL dashboard preserving evidence while highlighting service risk", 22)
  },
  {
    name: "Planning Evidence Library",
    description: "Decision Support Catalog",
    date: "2024",
    technologies: ["SQL", "Azure"],
    bullet: bullet("Created a SQL and Azure evidence catalog with stable identifiers and omission tracking", 23)
  }
];

const educationLines = [
  "Immersive Operations Certificate | Example Learning Studio | Jan 2020 - Apr 2020",
  "Completed a 480-hour applied program spanning service design, analytical reporting, responsible automation, collaborative delivery, and source-linked decision practices.",
  "Bachelor of Arts in Business Administration | Example State University | 2014"
];

const certificationLines = [
  "Synthetic Reliability Professional | Example Standards Board",
  "Issued: 2024",
  "Expires: 2027",
  "Credential ID: SYNTHETIC-ONLY-4821",
  "Completed an evidence-based assessment covering operational controls and source-traceable review practices."
];

const achievementLines = [
  "Operational excellence: Recognized for building a transparent cross-team service review with stable evidence links.",
  "Team development: Coached an example cohort through structured investigation and decision documentation."
];

const additionalLines = [
  "Languages: English and Spanish",
  "Community service: Volunteer facilitator for a fictional public data literacy workshop."
];

const workRecordText = (record: WorkFixture) => [
  `${record.title} | ${record.company} | ${record.startDate} - ${record.endDate}`,
  ...record.bullets
].join("\n");

const projectRecordText = (record: ProjectFixture) => [
  `${record.name} | ${record.description} | ${record.date}`,
  record.bullet
].join("\n");

const workSource = workRecords.map(workRecordText).join("\n\n");
const projectSource = projects.map(projectRecordText).join("\n\n");
const educationSource = educationLines.join("\n");
const certificationSource = certificationLines.join("\n");
const achievementsSource = achievementLines.join("\n");
const additionalSource = additionalLines.join("\n");

export const resumeV9StructuralTwinText = [
  contactLines.join("\n"),
  "SUMMARY",
  summary,
  "SKILLS",
  skillGroups.join("\n"),
  "EXPERIENCE",
  workSource,
  "PROJECTS",
  projectSource,
  "EDUCATION",
  educationSource,
  "CERTIFICATIONS",
  certificationSource,
  "ACHIEVEMENTS",
  achievementsSource,
  "ADDITIONAL INFORMATION",
  additionalSource
].join("\n\n");

export const resumeV9StructuralTwinDocxText = `${resumeV9StructuralTwinText}\n\n`;

const ownerTopologyWorkLines = workRecords.flatMap((record, index) => [
  ...(index === 0 ? [] : [""]),
  ...workRecordText(record).split("\n")
]);
const ownerTopologyProjectLines = projects.flatMap((record, index) => [
  ...(index === 0 ? [] : [""]),
  ...projectRecordText(record).split("\n")
]);

export const resumeV9OwnerTopologyTwinText = [
  ...contactLines,
  "",
  "SUMMARY",
  "",
  summary,
  "",
  "SKILLS",
  "",
  ...skillGroups,
  "",
  "EXPERIENCE",
  "",
  ...ownerTopologyWorkLines,
  "",
  "PROJECTS",
  "",
  ...ownerTopologyProjectLines,
  "",
  "EDUCATION",
  "",
  ...educationLines
].join("\n");

export const resumeV9OwnerTopologyTwinDocxText = `${resumeV9OwnerTopologyTwinText}\n\n`;

export function resumeV9StructuralTwinCanonical(): ParsedResumeV5 {
  const contactSource = contactLines.join("\n");
  const workBlocks = workRecords.map(workRecordText);
  const projectBlocks = projects.map(projectRecordText);
  const educationBlocks = [educationLines.slice(0, 2).join("\n"), educationLines[2]!];
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: contactSource, recordBlocks: [contactSource] },
      { section: "summary", heading: "SUMMARY", sourceText: summary, recordBlocks: [summary] },
      { section: "skills", heading: "SKILLS", sourceText: skillGroups.join("\n"), recordBlocks: skillGroups },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: workSource, recordBlocks: workBlocks },
      { section: "projects", heading: "PROJECTS", sourceText: projectSource, recordBlocks: projectBlocks },
      { section: "education", heading: "EDUCATION", sourceText: educationSource, recordBlocks: educationBlocks },
      { section: "certifications", heading: "CERTIFICATIONS", sourceText: certificationSource, recordBlocks: [certificationSource] },
      { section: "achievements", heading: "ACHIEVEMENTS", sourceText: achievementsSource, recordBlocks: achievementLines },
      { section: "additional", heading: "ADDITIONAL INFORMATION", sourceText: additionalSource, recordBlocks: additionalLines }
    ],
    contactInfo: {
      sourceText: contactSource,
      name: "Casey Structure",
      headline: "Operations Systems and Customer Delivery Leader",
      email: "casey.structure@example.test",
      phone: "+1 (555) 010-8642",
      location: "Riverton, CA",
      linkedin: "https://www.linkedin.com/in/casey-structure",
      github: "https://github.com/casey-structure",
      portfolio: "https://portfolio.example.test/casey"
    },
    summary,
    skills: ["service delivery", "SQL", "TypeScript", "stakeholder communication"],
    workHistory: workRecords.map((record, index) => ({
      sourceText: workBlocks[index]!,
      company: record.company,
      title: record.title,
      location: null,
      startDate: record.startDate,
      endDate: record.endDate,
      bullets: [...record.bullets]
    })),
    projects: projects.map((project, index) => ({
      sourceText: projectBlocks[index]!,
      name: project.name,
      description: project.description,
      date: project.date,
      technologies: [...project.technologies],
      bullets: [project.bullet]
    })),
    education: [
      {
        sourceText: educationBlocks[0]!,
        institution: "Example Learning Studio",
        credential: "Immersive Operations Certificate",
        fieldOfStudy: null,
        startDate: "Jan 2020",
        endDate: "Apr 2020",
        details: [educationLines[1]!]
      },
      {
        sourceText: educationBlocks[1]!,
        institution: "Example State University",
        credential: "Bachelor of Arts",
        fieldOfStudy: "Business Administration",
        startDate: null,
        endDate: "2014",
        details: []
      }
    ],
    certifications: [{
      sourceText: certificationSource,
      name: "Synthetic Reliability Professional",
      issuer: "Example Standards Board",
      date: "2024",
      expirationDate: "2027",
      details: [certificationLines[3]!, certificationLines[4]!]
    }],
    achievements: [...achievementLines],
    sectionStatus: {
      summary: "present",
      skills: "present",
      workHistory: "present",
      projects: "present",
      education: "present",
      certifications: "present",
      achievements: "present"
    },
    warnings: []
  };
}

export function resumeV9OwnerTopologyTwinCanonical(): ParsedResumeV5 {
  const full = resumeV9StructuralTwinCanonical();
  return {
    ...full,
    sourceSections: full.sourceSections.filter((section) =>
      section.section !== "certifications"
      && section.section !== "achievements"
      && section.section !== "additional"
    ),
    certifications: [],
    achievements: [],
    sectionStatus: {
      ...full.sectionStatus,
      certifications: "absent",
      achievements: "absent"
    }
  };
}
