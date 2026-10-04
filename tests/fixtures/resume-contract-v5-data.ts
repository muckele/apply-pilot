import type { ParsedResumeV5 } from "@/lib/ai/resume";

export const syntheticResumeText = `Jordan Example
Systems Operations Analyst
Riverton, CA | (555) 010-1000 | jordan@example.test
https://portfolio.example.test/jordan | https://www.linkedin.com/in/jordan-example | https://github.com/jordan-example

SUMMARY
Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery.

SKILLS
Data: SQL, Excel, reporting
Delivery: Agile, stakeholder communication
Platforms: TypeScript, PostgreSQL, Azure

EXPERIENCE
Operations Analyst
Northwind Services
Location: Toronto, Canada
Jan 2022 - Present
• Built TypeScript workflow checks with PostgreSQL and Azure.
• Improved monthly reporting accuracy by 18%.

Customer Support Specialist
Contoso Labs
Remote
Jun 2019 - Dec 2021
• Resolved technical onboarding issues for enterprise customers.
• Documented support patterns for product and engineering teams.

PROJECTS
Apply Pilot | Truthful Application Workflow | 2026
Technologies: TypeScript, PostgreSQL
• Built a review-first application workflow with TypeScript and PostgreSQL.

Service Health Board | Reliability Reporting Dashboard | 2025
Technologies: SQL, Azure
• Created a dashboard that summarized service health trends.

EDUCATION
Operations Analytics Certificate
Synthetic Institute
Jan 2021 - Jun 2021
• Completed a 480-hour program in operations analytics and data reporting.

Bachelor of Arts in Business Administration
Example University
Sep 2014 - Jun 2018

CERTIFICATIONS
Certified Service Operations Professional | Synthetic Board | 2024
Credential ID: SYN-12345

ACHIEVEMENTS
Operational Excellence: Received the 2024 Process Improvement Award.
Customer Impact: Recognized for clear incident communications.

ADDITIONAL INFORMATION
Volunteer: Mentored career changers through a community technology program.`;

const block = (value: string) => value.replace(/\n/g, "\n\n");
export const syntheticDocxExtractedText =
  `${syntheticResumeText.split("\n\n").map(block).join("\n\n")}\n\n`;
const contact = block(`Jordan Example
Systems Operations Analyst
Riverton, CA | (555) 010-1000 | jordan@example.test
https://portfolio.example.test/jordan | https://www.linkedin.com/in/jordan-example | https://github.com/jordan-example`);
const summary = "Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery.";
const skillsSource = block(`Data: SQL, Excel, reporting
Delivery: Agile, stakeholder communication
Platforms: TypeScript, PostgreSQL, Azure`);
const firstWork = block(`Operations Analyst
Northwind Services
Location: Toronto, Canada
Jan 2022 - Present
• Built TypeScript workflow checks with PostgreSQL and Azure.
• Improved monthly reporting accuracy by 18%.`);
const secondWork = block(`Customer Support Specialist
Contoso Labs
Remote
Jun 2019 - Dec 2021
• Resolved technical onboarding issues for enterprise customers.
• Documented support patterns for product and engineering teams.`);
const firstProject = block(`Apply Pilot | Truthful Application Workflow | 2026
Technologies: TypeScript, PostgreSQL
• Built a review-first application workflow with TypeScript and PostgreSQL.`);
const secondProject = block(`Service Health Board | Reliability Reporting Dashboard | 2025
Technologies: SQL, Azure
• Created a dashboard that summarized service health trends.`);
const firstEducation = block(`Operations Analytics Certificate
Synthetic Institute
Jan 2021 - Jun 2021
• Completed a 480-hour program in operations analytics and data reporting.`);
const secondEducation = block(`Bachelor of Arts in Business Administration
Example University
Sep 2014 - Jun 2018`);
const certification = block(`Certified Service Operations Professional | Synthetic Board | 2024
Credential ID: SYN-12345`);
const achievementsSource = block(`Operational Excellence: Received the 2024 Process Improvement Award.
Customer Impact: Recognized for clear incident communications.`);
const additional = "Volunteer: Mentored career changers through a community technology program.";

