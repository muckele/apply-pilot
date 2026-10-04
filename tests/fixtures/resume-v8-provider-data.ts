import type { ParsedResumeV5, ResumeParseProviderV8 } from "@/lib/ai/resume";
import { providerV7FromCanonical } from "@/tests/fixtures/resume-v7-provider-data";

export function providerV8FromCanonical(
  rawSource: string,
  parsed: ParsedResumeV5
): ResumeParseProviderV8 {
  const semantic = providerV7FromCanonical(rawSource, parsed);
  return {
    contractVersion: "8",
    contactInfo: semantic.contactInfo,
    skills: semantic.skills,
    workHistory: semantic.workHistory,
    projects: semantic.projects,
    education: semantic.education,
    certifications: semantic.certifications,
    warnings: semantic.warnings
  };
}
