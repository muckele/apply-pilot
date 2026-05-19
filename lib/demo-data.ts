export const demoProfile = {
  name: "Mathew Uckele",
  location: "Fontana / Los Angeles area, CA",
  targetRoles: [
    "Sales Engineer",
    "Solutions Engineer",
    "Technical Account Manager",
    "Customer Success Engineer",
    "Implementation Specialist",
    "Full-Stack Developer",
    "Junior Software Engineer",
    "Operations / SaaS operations"
  ],
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
    "Scheduling",
    "Compliance",
    "Billing workflows"
  ]
};

export const demoJobs = [
  {
    id: "job-1",
    title: "Solutions Engineer, SMB",
    company: "Northstar SaaS",
    location: "Los Angeles, CA",
    remoteStatus: "Hybrid",
    salary: "$95k - $125k",
    datePosted: "2026-05-16",
    fitScore: 88,
    status: "ACTIVE",
    recommendation: "Apply now",
    sourceType: "GREENHOUSE",
    keyReason:
      "Strong overlap with customer-facing technical discovery, implementation support, JavaScript, REST APIs, and sales background.",
    missingKeywords: ["Salesforce administration", "SOC 2"],
    supportedKeywords: ["React", "REST APIs", "Sales", "Implementation", "Operations"],
    description:
      "Partner with sales and customer success to scope technical requirements, deliver product demos, support API evaluations, and guide SMB customers through implementation.",
    concerns: ["Confirm depth expected for Salesforce administration before emphasizing it."],
    suggestedResumeAngle:
      "Lead with technical discovery, full-stack training, and operations leadership that required translating requirements into reliable workflows.",
    suggestedCoverLetterAngle:
      "Connect business development credibility with practical software and implementation experience."
  },
  {
    id: "job-2",
    title: "Implementation Specialist",
    company: "CareFlow Systems",
    location: "Remote, US",
    remoteStatus: "Remote",
    salary: "$78k - $98k",
    datePosted: "2026-05-18",
    fitScore: 84,
    status: "ACTIVE",
    recommendation: "Apply now",
    sourceType: "LEVER",
    keyReason:
      "Healthcare operations, scheduling, payer coordination, and customer-facing workflow experience map directly to implementation work.",
    missingKeywords: ["HL7", "EHR integrations"],
    supportedKeywords: ["Operations", "Scheduling", "Billing workflows", "Customer Success", "SQL"],
    description:
      "Own customer onboarding, workflow configuration, stakeholder training, and post-launch support for healthcare operations teams.",
    concerns: ["Be transparent if HL7 or EHR integration experience is not hands-on."],
    suggestedResumeAngle:
      "Emphasize Golden Behavior Connection operations, payer coordination, and technical training.",
    suggestedCoverLetterAngle:
      "Frame Mathew as an operator who can learn systems quickly and communicate clearly with healthcare stakeholders."
  },
  {
    id: "job-3",
    title: "Junior Full-Stack Developer",
    company: "Civic Tools Lab",
    location: "Pasadena, CA",
    remoteStatus: "On-site",
    salary: "$72k - $90k",
    datePosted: "2026-05-14",
    fitScore: 72,
    status: "INTERESTED",
    recommendation: "Consider",
    sourceType: "ASHBY",
    keyReason:
      "Good JavaScript, React, Node, and SQL alignment, with lower confidence around production engineering depth.",
    missingKeywords: ["CI/CD", "unit testing at scale", "Docker"],
    supportedKeywords: ["JavaScript", "React", "Node.js", "SQL", "REST APIs"],
    description:
      "Build civic workflow tools with React, Node.js, PostgreSQL, REST APIs, and collaborative product development.",
    concerns: ["Prepare project walkthroughs and be precise about training versus professional engineering experience."],
    suggestedResumeAngle:
      "Show full-stack project work and operations context that explains product judgment.",
    suggestedCoverLetterAngle:
      "Pair software fundamentals with real-world workflow ownership."
  }
];

export const demoApplications = [
  {
    id: "app-1",
    jobId: "job-1",
    company: "Northstar SaaS",
    title: "Solutions Engineer, SMB",
    status: "Applied",
    dateApplied: "2026-05-17",
    nextAction: "Follow up with recruiter",
    followUpDue: "2026-05-22",
    score: 88
  },
  {
    id: "app-2",
    jobId: "job-2",
    company: "CareFlow Systems",
    title: "Implementation Specialist",
    status: "Saved",
    dateApplied: "",
    nextAction: "Generate tailored resume",
    followUpDue: "2026-05-20",
    score: 84
  },
  {
    id: "app-3",
    jobId: "job-3",
    company: "Civic Tools Lab",
    title: "Junior Full-Stack Developer",
    status: "Interested",
    dateApplied: "",
    nextAction: "Review missing keywords",
    followUpDue: "2026-05-21",
    score: 72
  }
];

export const demoInterviews = [
  {
    id: "int-1",
    company: "Northstar SaaS",
    title: "Solutions Engineer, SMB",
    type: "Recruiter",
    scheduledAt: "2026-05-23 10:00 AM",
    prepStatus: "Prep brief ready",
    interviewers: ["Alex Rivera"]
  }
];

export const demoTasks = [
  {
    id: "task-1",
    title: "Review Northstar SaaS follow-up draft",
    due: "2026-05-22",
    priority: "High",
    status: "Open"
  },
  {
    id: "task-2",
    title: "Tailor CareFlow resume and cover letter",
    due: "2026-05-20",
    priority: "High",
    status: "Open"
  },
  {
    id: "task-3",
    title: "Add STAR story for operations workflow improvement",
    due: "2026-05-21",
    priority: "Medium",
    status: "Open"
  }
];

export const weeklyMetrics = {
  saved: 12,
  applied: 6,
  interviews: 1,
  followUpsDue: 4,
  resumeVersions: 5,
  averageFitScore: 81
};
