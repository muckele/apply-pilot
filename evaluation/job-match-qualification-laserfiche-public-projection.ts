// One data-only public projection shared by the existing qualification guide
// and the local one-job UI fixture. It contains no applicant-private material.
export const LASERFICHE_SYNTHETIC_QUALIFICATION = Object.freeze({
  caseId: "laserfiche-presales-engineer-i",
  expectedJobProjectionHash: "52031f913656015dc6f2b790f2532f0e1f046e949b389e2d0c7c5ef49e2db3bc",
  expectedInputHash: "edbc88e878c1e847832cbcef3553128b21c6772563f8f1b3f16688c986a6cad0",
  job: Object.freeze({
    title: "Presales Engineer I",
    company: "Laserfiche",
    location: "Long Beach, United States & Remote States, United States",
    workArrangement: "Hybrid: Tuesday through Thursday in Long Beach; remote Monday and Friday",
    compensation: "$75,000–$85,000"
  }),
  requirementLabels: Object.freeze({
    "job.requirements[0]": "Bachelor’s degree, preferably in a STEM field or equivalent professional experience",
    "job.requirements[1]": "Strong problem-solving skills, with the ability to use knowledge, creativity, and methodical thinking to identify innovative solutions",
    "job.requirements[2]": "Ability to learn and understand technical concepts, such as software, networking, databases, etc.",
    "job.requirements[3]": "Excellent communication and presentation skills, including the ability to communicate with clarity and confidence on technical topics",
    "job.requirements[4]": "Ability to work independently and as part of a team",
    "job.requirements[5]": "Applicants must be authorized to work for Laserfiche in the United States on a full-time basis without the need for employer sponsorship."
  }),
  applicantEvidenceLabels: Object.freeze({
    "resume.education[0]": "Bachelor of Arts in Business Administration",
    "resume.projects[0]": "Synthetic evidence workspace",
    "resume.achievements[0]": "Reduced a synthetic onboarding workflow from five steps to three.",
    "resume.skills[0]": "TypeScript",
    "resume.skills[1]": "SQL",
    "resume.skills[3]": "Technical demonstrations",
    "resume.workHistory[0]": "Solutions Operations Lead at Example Systems"
  }),
  supported: Object.freeze({
    "job.requirements[0]": Object.freeze(["resume.education[0]"]),
    "job.requirements[1]": Object.freeze(["resume.projects[0]", "resume.achievements[0]"]),
    "job.requirements[2]": Object.freeze(["resume.skills[0]", "resume.skills[1]", "resume.workHistory[0]"]),
    "job.requirements[3]": Object.freeze(["resume.skills[3]", "resume.workHistory[0]"])
  }),
  rationales: Object.freeze({
    "job.requirements[0]": "The source résumé records a Bachelor of Arts; a STEM field is preferred rather than required.",
    "job.requirements[1]": "The synthetic project and workflow improvement are direct problem-solving evidence.",
    "job.requirements[2]": "The source résumé names TypeScript, SQL, and technical workflow delivery.",
    "job.requirements[3]": "The source résumé explicitly records technical demonstrations and customer discovery."
  }),
  mustHave: Object.freeze(["job.requirements[5]"]),
  questions: Object.freeze([
    Object.freeze({
      id: "independent-and-team-work",
      title: "Independent and team delivery",
      question: "Can you provide a concrete example of working independently and as part of a team?",
      whyItMatters: "The source résumé does not explicitly establish both parts of this requirement.",
      jobRefs: Object.freeze(["job.requirements[4]"])
    }),
    Object.freeze({
      id: "work-authorization",
      title: "Work authorization",
      question: "Are you authorized to work full-time in the United States without employer sponsorship for this role?",
      whyItMatters: "The posting states this as a must-have condition.",
      jobRefs: Object.freeze(["job.requirements[5]"])
    })
  ])
});
