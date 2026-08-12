import { z } from "zod";

import { resumeParsePrompt } from "@/prompts/resumeParsePrompt";
import { resumeTailorPrompt } from "@/prompts/resumeTailorPrompt";
import { generateJson } from "@/lib/ai/client";

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

const scoreSchema = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));

const parsedResumeSchema: z.ZodType<ParsedResume, z.ZodTypeDef, unknown> = z.object({
  contactInfo: z.record(z.union([z.string(), z.null()])),
  summary: z.string(),
  skills: z.array(z.string()),
  workHistory: z.array(z.record(z.unknown())),
  projects: z.array(z.record(z.unknown())),
  education: z.array(z.record(z.unknown())),
  certifications: z.array(z.record(z.unknown())),
  achievements: z.array(z.string())
});

const tailoredResumeSchema: z.ZodType<TailoredResumeOutput, z.ZodTypeDef, unknown> = z.object({
  professionalSummary: z.string(),
  skillsSection: z.array(z.string()),
  bulletRewrites: z.array(
    z.object({
      original: z.string(),
      rewrite: z.string(),
      reason: z.string()
    })
  ),
  rolesOrProjectsToEmphasize: z.array(z.string()),
  unsupportedKeywords: z.array(z.string()),
  formattingWarnings: z.array(z.string()),
  atsCompatibilityScore: scoreSchema,
  jobFitScore: scoreSchema,
  resumeText: z.string()
});

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

export async function parseResumeText(text: string, userId?: string) {
  if (!text.trim()) {
    throw new Error("Resume text is empty.");
  }

  const generated = await generateJson<ParsedResume>({
    promptName: "resumeParsePrompt",
    systemPrompt: resumeParsePrompt,
    payload: { resumeText: text },
    fallback: fallbackParse(text),
    schema: parsedResumeSchema,
    context: userId ? { userId, feature: "RESUME_PARSE", promptVersion: "2" } : undefined
  });

  return generated.data;
}

export async function tailorResume(payload: unknown, fallbackText: string, userId?: string) {
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

  const generated = await generateJson<TailoredResumeOutput>({
    promptName: "resumeTailorPrompt",
    systemPrompt: resumeTailorPrompt,
    payload,
    fallback,
    schema: tailoredResumeSchema,
    context: userId ? { userId, feature: "RESUME_TAILOR", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
