import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESUME_PARSE_CACHE_VERSION,
  RESUME_PARSE_PROMPT_VERSION,
  validateParsedResumeOutput,
  type ParsedResumeV5
} from "@/lib/ai/resume";
import { buildApplicationPlanPayload } from "@/lib/ai/application-plan";
import {
  getJobMatchEvidenceReferences,
  normalizeJobMatchOutput,
  type JobMatchModelOutput,
  type MatchInput
} from "@/lib/ai/job-match";
import { buildResumeTailoringPayload } from "@/lib/ai/resume-tailoring-payload";
import { PublicApiError } from "@/lib/api-errors";

export const completeSyntheticResumeText = `Jordan Example
Systems Operations Analyst
Location: Toronto, Canada | jordan@example.test | +1 (555) 010-1000

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

const contact = `Jordan Example
Systems Operations Analyst
Location: Toronto, Canada | jordan@example.test | +1 (555) 010-1000`;
const summary = "Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery.";
const skills = `Data: SQL, Excel, reporting
Delivery: Agile, stakeholder communication
Platforms: TypeScript, PostgreSQL, Azure`;
const firstWork = `Operations Analyst
Northwind Services
Location: Toronto, Canada
Jan 2022 - Present
• Built TypeScript workflow checks with PostgreSQL and Azure.
• Improved monthly reporting accuracy by 18%.`;
const secondWork = `Customer Support Specialist
Contoso Labs
Remote
Jun 2019 - Dec 2021
• Resolved technical onboarding issues for enterprise customers.
• Documented support patterns for product and engineering teams.`;
const firstProject = `Apply Pilot | Truthful Application Workflow | 2026
Technologies: TypeScript, PostgreSQL
• Built a review-first application workflow with TypeScript and PostgreSQL.`;
const secondProject = `Service Health Board | Reliability Reporting Dashboard | 2025
Technologies: SQL, Azure
• Created a dashboard that summarized service health trends.`;
const certificateEducation = `Operations Analytics Certificate
Synthetic Institute
Jan 2021 - Jun 2021
• Completed a 480-hour program in operations analytics and data reporting.`;
const degreeEducation = `Bachelor of Arts in Business Administration
Example University
Sep 2014 - Jun 2018`;
const certification = `Certified Service Operations Professional | Synthetic Board | 2024
Credential ID: SYN-12345`;
const achievements = `Operational Excellence: Received the 2024 Process Improvement Award.
Customer Impact: Recognized for clear incident communications.`;
const additional = "Volunteer: Mentored career changers through a community technology program.";

export function completeSyntheticParsedResume(): ParsedResumeV5 {
  return {
    contractVersion: "5",
    sourceSections: [
      { section: "contactInfo", heading: null, sourceText: contact, recordBlocks: [contact] },
      { section: "summary", heading: "SUMMARY", sourceText: summary, recordBlocks: [summary] },
      { section: "skills", heading: "SKILLS", sourceText: skills, recordBlocks: skills.split("\n") },
      { section: "workHistory", heading: "EXPERIENCE", sourceText: `${firstWork}\n\n${secondWork}`, recordBlocks: [firstWork, secondWork] },
      { section: "projects", heading: "PROJECTS", sourceText: `${firstProject}\n\n${secondProject}`, recordBlocks: [firstProject, secondProject] },
      { section: "education", heading: "EDUCATION", sourceText: `${certificateEducation}\n\n${degreeEducation}`, recordBlocks: [certificateEducation, degreeEducation] },
      { section: "certifications", heading: "CERTIFICATIONS", sourceText: certification, recordBlocks: [certification] },
      { section: "achievements", heading: "ACHIEVEMENTS", sourceText: achievements, recordBlocks: achievements.split("\n") },
      { section: "additional", heading: "ADDITIONAL INFORMATION", sourceText: additional, recordBlocks: [additional] }
    ],
    contactInfo: {
      sourceText: contact,
      name: "Jordan Example",
      headline: "Systems Operations Analyst",
      email: "jordan@example.test",
      phone: "+1 (555) 010-1000",
      location: "Toronto, Canada",
      linkedin: null,
      github: null,
      portfolio: null
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
      bullets: [
        "• Built TypeScript workflow checks with PostgreSQL and Azure.",
        "• Improved monthly reporting accuracy by 18%."
      ]
    }, {
      sourceText: secondWork,
      company: "Contoso Labs",
      title: "Customer Support Specialist",
      location: "Remote",
      startDate: "Jun 2019",
      endDate: "Dec 2021",
      bullets: [
        "• Resolved technical onboarding issues for enterprise customers.",
        "• Documented support patterns for product and engineering teams."
      ]
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
      sourceText: certificateEducation,
      institution: "Synthetic Institute",
      credential: "Operations Analytics Certificate",
      fieldOfStudy: "operations analytics",
      startDate: "Jan 2021",
      endDate: "Jun 2021",
      details: ["• Completed a 480-hour program in operations analytics and data reporting."]
    }, {
      sourceText: degreeEducation,
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

function publicError(error: unknown, code: string, fieldPath?: string) {
  return error instanceof PublicApiError && error.details?.code === code &&
    (fieldPath === undefined || error.details?.fieldPath === fieldPath);
}

test("resume parsing uses coherent v5 contract, prompt, and cache revisions", () => {
  assert.equal(RESUME_PARSE_PROMPT_VERSION, "5");
  assert.equal(RESUME_PARSE_CACHE_VERSION, "5");
  assert.equal(completeSyntheticParsedResume().contractVersion, "5");
});

test("lossless source authority accepts connector words, grouped skills, mixed contact facts, and overlapping projections", () => {
  const parsed = validateParsedResumeOutput(completeSyntheticResumeText, completeSyntheticParsedResume());

  assert.equal(parsed.education[1]?.credential, "Bachelor of Arts");
  assert.equal(parsed.education[1]?.fieldOfStudy, "Business Administration");
  assert.deepEqual(parsed.projects[0]?.technologies, ["TypeScript", "PostgreSQL"]);
  assert.match(parsed.projects[0]?.bullets[0] ?? "", /TypeScript and PostgreSQL/);
  assert.equal(parsed.sourceSections.at(-1)?.section, "additional");
  assert.equal(parsed.certifications[0]?.details[0], "Credential ID: SYN-12345");
});

test("lossless authority rejects an omitted source fact with a privacy-safe field path", () => {
  const omitted = completeSyntheticParsedResume();
  omitted.sourceSections[2]!.recordBlocks.pop();
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, omitted),
    (error) => publicError(error, "RESUME_PARSE_INCOMPLETE", "sourceSections[2].recordBlocks")
  );
});

test("typed projections reject invented facts without retaining raw provider output", () => {
  const invented = completeSyntheticParsedResume();
  invented.education[1]!.fieldOfStudy = "Astrophysics";
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, invented),
    (error) => publicError(error, "RESUME_PARSE_UNSUPPORTED_FACT", "education[1].fieldOfStudy")
  );
});

test("lossless authority rejects wrong record order and adjacent record merges", () => {
  const reordered = completeSyntheticParsedResume();
  reordered.sourceSections[3]!.recordBlocks.reverse();
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, reordered),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[0]")
  );

  const merged = completeSyntheticParsedResume();
  merged.sourceSections[3]!.recordBlocks = [`${firstWork}\n\n${secondWork}`];
  merged.workHistory = [{
    ...merged.workHistory[0]!,
    sourceText: `${firstWork}\n\n${secondWork}`,
    bullets: [...merged.workHistory[0]!.bullets, ...merged.workHistory[1]!.bullets]
  }];
  assert.throws(
    () => validateParsedResumeOutput(completeSyntheticResumeText, merged),
    (error) => publicError(error, "RESUME_PARSE_STRUCTURE_AMBIGUOUS", "sourceSections[3].recordBlocks[0]")
  );
});

test("the central legacy decoder reads v3 project records without date and upgrades to v5 authority", () => {
  const legacySource = `Jordan Example
