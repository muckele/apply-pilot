import type { ParsedResumeV5 } from "@/lib/ai/resume";

type WorkRecord = {
  title: string;
  company: string;
  location: string;
  startDate: string;
  endDate: string;
  bullets: string[];
};

type ProjectRecord = {
  name: string;
  description: string;
  date: string;
  technologies: string[];
  bullet: string;
};

const bullet = (text: string, index: number) =>
  `• ${text} with recorded evidence for scenario ${index}.`;

const contactLines = [
  "Taylor Boundary",
  "Principal Operations and Delivery Leader",
  "Location: Vancouver, Canada | taylor.boundary@example.test | +1 (555) 010-6403 | linkedin.example/taylor-boundary"
];

const summary = "Operations and delivery leader who builds reliable service workflows across customer support, analytics, platform operations, and cross-functional programs. Experienced in turning ambiguous requirements into measurable plans, coaching distributed teams, and improving data quality.";

const skillGroups = [
  "Operations: service delivery, incident coordination, capacity planning, quality controls, vendor governance, R&D coordination, risk reviews, escalation design, and continuous improvement",
  "Data and platforms: SQL, PostgreSQL, TypeScript, Azure, reporting automation, dashboard design, data reconciliation, workflow instrumentation, and access reviews",
  "Leadership: program planning, stakeholder communication, team coaching, change management, process documentation, executive briefings, roadmap facilitation, and outcome measurement"
];

const workRecords: WorkRecord[] = [
  {
    title: "Director of Service Operations",
    company: "Northwind Systems",
    location: "Vancouver, Canada",
    startDate: "Jan 2022",
    endDate: "Present",
    bullets: [
      bullet("Designed a multi-team intake model that clarified ownership, service levels, escalation paths, and evidence requirements", 1),
      bullet("Established weekly operating reviews that connected customer impact, delivery risk, staffing constraints, and remediation decisions", 2),
      bullet("Introduced SQL reconciliation checks that detected reporting drift before executive dashboards and monthly planning cycles", 3),
      bullet("Coached managers on measurable goals, concise decision records, and respectful communication during complex service incidents", 4),
      bullet("Partnered with security and engineering leaders to document access boundaries, exception handling, and release readiness", 5)
    ]
  },
  {
    title: "Senior Program Manager",
    company: "Contoso Delivery Labs",
    location: "Remote",
    startDate: "Mar 2019",
    endDate: "Dec 2021",
    bullets: [
      bullet("Led a portfolio of onboarding programs with explicit milestones, dependency maps, decision owners, and outcome measures", 6),
      bullet("Built capacity forecasts that balanced implementation demand, specialist availability, customer timing, and operational risk", 7),
      bullet("Created reusable launch checklists and training guides that reduced avoidable handoff defects across distributed teams", 8),
      bullet("Presented quarterly delivery findings with transparent assumptions, unresolved risks, and recommended follow-up experiments", 9)
    ]
  },
  {
    title: "Operations Analytics Manager",
    company: "Fabrikam Services",
    location: "Toronto, Canada",
    startDate: "Jul 2016",
    endDate: "Feb 2019",
    bullets: [
      bullet("Developed service-health reporting that combined case volume, response quality, backlog age, and customer sentiment", 10),
      bullet("Automated recurring data preparation while retaining source references, exception logs, and reviewer sign-off points", 11),
      bullet("Facilitated metric-definition workshops that resolved inconsistent terminology across finance, support, and product groups", 12),
      bullet("Investigated unusual trends with reproducible queries and separated observed facts from hypotheses in leadership updates", 13)
    ]
  },
  {
    title: "Customer Experience Lead",
    company: "Adventure Works Cloud",
    location: "Calgary, Canada",
    startDate: "Apr 2013",
    endDate: "Jun 2016",
    bullets: [
      bullet("Redesigned complex escalation workflows so frontline teams could identify urgency, route ownership, and required context", 14),
      bullet("Produced customer-journey reviews that linked recurring friction to specific policy, tooling, and documentation gaps", 15),
      bullet("Coordinated recovery plans for high-impact accounts while preserving accurate commitments and clear internal boundaries", 16),
      bullet("Mentored specialists on structured troubleshooting, empathetic writing, and evidence-based recommendations", 17)
    ]
  },
  {
    title: "Business Process Analyst",
    company: "Tailspin Consulting",
    location: "Ottawa, Canada",
    startDate: "Sep 2010",
    endDate: "Mar 2013",
    bullets: [
      bullet("Mapped operational processes with owners, inputs, controls, failure modes, and practical improvement opportunities", 18),
      bullet("Created Excel and SQL analyses that reconciled source systems before recommendations were shared with clients", 19),
      bullet("Documented implementation decisions and open questions so later teams could understand scope and tradeoffs", 20),
      bullet("Supported change workshops with synthetic scenarios, accessible job aids, and observable adoption measures", 21)
    ]
  }
];

