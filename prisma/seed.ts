import { PrismaClient } from "@prisma/client";

import { normalizeText, normalizeUrl } from "../lib/normalize";

const prisma = new PrismaClient();

const userId = process.env.DEFAULT_DEMO_USER_ID ?? "demo-user";

async function main() {
  await prisma.user.deleteMany({ where: { id: userId } });

  await prisma.user.create({
    data: {
      id: userId,
      name: "Mathew Uckele",
      email: "mathew@example.com",
      profile: {
        create: {
          location: "Fontana / Los Angeles area, CA",
          careerGoals:
            "Find high-fit customer-facing technical roles that combine full-stack software training, SaaS operations, implementation, technical account work, and sales engineering.",
          preferredRoles: [
            "Sales Engineer",
            "Solutions Engineer",
            "Technical Account Manager",
            "Customer Success Engineer",
            "Implementation Specialist",
            "Full-Stack Developer",
            "Junior Software Engineer",
            "Operations / SaaS operations"
          ],
          preferredLocations: ["Los Angeles, CA", "Fontana, CA", "Remote", "Hybrid"],
          remotePreference: "FLEXIBLE",
          salaryTargetMin: 75000,
          salaryTargetMax: 130000,
          industriesOfInterest: ["SaaS", "Health tech", "Developer tools", "Operations"],
          dealBreakers: ["Commission-only roles", "Unauthorized automation expectations"],
          skillsToEmphasize: [
            "JavaScript",
            "React",
            "Node.js",
            "Express",
            "Python",
            "SQL",
            "MongoDB",
            "PostgreSQL",
            "Django",
            "REST APIs",
            "AWS",
            "Customer discovery",
            "Operations leadership",
            "Scheduling",
            "Compliance",
            "Billing workflows"
          ],
          skillsNotToExaggerate: [
            "Enterprise-scale production ownership",
            "Deep DevOps ownership",
            "Tools only listed in a job posting but not supported by experience"
          ],
          workAuthorizationNotes: "Add work authorization details before applying.",
          availabilityNotes: "Available for Los Angeles hybrid or remote roles.",
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
        "Mathew Uckele is a customer-facing technical professional with full-stack software engineering training from General Assembly and experience across business development, operations, recruiting, scheduling, compliance, billing workflows, payer coordination, and small-business leadership. Skills include JavaScript, React, Node.js, Express, Python, SQL, MongoDB, PostgreSQL, Django, REST APIs, AWS, HTML, and CSS.",
      contactInfo: { name: "Mathew Uckele", location: "Fontana / Los Angeles area, CA" },
      summary:
        "Customer-facing technical professional combining full-stack software engineering training with sales, operations, and implementation-oriented experience.",
      skills: [
        "JavaScript",
        "React",
        "Node.js",
        "Express",
        "Python",
        "SQL",
        "MongoDB",
        "PostgreSQL",
        "Django",
        "REST APIs",
        "AWS",
        "Customer discovery",
        "Operations leadership"
      ],
      workHistory: [
        {
          company: "Golden Behavior Connection",
          role: "Operations leadership",
          highlights: [
            "Supported hiring, compliance, scheduling, billing workflows, payer coordination, and service operations."
          ]
        }
      ],
      projects: [
        {
          name: "General Assembly full-stack projects",
          technologies: ["React", "Node.js", "Express", "MongoDB", "SQL"]
        }
      ],
      education: [{ school: "General Assembly", program: "Full-stack software engineering training" }],
      certifications: [],
      achievements: [
        "Coordinated hiring, compliance, scheduling, billing workflows, and payer communication across operational workflows."
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
          "Strong overlap with customer-facing technical work, implementation, operations, and software fundamentals.",
        matchRecommendation: job.score >= 80 ? "apply now" : "consider",
        missingKeywords: job.preferredQualifications,
        supportedKeywords: job.detectedTechStack,
        suggestedResumeAngle:
          "Lead with customer-facing technical problem solving, full-stack training, and operations ownership.",
        suggestedCoverLetterAngle:
          "Connect software training with sales, implementation, and operations credibility.",
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
        "Customer-facing technical professional with full-stack training and experience translating operational requirements into reliable workflows.",
      skills: ["React", "REST APIs", "Implementation", "Customer discovery", "Operations leadership"],
      bullets: [
        {
          rewrite:
            "Coordinated hiring, compliance, scheduling, billing workflows, and payer communication to improve operational accountability."
        }
      ],
      fullText:
        "Mathew Uckele\n\nCustomer-facing technical professional with full-stack training and operations leadership experience...",
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
        "Prepare to connect sales engineering, technical discovery, full-stack training, and operational workflow ownership.",
      likelyQuestions: [
        "Tell me about your transition into technical roles.",
        "How do you explain APIs to non-technical customers?",
        "Describe a time you improved an operational workflow."
      ],
      starStories: [
        {
          theme: "Operations workflow",
          action: "Coordinated hiring, compliance, scheduling, billing workflows, and payer communication."
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
        title: "Add STAR story for operations workflow improvement",
        priority: "MEDIUM",
        dueAt: new Date("2026-05-21")
      }
    ]
  });
}

main()
  .then(async () => {
    console.log("Seeded JobMatch CRM demo data.");
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