jordan@example.test

PROJECTS
Project Alpha
Built a controlled application workflow.`;
  const legacy = {
    contractVersion: "3",
    contactInfo: {
      sourceText: "Jordan Example\njordan@example.test",
      name: "Jordan Example",
      headline: null,
      email: "jordan@example.test",
      phone: null,
      location: null,
      linkedin: null,
      github: null,
      portfolio: null
    },
    summary: "",
    skills: [],
    workHistory: [],
    projects: [{
      sourceText: "Project Alpha\nBuilt a controlled application workflow.",
      name: "Project Alpha",
      description: "Built a controlled application workflow.",
      technologies: [],
      bullets: []
    }],
    education: [],
    certifications: [],
    achievements: [],
    sectionStatus: {
      summary: "absent",
      skills: "absent",
      workHistory: "absent",
      projects: "present",
      education: "absent",
      certifications: "absent",
      achievements: "absent"
    },
    warnings: []
  };

  const parsed = validateParsedResumeOutput(legacySource, legacy);
  assert.equal(parsed.contractVersion, "5");
  assert.equal(parsed.projects[0]?.date, null);
  assert.ok(parsed.sourceSections.length > 0);
});

test("application planning keeps canonical education and project facts and reports every bounded omission", () => {
  const parsed = completeSyntheticParsedResume();
  const payload = buildApplicationPlanPayload({
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "TypeScript, SQL, reporting, and stakeholder communication.",
      requirements: ["TypeScript", "SQL"]
    },
    resume: {
      rawText: completeSyntheticResumeText,
      summary: parsed.summary,
      skills: [...parsed.skills, ...Array.from({ length: 35 }, (_, index) => `Extra skill ${index + 1}`)],
      achievements: parsed.achievements,
      workHistory: parsed.workHistory,
      projects: parsed.projects,
      education: parsed.education,
      certifications: parsed.certifications
    }
  });

  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "education-2" && /Business Administration/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "project-1-highlight-1" && /review-first/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "certification-1-detail-1" && /SYN-12345/.test(entry.text)));
  assert.ok(payload.evidenceCatalog.some((entry) => entry.id === "raw-source-1" && /ADDITIONAL INFORMATION/.test(entry.text)));
  assert.deepEqual(payload.projectionOmissions.find((item) => item.sourcePath === "resume.skills"), {
    sourcePath: "resume.skills",
    omittedIds: Array.from({ length: 13 }, (_, index) => `skill-${index + 31}`),
    omittedCount: 13,
    truncatedIds: []
  });
});

test("job match exposes projects, education, and certifications as structured evidence with raw source fallback", () => {
  const parsed = completeSyntheticParsedResume();
  const input: MatchInput = {
    job: {
      title: "Operations Engineer",
      company: "Example Co",
      description: "Build TypeScript workflows.",
      requirements: ["TypeScript"]
    },
    resume: {
      summary: parsed.summary,
      rawText: completeSyntheticResumeText,
      skills: parsed.skills,
      achievements: parsed.achievements,
      workHistory: parsed.workHistory,
      projects: parsed.projects,
      education: parsed.education,
      certifications: parsed.certifications
    }
  };
  const refs = getJobMatchEvidenceReferences(input).applicant;
  assert.ok(refs.includes("resume.projects[0]"));
  assert.ok(refs.includes("resume.education[1]"));
  assert.ok(refs.includes("resume.certifications[0]"));
  assert.ok(refs.includes("resume.rawText"));

  const output: JobMatchModelOutput = {
    contractVersion: "3",
    overallFitScore: 80,
    resumeKeywordScore: 80,
    skillsMatchScore: 80,
    experienceMatchScore: 80,
    careerGoalScore: 70,
    locationWorkStyleScore: 70,
    compensationScore: null,
    confidenceScore: 75,
    confidenceBasis: "Structured evidence was cited.",
    factualMatches: [{
      applicantEvidence: [{ ref: "resume.projects[0]", excerpt: "TypeScript" }],
      jobEvidence: [{ ref: "job.requirements[0]", excerpt: "TypeScript" }],
      supportedKeywords: ["TypeScript"]
    }],
    requirementGaps: [],
    advice: {
      keywordsToEmphasize: ["TypeScript"],
      resumeAngle: "Use the cited project.",
      coverLetterAngle: "Discuss the cited workflow."
    },
    recommendation: "consider"
  };
  assert.equal(normalizeJobMatchOutput(input, output).factualMatches[0]?.applicantEvidence[0]?.ref, "resume.projects[0]");
});

test("tailoring receives only canonical career fields plus the raw source fallback", () => {
  const parsed = completeSyntheticParsedResume();
  const payload = buildResumeTailoringPayload({ id: "job-1", title: "Operations Engineer", description: "TypeScript" }, {
    id: "resume-1",
    filePath: "/private/resume.docx",
    contactInfo: parsed.contactInfo,
    rawText: completeSyntheticResumeText,
    summary: parsed.summary,
    skills: parsed.skills,
    achievements: parsed.achievements,
    workHistory: parsed.workHistory,
    projects: parsed.projects,
    education: parsed.education,
    certifications: parsed.certifications
  }, { careerGoals: "Reliable operations", email: "private@example.test" });

  assert.ok(payload.resume);
  assert.ok(payload.profile);
  assert.equal(payload.resume.rawText, completeSyntheticResumeText);
  assert.deepEqual(payload.resume.projects, parsed.projects);
  assert.deepEqual(payload.resume.education, parsed.education);
  assert.deepEqual(payload.resume.certifications, parsed.certifications);
  assert.ok(!("filePath" in payload.resume));
  assert.ok(!("contactInfo" in payload.resume));
  assert.ok(!("email" in payload.profile));
});
