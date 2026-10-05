import type { QualificationCase } from "@/lib/ai/job-match-qualification";

// Public, source-backed evaluation inputs only. Applicant evidence and human
// evidence mappings remain private and are intentionally not stored here.
export const JOB_MATCH_QUALIFICATION_CASES = [
  {
    id: "laserfiche-presales-engineer-i",
    safeLabel: "Laserfiche — Presales Engineer I",
    expectedRecommendation: "apply now",
    expectedBand: "likely_fit_conditional",
    provenance: {
      sourceUrl: "https://jobs.laserfiche.com/Jobs/Details/o31BAfwZ",
      capturedAt: "2026-10-05T16:27:01.000Z",
      sourceBodySha256: "4053ec94b0ddef17e3751ce9e8f84275d694b46f9bd13c804a67ac989a07676",
      sourceEvidenceSha256: "cb113b6e65f4d79867fd22c33180af926afc03de6335eee7fde42e64e3105167",
      sourceEvidence: [
        "Hybrid: Three days per week (Tuesday, Wednesday and Thursday) in-office in Long Beach, CA.",
        "Salary range from $75,000.00 - $85,000.00",
        "Bachelor’s degree, preferably in a STEM field or equivalent professional experience",
        "Create and deliver overviews and proof-of-concept demonstrations for potential customers."
      ]
    },
    jobProjectionHash: "52031f913656015dc6f2b790f2532f0e1f046e949b389e2d0c7c5ef49e2db3bc",
    humanReview: {
      status: "pending_private_applicant_evidence_review",
      openGaps: [
        "Confirm degree or equivalent professional experience against the private projection.",
        "Confirm demos, proofs of concept, presentations, webinars, or teaching evidence.",
        "Confirm work authorization, travel flexibility, and three-day Long Beach attendance."
      ]
    },
    job: {
      title: "Presales Engineer I",
      company: "Laserfiche",
      location: "Long Beach, United States & Remote States, United States",
      remoteStatus: "Hybrid: Tuesday through Thursday in Long Beach; remote Monday and Friday",
      salaryMin: 75_000,
      salaryMax: 85_000,
      description: [
        "As a Presales Engineer, you'll become an expert in Laserfiche software, with knowledge of the product suite inside and out.",
        "You'll work with a wide range of people across customer demos, sales calls, webinars, and solution design for customers' business needs.",
        "Create and deliver overviews and proof-of-concept demonstrations for potential customers.",
        "Build solutions using Laserfiche software to solve customers’ business needs.",
        "Break down technical details into information that’s useful and tailored to the audience.",
        "Provide technical consulting to Solution Providers via email, conference calls, and presentations, and teach at Laserfiche’s annual conference."
      ].join("\n"),
      requirements: [
        "Bachelor’s degree, preferably in a STEM field or equivalent professional experience",
        "Strong problem-solving skills, with the ability to use knowledge, creativity, and methodical thinking to identify innovative solutions",
        "Ability to learn and understand technical concepts, such as software, networking, databases, etc.",
        "Excellent communication and presentation skills, including the ability to communicate with clarity and confidence on technical topics",
        "Ability to work independently and as part of a team",
        "Applicants must be authorized to work for Laserfiche in the United States on a full-time basis without the need for employer sponsorship."
      ],
      preferredQualifications: [],
      detectedTechStack: ["software", "networking", "databases", "proof-of-concept demonstrations"]
    }
  },
  {
    id: "sentry-solutions-engineer",
    safeLabel: "Sentry — Solutions Engineer",
    expectedRecommendation: "consider",
    expectedBand: "borderline",
    provenance: {
      sourceUrl: "https://sentry.io/careers/9889cf59-cd32-4aff-bff7-645bb1be4e14/",
      capturedAt: "2026-10-05T16:27:01.000Z",
      sourceBodySha256: "fb3f064b73356288eb81414f315e05dd3f5844f529a2e014a104099b7c193436",
      sourceEvidenceSha256: "518e1f36cacc4e6d7f5c4641aab0071f052a11b0ff22ae3b06e320a8c1e27de7",
      sourceEvidence: [
        "Location Type Hybrid",
        "San Francisco, California",
        "3+ years as a Solutions Engineer (preferred), Implementation Consultant, Support Engineer, or Software Developer with experience leading projects and/or working with customers.",
        "Hands-on experience working with programming languages and frameworks including JavaScript, Python, Node.js, Java, PHP, .NET, Ruby, React, React Native, Mobile Native (iOS and/or Android), etc."
      ]
    },
    jobProjectionHash: "ea8651b522a6ff3f6201e2260ab77e6189b62c031b23546c4daf1e155109915f",
    humanReview: {
      status: "pending_private_applicant_evidence_review",
      openGaps: [
        "Confirm years of relevant Solutions Engineering, implementation, support, or development work.",
        "Confirm project leadership and customer workshop evidence.",
        "Confirm monitoring, observability, SDK, alerts, and San Francisco hybrid evidence or constraints."
      ]
    },
    job: {
      title: "Solutions Engineer",
      company: "Sentry",
      location: "San Francisco, California",
      remoteStatus: "Hybrid",
      salaryMin: 140_000,
      salaryMax: 190_000,
      description: [
        "Help customers embed Sentry into applications and workflows, from SDK integration through alerts and issue routing.",
        "Translate customer pain points and objectives into implementation and onboarding plans that demonstrate business value.",
        "Develop best practices, educational offerings, and content around error and performance management, open source, or Sentry.",
        "Act as a trusted advisor for software engineering and monitoring practices, provide workshop-level customer interaction, and work cross-functionally with product and development teams."
      ].join("\n"),
      requirements: [
        "3+ years as a Solutions Engineer (preferred), Implementation Consultant, Support Engineer, or Software Developer with experience leading projects and/or working with customers.",
        "Hands-on experience working with programming languages and frameworks including JavaScript, Python, Node.js, Java, PHP, .NET, Ruby, React, React Native, Mobile Native (iOS and/or Android), etc.",
        "Possess excellent communication and presentation skills.",
        "Problem solver, knowledgable, and can-doer"
      ],
      preferredQualifications: [
        "Experience with developer tools, open-source, and/or the software development life cycle.",
        "Experience developing solutions, resources, and content from scratch, including scripts, code samples, demos, and sales-consumable collateral."
      ],
      detectedTechStack: [
        "Sentry", "SDK", "JavaScript", "Python", "Node.js", "Java", "PHP", ".NET", "Ruby", "React",
        "React Native", "iOS", "Android", "application monitoring", "open-source"
      ]
    }
  },
  {
    id: "flint-customer-success-engineer",
    safeLabel: "Flint — Customer Success Engineer",
    expectedRecommendation: "consider",
    expectedBand: "borderline",
    provenance: {
      sourceUrl: "https://flintk12.com/careers/customer-success-engineer",
      capturedAt: "2026-10-05T16:34:26.000Z",
      sourceBodySha256: "b33c19505f593873a1626d55ea93acb05ad1afcd3cb44c67c800305755fa6ad1",
      sourceEvidenceSha256: "d99f275f9ce88fc0b105aa9b9973af4fc6425d3b833db2e4a0b2283c4342be78",
      sourceEvidence: [
        "Compensation: $100k–$140k base + meaningful equity",
        "You have ~1–3 years of experience in Customer Success, Support, Ops, or a similar customer-facing, systems-adjacent role",
        "Own inbound customer communication and manage a portfolio of school accounts for adoption and renewals.",
        "Run virtual and sometimes onsite professional-development sessions for teachers."
      ]
    },
    jobProjectionHash: "fd86863498043f64aee0ff9357a0607dc04c8ea0d65b439433cc446e454874e1",
    humanReview: {
      status: "pending_private_applicant_evidence_review",
      openGaps: [
        "Confirm one to three years of relevant customer-facing operations or customer-success experience.",
        "Confirm account portfolio, renewals, retention, adoption, expansion, training, or content evidence.",
        "Confirm AI-tool, education/EdTech, startup, New York City, and onsite-school-session evidence or constraints."
      ]
    },
    job: {
      title: "Customer Success Engineer",
      company: "Flint",
      location: "New York City",
      remoteStatus: "Not stated; includes sometimes-onsite professional-development sessions",
      salaryMin: 100_000,
      salaryMax: 140_000,
      description: [
        "Own customer outcomes and improve systems that make those outcomes repeatable as the second member of Flint's Customer Success team.",
        "Own inbound customer communication and manage a portfolio of school accounts for adoption and renewals.",
        "Create and improve product updates, help-center content, and teacher professional-development materials.",
        "Use AI tools and lightweight internal systems to improve customer work and run virtual and sometimes onsite professional-development sessions for teachers."
      ].join("\n"),
      requirements: [
        "You have ~1–3 years of experience in Customer Success, Support, Ops, or a similar customer-facing, systems-adjacent role",
        "You care about outcomes, not just activity—retention, adoption, and customer impact actually matter to you"
      ],
      preferredQualifications: [
        "Experience in education, including teaching, or EdTech",
        "Startup experience"
      ],
      detectedTechStack: ["AI tools", "automation", "lightweight internal systems"]
    }
  },
  {
    id: "roku-technical-account-manager-10909",
    safeLabel: "Roku — Technical Account Manager (10909)",
    expectedRecommendation: "skip",
    expectedBand: "clear_gap",
    provenance: {
      sourceUrl: "https://www.weareroku.com/jobs/technical-account-manager-santa-monica-california-united-states",
      capturedAt: "2026-10-05T16:27:01.000Z",
      sourceBodySha256: "9610e263104d6ad43c9b448f180b0386669180c8cbdb6ef4a37b555fc3972abf",
      sourceEvidenceSha256: "6ba06b1b57486708bf4a9122de217382c75d240fc2dbe198255f67152c74765c",
      sourceEvidence: [
        "$130,000 - $160,000",
        "4+ years of client-facing experience in Programmatic Advertising/Header Bidding Technologies in a Technical Account Management role or equivalent",
        "1+ year Video (preferably CTV) experience",
        "Experience with Ad tech and ad tech terminology"
      ]
    },
    jobProjectionHash: "6b0bca5bc8bdd182022ede402fd8aa0679684c3b0a3bcd2862d8a8884147e493",
    humanReview: {
      status: "pending_private_applicant_evidence_review",
      openGaps: [
        "Confirm whether any private evidence supports programmatic advertising, header bidding, CTV, video-ad formats, or ad tech.",
        "Confirm supply integration, app/SDK, Postman, ad-server, OTT, log-reading, or network-troubleshooting evidence.",
        "Confirm Monday-through-Thursday Santa Monica office availability."
      ]
    },
    job: {
      title: "Technical Account Manager",
      company: "Roku",
      location: "Santa Monica, California, United States",
      remoteStatus: "Hybrid: generally in office Monday through Thursday; Friday generally flexible",
      salaryMin: 130_000,
      salaryMax: 160_000,
      description: [
        "Manage technical relationships with advertising publisher partners and own integration health from onboarding through mature operations.",
        "Lead integration project planning, operational work, and testing; use data and logs to drive decisions and optimization.",
        "Troubleshoot publisher integrations, build partner relationships, collaborate with product, and meet locally with publisher contacts when required."
      ].join("\n"),
      requirements: [
        "4+ years of client-facing experience in Programmatic Advertising/Header Bidding Technologies in a Technical Account Management role or equivalent",
        "AI tool proficiency to optimize, execute, and strategize on workflows",
        "Ability to communicate clearly, concisely, and effectively, both verbally and in writing, to different audiences such as product, developers, operations, and sales",
        "1+ year Video (preferably CTV) experience",
        "Comprehension and experience in trafficking digital video and other formats, including VAST, VPAID, and VMAP",
        "Experience with Ad tech and ad tech terminology",
        "Effective relationship management skills with partners",
        "Experience with SQL & Analytics Skills",
        "Experience with supply integrations (header bidding, oRTB, etc.)",
        "Familiarity with reviewing technical documentation and integration specs, such as for oRTB",
        "Superset and Excel proficiency. Python, JSON/XML are a strong plus",
        "Experience in app/SDK coding, log reading, and testing in Postman",
        "Experience in diagnosing and troubleshooting front-end issues and network requests",
        "Experience with a video ad server (Freewheel, GAM, Publica, Springserve, etc.)"
      ],
      preferredQualifications: ["Experience on an OTT platform a strong plus"],
      detectedTechStack: [
        "Programmatic Advertising", "Header Bidding", "CTV", "VAST", "VPAID", "VMAP", "SQL", "Superset",
        "Excel", "Python", "JSON", "XML", "SDK", "Postman", "oRTB", "Freewheel", "GAM", "Publica",
        "Springserve", "OTT"
      ]
    }
  }
] satisfies QualificationCase[];