const projects: ProjectRecord[] = [
  {
    name: "Service Reliability Workbench",
    description: "Auditable Operations Dashboard",
    date: "2025",
    technologies: ["TypeScript", "PostgreSQL", "Azure"],
    bullet: bullet("Built a synthetic dashboard that preserved source references while highlighting service risk, ownership, and follow-up status", 22)
  },
  {
    name: "Planning Evidence Library",
    description: "Decision Support Catalog",
    date: "2024",
    technologies: ["SQL", "Excel", "documentation workflows"],
    bullet: bullet("Created a searchable evidence catalog for synthetic plans with stable identifiers, bounded summaries, and omission tracking", 23)
  }
];

const educationRecords = [
  {
    institution: "Synthetic Institute of Operations",
    credential: "Graduate Certificate",
    fieldOfStudy: "Service Operations and Analytics",
    startDate: "Sep 2009",
    endDate: "Jun 2010",
    detail: "Completed a 480-hour applied program in service design, operational measurement, responsible data use, and change leadership."
  },
  {
    institution: "Example University",
    credential: "Bachelor of Arts",
    fieldOfStudy: "Business Administration",
    startDate: "Sep 2005",
    endDate: "Jun 2009",
    detail: "Completed interdisciplinary coursework in organizational behavior, statistics, economics, and professional communication."
  }
];

const certificationRecord = {
  name: "Certified Service Operations Professional",
  issuer: "Synthetic Standards Board",
  date: "2024",
  detail: "Credential ID: SYN-OPS-6403"
};

const achievementRecords = [
  "Operational Excellence: Received a synthetic 2025 service-quality award for measurable delivery improvements.",
  "Community Impact: Recognized for clear incident education and respectful cross-team coordination."
];

const additionalRecord =
  "Volunteer: Mentors career changers through a synthetic community technology program.";

const workRecordText = (record: WorkRecord) => [
  `${record.title} | ${record.company}`,
  `Location: ${record.location}`,
  `${record.startDate} - ${record.endDate}`,
  ...record.bullets
].join("\n");

const projectRecordText = (record: ProjectRecord) => [
  `${record.name} | ${record.description} | ${record.date}`,
  `Technologies: ${record.technologies.join(", ")}`,
  record.bullet
].join("\n");

const educationRecordText = (record: typeof educationRecords[number]) => [
  `${record.credential} in ${record.fieldOfStudy}`,
  record.institution,
  `${record.startDate} - ${record.endDate}`,
  record.detail
].join("\n");

const certificationRecordText = [
  `${certificationRecord.name} | ${certificationRecord.issuer} | ${certificationRecord.date}`,
  certificationRecord.detail
].join("\n");

const workSource = workRecords.map(workRecordText).join("\n\n");
const projectSource = projects.map(projectRecordText).join("\n\n");
const educationSource = educationRecords.map(educationRecordText).join("\n\n");

export const fullSizeSyntheticResumeText = [
  contactLines.join("\n"),
  "PROFESSIONAL SUMMARY",
  summary,
  "CORE SKILLS",
  skillGroups.join("\n"),
  "PROFESSIONAL EXPERIENCE",
  workSource,
  "SELECTED TECHNICAL PROJECTS",
  projectSource,
  "EDUCATION",
  educationSource,
  "CERTIFICATIONS",
  certificationRecordText,
  "ACHIEVEMENTS",
  achievementRecords.join("\n"),
  "ADDITIONAL INFORMATION",
  additionalRecord
].join("\n\n");

