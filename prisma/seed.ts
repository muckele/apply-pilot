import { PrismaClient } from "@prisma/client";

import { normalizeText, normalizeUrl } from "../lib/normalize";
import {
  DatabaseTargetSafetyError,
  LOCAL_DEVELOPMENT_DATABASE_NAME,
  assertLoopbackHostResolution,
  validateLocalDestructiveEnvironment
} from "../scripts/database-target-safety";

const userId = process.env.DEFAULT_DEMO_USER_ID ?? "demo-user";
const LIVE_CHECK_TIMEOUT_MS = 10_000;
let prismaForCleanup: PrismaClient | null = null;

function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DatabaseTargetSafetyError(message)), LIVE_CHECK_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function main() {
  const pair = validateLocalDestructiveEnvironment(process.env);
  await assertLoopbackHostResolution([pair.database, pair.direct]);
  const prisma = new PrismaClient({ datasources: { db: { url: pair.database.url } } });
  prismaForCleanup = prisma;
  await withTimeout(prisma.$connect(), "Local database connection timed out before seed.");
  const databaseRows = await withTimeout(
    prisma.$queryRawUnsafe<Array<{ current_database: string }>>("SELECT current_database()"),
    "Local database identity check timed out before seed."
  );
  if (databaseRows[0]?.current_database !== LOCAL_DEVELOPMENT_DATABASE_NAME) {
    throw new DatabaseTargetSafetyError(
      `Live local database identity must be exactly ${LOCAL_DEVELOPMENT_DATABASE_NAME}.`
    );
  }

  await prisma.user.deleteMany({ where: { id: userId } });

  // Fictional sample persona: the person, employer and school below are invented for local demos.
  await prisma.user.create({
    data: {
      id: userId,
      name: "Sample User",
      email: "sample@example.com",
      profile: {
        create: {
          location: "Anytown, USA",
          careerGoals:
            "Fictional sample persona for local demos: find customer-facing technical roles that combine software skills with implementation and customer onboarding.",
          preferredRoles: [
            "Solutions Engineer",
            "Implementation Specialist",
            "Customer Success Engineer",
            "Junior Software Engineer"
          ],
          preferredLocations: ["Remote", "Hybrid", "Anytown, USA"],
          remotePreference: "FLEXIBLE",
          salaryTargetMin: 70000,
          salaryTargetMax: 100000,
          industriesOfInterest: ["SaaS", "Developer tools"],
          dealBreakers: ["Commission-only roles", "Unauthorized automation expectations"],
          skillsToEmphasize: [
            "JavaScript",
            "React",
            "Node.js",
            "SQL",
            "PostgreSQL",
            "REST APIs",
            "Customer onboarding",
            "Workflow documentation"
          ],
          skillsNotToExaggerate: [
            "Enterprise-scale production ownership",
            "Deep DevOps ownership",
            "Tools only listed in a job posting but not supported by experience"
          ],
          workAuthorizationNotes: "Add work authorization details before applying.",
          availabilityNotes: "Available for remote or hybrid roles.",
          preferredResumeTone: "clear, honest, concise, customer-facing technical"
        }
      }
    }
  });

  const resume = await prisma.resume.create({
    data: {
      userId,
      title: "Master Resume",
      isMaster: true,
      rawText:
        "Sample User is a fictional demo persona: a customer-facing technical professional with a software engineering certificate from Example Coding Academy and customer onboarding experience at Example Logistics Co. Skills include JavaScript, React, Node.js, SQL, PostgreSQL, REST APIs, HTML, and CSS.",
      contactInfo: { name: "Sample User", location: "Anytown, USA" },
      summary:
        "Customer-facing technical professional combining software engineering training with customer onboarding and implementation-oriented experience.",
      skills: [
        "JavaScript",
        "React",
        "Node.js",
        "SQL",
        "PostgreSQL",
        "REST APIs",
        "Customer onboarding",
        "Workflow documentation"
      ],
      workHistory: [
        {
          company: "Example Logistics Co.",
          role: "Customer Operations Specialist",
          highlights: [
            "Onboarded new customers, documented support workflows, and coordinated handoffs between support and engineering."
          ]
        }
      ],
      projects: [
        {
          name: "Example Coding Academy capstone",
          technologies: ["React", "Node.js", "PostgreSQL", "REST APIs"]
        }
      ],
      education: [{ school: "Example Coding Academy", program: "Software engineering certificate" }],
      certifications: [],
      achievements: [
        "Documented customer onboarding workflows used across a support team."
      ],
      parsedAt: new Date()
    }
  });

  const greenhouse = await prisma.jobSource.create({
    data: {
      userId,
      name: "Northstar SaaS",
      type: "GREENHOUSE",
      boardToken: "northstar-demo",
      allowlisted: true,
      robotsChecked: true,
      notes: "Demo Greenhouse source using public board API pattern."
    }
  });

  const jobs = [
    {
      id: "job-1",
      title: "Solutions Engineer, SMB",
      company: "Northstar SaaS",
      location: "Los Angeles, CA",
      remoteStatus: "Hybrid",
      salaryMin: 95000,
      salaryMax: 125000,
      datePosted: new Date("2026-05-16"),
      sourceUrl: "https://boards.greenhouse.io/northstar/jobs/demo-solutions-engineer",
      applyUrl: "https://boards.greenhouse.io/northstar/jobs/demo-solutions-engineer",
      description:
        "Partner with sales and customer success to scope technical requirements, deliver product demos, support API evaluations, and guide SMB customers through implementation.",
      requirements: ["Technical discovery", "Product demos", "REST API understanding", "Customer-facing communication"],
      preferredQualifications: ["Salesforce administration", "SOC 2 familiarity"],
      benefits: ["Health insurance", "Hybrid schedule"],
      detectedTechStack: ["React", "REST APIs", "Salesforce"],
      seniorityLevel: "Mid-level",
      sourceType: "GREENHOUSE" as const,
      score: 88
    },
    {
      id: "job-2",
      title: "Implementation Specialist",
      company: "CareFlow Systems",
      location: "Remote, US",
      remoteStatus: "Remote",
      salaryMin: 78000,
      salaryMax: 98000,
      datePosted: new Date("2026-05-18"),
      sourceUrl: "https://jobs.lever.co/careflow/demo-implementation-specialist",
      applyUrl: "https://jobs.lever.co/careflow/demo-implementation-specialist",
      description:
        "Own customer onboarding, workflow configuration, stakeholder training, and post-launch support for healthcare operations teams.",
      requirements: ["Healthcare operations", "Customer onboarding", "Workflow configuration", "SQL"],
      preferredQualifications: ["HL7", "EHR integrations"],
      benefits: ["Remote work", "Learning budget"],
      detectedTechStack: ["SQL", "APIs"],
      seniorityLevel: "Associate",
      sourceType: "LEVER" as const,
      score: 84
    },
    {
      id: "job-3",
      title: "Junior Full-Stack Developer",
      company: "Civic Tools Lab",
      location: "Pasadena, CA",
      remoteStatus: "On-site",
      salaryMin: 72000,
      salaryMax: 90000,
      datePosted: new Date("2026-05-14"),
      sourceUrl: "https://jobs.ashbyhq.com/civictools/demo-junior-full-stack",
      applyUrl: "https://jobs.ashbyhq.com/civictools/demo-junior-full-stack",
      description:
        "Build civic workflow tools with React, Node.js, PostgreSQL, REST APIs, and collaborative product development.",
      requirements: ["React", "Node.js", "PostgreSQL", "REST APIs"],
      preferredQualifications: ["CI/CD", "Docker"],
      benefits: ["Mentorship", "Professional development"],
      detectedTechStack: ["React", "Node.js", "PostgreSQL", "REST APIs"],
      seniorityLevel: "Junior",
      sourceType: "ASHBY" as const,
      score: 72
    }
  ];

  for (const job of jobs) {
    await prisma.jobPosting.create({
      data: {
        id: job.id,
        userId,
        jobSourceId: job.id === "job-1" ? greenhouse.id : undefined,
        title: job.title,
        normalizedTitle: normalizeText(job.title),
        company: job.company,
        normalizedCompany: normalizeText(job.company),
        location: job.location,
        normalizedLocation: normalizeText(job.location),
        remoteStatus: job.remoteStatus,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        datePosted: job.datePosted,
        sourceUrl: job.sourceUrl,
        applyUrl: job.applyUrl,
        normalizedApplyUrl: normalizeUrl(job.applyUrl),
        description: job.description,
        requirements: job.requirements,
        preferredQualifications: job.preferredQualifications,
        benefits: job.benefits,
        detectedTechStack: job.detectedTechStack,
        seniorityLevel: job.seniorityLevel,
        sourceType: job.sourceType,
        overallFitScore: job.score,
        resumeKeywordScore: job.score - 4,
        skillsMatchScore: job.score - 2,
        experienceMatchScore: job.score - 8,
        careerGoalScore: job.score,
        locationWorkStyleScore: job.remoteStatus === "Remote" ? 92 : 84,
        confidenceScore: 78,
        keyMatchReason:
          "Strong overlap with customer-facing technical work, implementation, customer onboarding, and software fundamentals.",
        matchRecommendation: job.score >= 80 ? "apply now" : "consider",
        missingKeywords: job.preferredQualifications,
        supportedKeywords: job.detectedTechStack,
        suggestedResumeAngle:
          "Lead with customer-facing technical problem solving, software training, and onboarding ownership.",
        suggestedCoverLetterAngle:
          "Connect software training with customer onboarding and implementation credibility.",
        concerns: ["Avoid adding unsupported keywords without evidence."]
      }
    });
  }

  await prisma.resumeVersion.create({
    data: {
      userId,
      resumeId: resume.id,
      jobPostingId: "job-1",
      title: "Northstar SaaS tailored resume",
      summary:
        "Customer-facing technical professional with software training and experience translating customer requirements into reliable workflows.",
      skills: ["React", "REST APIs", "Implementation", "Customer onboarding", "Workflow documentation"],
      bullets: [
        {
          rewrite:
            "Onboarded new customers and documented support workflows to shorten handoffs between support and engineering."
        }
      ],
      fullText:
        "Sample User\n\nCustomer-facing technical professional with software training and customer onboarding experience...",
      atsCompatibility: 82,
      jobFitScore: 88
    }
  });

  const application = await prisma.application.create({
    data: {
      id: "app-1",
      userId,
      jobPostingId: "job-1",
      status: "APPLIED",
      dateApplied: new Date("2026-05-17"),
      followUpDueAt: new Date("2026-05-22"),
      nextAction: "Follow up with recruiter",
      notes: "Applied with tailored customer-facing technical resume."
    }
  });

  await prisma.applicationEvent.createMany({
    data: [
      {
        userId,
        applicationId: application.id,
        type: "CREATED",
        title: "Application saved"
      },
      {
        userId,
        applicationId: application.id,
        type: "STATUS_CHANGED",
        title: "Marked as applied",
        occurredAt: new Date("2026-05-17")
      }
    ]
  });

  await prisma.generatedDocument.create({
    data: {
      userId,
      jobPostingId: "job-1",
      applicationId: application.id,
      type: "COVER_LETTER",
      title: "Northstar SaaS cover letter",
      content:
        "Dear Northstar SaaS Hiring Team,\n\nI am interested in the Solutions Engineer role because it combines technical discovery, customer communication, and implementation follow-through..."
    }
  });

  await prisma.interview.create({
    data: {
      id: "int-1",
      userId,
      jobPostingId: "job-1",
      applicationId: application.id,
      type: "RECRUITER",
      scheduledAt: new Date("2026-05-23T10:00:00-07:00"),
      durationMinutes: 30,
      interviewerNames: ["Alex Rivera"],
      interviewerUrls: [],
      prepBrief:
        "Prepare to connect technical discovery, software training, and customer onboarding ownership.",
      likelyQuestions: [
        "Tell me about your transition into technical roles.",
        "How do you explain APIs to non-technical customers?",
        "Describe a time you improved a customer onboarding workflow."
      ],
      starStories: [
        {
          theme: "Customer onboarding workflow",
          action: "Documented the onboarding steps and coordinated support-to-engineering handoffs."
        }
      ]
    }
  });

  await prisma.task.createMany({
    data: [
      {
        userId,
        jobPostingId: "job-1",
        applicationId: application.id,
        title: "Review Northstar SaaS follow-up draft",
        priority: "HIGH",
        dueAt: new Date("2026-05-22")
      },
      {
        userId,
        jobPostingId: "job-2",
        title: "Tailor CareFlow resume and cover letter",
        priority: "HIGH",
        dueAt: new Date("2026-05-20")
      },
      {
        userId,
        title: "Add STAR story for customer onboarding improvement",
        priority: "MEDIUM",
        dueAt: new Date("2026-05-21")
      }
    ]
  });
}

main()
  .then(async () => {
    console.log("Seeded JobMatch CRM demo data.");
    await prismaForCleanup?.$disconnect();
  })
  .catch(async (error: unknown) => {
    if (error instanceof DatabaseTargetSafetyError) {
      console.error(`[local-seed] safety check failed: ${error.message}`);
    } else {
      console.error("[local-seed] Local database verification or seed execution failed.");
    }
    await prismaForCleanup?.$disconnect().catch(() => undefined);
    process.exit(1);
  });
