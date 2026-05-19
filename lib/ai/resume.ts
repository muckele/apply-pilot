import { resumeTailorPrompt } from "@/prompts/resumeTailorPrompt";
import { generateJson, getOpenAIModel } from "@/lib/ai/client";

export type ParsedResume = {
  contactInfo: Record<string, string | null>;
  summary: string;
  skills: string[];
  workHistory: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  education: Array<Record<string, unknown>>;
  certifications: Array<Record<string, unknown>>;
  achievements: string[];
};

export type TailoredResumeOutput = {
  professionalSummary: string;
  skillsSection: string[];
  bulletRewrites: Array<{ original: string; rewrite: string; reason: string }>;
  rolesOrProjectsToEmphasize: string[];
  unsupportedKeywords: string[];
  formattingWarnings: string[];
  atsCompatibilityScore: number;
  jobFitScore: number;
  resumeText: string;
};

function fallbackParse(text: string): ParsedResume {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const phone = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] ?? null;
  const skillTerms = [
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
    "HTML",
    "CSS",
    "Sales",
    "Operations",
    "Recruiting",
    "Scheduling",
    "Compliance"
  ];
  const skills = skillTerms.filter((skill) =>
    text.toLowerCase().includes(skill.toLowerCase().replace(".", ""))
  );
  const achievements = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /%|\$|\d+x|\d+\+|increased|reduced|managed|led|built|implemented/i.test(line))
    .slice(0, 12);

  return {
    contactInfo: { email, phone },
    summary: text.split(/\n+/).find((line) => line.trim().length > 80)?.trim() ?? "",
    skills,
    workHistory: [],
    projects: [],
    education: [],
    certifications: [],
    achievements
  };
}

export async function parseResumeText(text: string) {
  if (!text.trim()) {
    throw new Error("Resume text is empty.");
  }

  return fallbackParse(text);
}

export async function tailorResume(payload: unknown, fallbackText: string) {
  const fallback: TailoredResumeOutput = {
    professionalSummary:
      "Customer-facing technical professional with full-stack software engineering training and hands-on operations experience across scheduling, compliance, billing workflows, and stakeholder coordination.",
    skillsSection: [
      "JavaScript",
      "React",
      "Node.js",
      "Express",
      "Python",
      "SQL",
      "REST APIs",
      "Customer discovery",
      "Implementation support",
      "Operations leadership"
    ],
    bulletRewrites: [
      {
        original: "Supported business operations and customer-facing workflows.",
        rewrite:
          "Coordinated cross-functional operations across hiring, compliance, scheduling, billing workflows, and payer communication to improve service delivery and accountability.",
        reason: "Makes the operations scope concrete without inventing metrics."
      }
    ],
    rolesOrProjectsToEmphasize: [
      "General Assembly full-stack projects",
      "Golden Behavior Connection operations leadership",
      "Business development and customer-facing problem solving"
    ],
    unsupportedKeywords: [],
    formattingWarnings: [
      "Keep the exported resume single-column and avoid tables, graphics, text boxes, and decorative layouts."
    ],
    atsCompatibilityScore: 78,
    jobFitScore: 76,
    resumeText: fallbackText
  };

  return {
    ...(await generateJson<TailoredResumeOutput>({
      promptName: "resumeTailorPrompt",
      systemPrompt: resumeTailorPrompt,
      payload,
      fallback
    })),
    model: getOpenAIModel()
  };
}