export const fullSizeSyntheticDocxExtractedText =
  `${fullSizeSyntheticResumeText}\n\n`;

const asDocxBlock = (value: string) => value;

export function fullSizeSyntheticProviderOutput(): ParsedResumeV5 {
  const contactSource = asDocxBlock(contactLines.join("\n"));
  const skillsSource = asDocxBlock(skillGroups.join("\n"));
  const docxWorkRecords = workRecords.map((record) => asDocxBlock(workRecordText(record)));
  const docxProjectRecords = projects.map((record) => asDocxBlock(projectRecordText(record)));
  const docxEducationRecords = educationRecords.map((record) => asDocxBlock(educationRecordText(record)));
  const docxCertificationRecord = asDocxBlock(certificationRecordText);
  const docxAchievements = asDocxBlock(achievementRecords.join("\n"));
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: contactSource, recordBlocks: [contactSource] },
      { section: "summary", heading: "PROFESSIONAL SUMMARY", sourceText: summary, recordBlocks: [summary] },
      {
        section: "skills",
        heading: "CORE SKILLS",
        sourceText: skillsSource,
        recordBlocks: skillGroups
      },
      {
        section: "workHistory",
        heading: "PROFESSIONAL EXPERIENCE",
        sourceText: docxWorkRecords.join("\n\n"),
        recordBlocks: docxWorkRecords
      },
      {
        section: "projects",
        heading: "SELECTED TECHNICAL PROJECTS",
        sourceText: docxProjectRecords.join("\n\n"),
        recordBlocks: docxProjectRecords
      },
      {
        section: "education",
        heading: "EDUCATION",
        sourceText: docxEducationRecords.join("\n\n"),
        recordBlocks: docxEducationRecords
      },
      {
        section: "certifications",
        heading: "CERTIFICATIONS",
        sourceText: docxCertificationRecord,
        recordBlocks: [docxCertificationRecord]
      },
      {
        section: "achievements",
        heading: "ACHIEVEMENTS",
        sourceText: docxAchievements,
        recordBlocks: achievementRecords
      },
      {
        section: "additional",
        heading: "ADDITIONAL INFORMATION",
        sourceText: additionalRecord,
        recordBlocks: [additionalRecord]
      }
    ],
    contactInfo: {
      sourceText: contactSource,
      name: "Taylor Boundary",
      headline: "Principal Operations and Delivery Leader",
      email: "taylor.boundary@example.test",
      phone: "+1 (555) 010-6403",
      location: "Vancouver, Canada",
      linkedin: "linkedin.example/taylor-boundary",
      github: null,
      portfolio: null
    },
    summary,
    skills: [
      "service delivery", "incident coordination", "capacity planning", "quality controls",
      "SQL", "PostgreSQL", "TypeScript", "Azure", "reporting automation",
      "program planning", "stakeholder communication", "team coaching", "change management"
    ],
    workHistory: workRecords.map((record, index) => ({
      sourceText: docxWorkRecords[index]!,
      company: record.company,
      title: record.title,
      location: record.location,
      startDate: record.startDate,
      endDate: record.endDate,
      bullets: [...record.bullets]
    })),
    projects: projects.map((record, index) => ({
      sourceText: docxProjectRecords[index]!,
      name: record.name,
      description: record.description,
      date: record.date,
      technologies: [...record.technologies],
      bullets: [record.bullet]
    })),
    education: educationRecords.map((record, index) => ({
      sourceText: docxEducationRecords[index]!,
      institution: record.institution,
      credential: record.credential,
      fieldOfStudy: record.fieldOfStudy,
      startDate: record.startDate,
      endDate: record.endDate,
      details: [record.detail]
    })),
    certifications: [{
      sourceText: docxCertificationRecord,
      name: certificationRecord.name,
      issuer: certificationRecord.issuer,
      date: certificationRecord.date,
      expirationDate: null,
      details: [certificationRecord.detail]
    }],
    achievements: [...achievementRecords],
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