export function syntheticDocxProviderOutput(): ParsedResumeV5 {
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: contact, recordBlocks: [contact] },
      { section: "summary", heading: "SUMMARY", sourceText: summary, recordBlocks: [summary] },
      {
        section: "skills",
        heading: "SKILLS",
        sourceText: skillsSource,
        recordBlocks: ["Data: SQL, Excel, reporting", "Delivery: Agile, stakeholder communication", "Platforms: TypeScript, PostgreSQL, Azure"]
      },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: `${firstWork}\n\n${secondWork}`, recordBlocks: [firstWork, secondWork] },
      { section: "projects", heading: "PROJECTS", sourceText: `${firstProject}\n\n${secondProject}`, recordBlocks: [firstProject, secondProject] },
      { section: "education", heading: "EDUCATION", sourceText: `${firstEducation}\n\n${secondEducation}`, recordBlocks: [firstEducation, secondEducation] },
      { section: "certifications", heading: "CERTIFICATIONS", sourceText: certification, recordBlocks: [certification] },
      {
        section: "achievements",
        heading: "ACHIEVEMENTS",
        sourceText: achievementsSource,
        recordBlocks: [
          "Operational Excellence: Received the 2024 Process Improvement Award.",
          "Customer Impact: Recognized for clear incident communications."
        ]
      },
      { section: "additional", heading: "ADDITIONAL INFORMATION", sourceText: additional, recordBlocks: [additional] }
    ],
    contactInfo: {
      sourceText: contact,
      name: "Jordan Example",
      headline: "Systems Operations Analyst",
      email: "jordan@example.test",
      phone: "(555) 010-1000",
      location: "Riverton, CA",
      linkedin: "https://www.linkedin.com/in/jordan-example",
      github: "https://github.com/jordan-example",
      portfolio: "https://portfolio.example.test/jordan"
    },
    summary,
    skills: ["SQL", "Excel", "reporting", "Agile", "stakeholder communication", "TypeScript", "PostgreSQL", "Azure"],
    workHistory: [{
      sourceText: firstWork,
      company: "Northwind Services",
      title: "Operations Analyst",
      location: "Toronto, Canada",
      startDate: "Jan 2022",
      endDate: "Present",
      bullets: ["• Built TypeScript workflow checks with PostgreSQL and Azure.", "• Improved monthly reporting accuracy by 18%."]
    }, {
      sourceText: secondWork,
      company: "Contoso Labs",
      title: "Customer Support Specialist",
      location: "Remote",
      startDate: "Jun 2019",
      endDate: "Dec 2021",
      bullets: ["• Resolved technical onboarding issues for enterprise customers.", "• Documented support patterns for product and engineering teams."]
    }],
    projects: [{
      sourceText: firstProject,
      name: "Apply Pilot",
      description: "Truthful Application Workflow",
      date: "2026",
      technologies: ["TypeScript", "PostgreSQL"],
      bullets: ["• Built a review-first application workflow with TypeScript and PostgreSQL."]
    }, {
      sourceText: secondProject,
      name: "Service Health Board",
      description: "Reliability Reporting Dashboard",
      date: "2025",
      technologies: ["SQL", "Azure"],
      bullets: ["• Created a dashboard that summarized service health trends."]
    }],
    education: [{
      sourceText: firstEducation,
      institution: "Synthetic Institute",
      credential: "Operations Analytics Certificate",
      fieldOfStudy: "operations analytics",
      startDate: "Jan 2021",
      endDate: "Jun 2021",
      details: ["• Completed a 480-hour program in operations analytics and data reporting."]
    }, {
      sourceText: secondEducation,
      institution: "Example University",
      credential: "Bachelor of Arts",
      fieldOfStudy: "Business Administration",
      startDate: "Sep 2014",
      endDate: "Jun 2018",
      details: []
    }],
    certifications: [{
      sourceText: certification,
      name: "Certified Service Operations Professional",
      issuer: "Synthetic Board",
      date: "2024",
      expirationDate: null,
      details: ["Credential ID: SYN-12345"]
    }],
    achievements: [
      "Operational Excellence: Received the 2024 Process Improvement Award.",
      "Customer Impact: Recognized for clear incident communications."
    ],
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
