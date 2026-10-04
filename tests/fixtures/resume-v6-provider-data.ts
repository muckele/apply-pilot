import assert from "node:assert/strict";

import {
  buildResumeSourceCatalog,
  type ResumeSourceCatalog,
  type ResumeSourceSectionName
} from "@/lib/ai/resume-source-catalog";
import type {
  ParsedResumeV5,
  ResumeParseProviderV6,
  ResumeParseRecordSpanV6
} from "@/lib/ai/resume";

const structuralSections = new Set<ResumeSourceSectionName>([
  "workHistory",
  "projects",
  "education",
  "certifications"
]);

function spanForBlock(
  catalog: ResumeSourceCatalog,
  sectionIndex: number,
  block: string
): ResumeParseRecordSpanV6 {
  const section = catalog.sections[sectionIndex]!;
  const relativeStart = section.sourceText.indexOf(block);
  assert.notEqual(relativeStart, -1);
  const startOffset = section.startOffset + relativeStart;
  const endOffset = startOffset + block.length;
  const startLine = section.lines.find((line) => line.startOffset === startOffset);
  const endLine = section.lines.find((line) => line.endOffset === endOffset);
  assert.ok(startLine);
  assert.ok(endLine);
  return {
    sectionId: section.id,
    startLineId: startLine.id,
    endLineId: endLine.id
  };
}

export function providerV6FromCanonical(
  rawSource: string,
  parsed: ParsedResumeV5
): ResumeParseProviderV6 {
  const catalog = buildResumeSourceCatalog(rawSource);
  const recordSpans: ResumeParseRecordSpanV6[] = [];
  const spanIndices = new Map<ResumeSourceSectionName, number[]>();

  parsed.sourceSections.forEach((section, sectionIndex) => {
    if (!structuralSections.has(section.section)) return;
    for (const block of section.recordBlocks) {
      const index = recordSpans.length;
      recordSpans.push(spanForBlock(catalog, sectionIndex, block));
      const indices = spanIndices.get(section.section) ?? [];
      indices.push(index);
      spanIndices.set(section.section, indices);
    }
  });

  const indicesFor = (section: ResumeSourceSectionName) => {
    const indices = spanIndices.get(section) ?? [];
    let cursor = 0;
    return () => indices[cursor++]!;
  };
  const workSpan = indicesFor("workHistory");
  const projectSpan = indicesFor("projects");
  const educationSpan = indicesFor("education");
  const certificationSpan = indicesFor("certifications");
  const withoutSourceText = <T extends { sourceText: string }>(record: T) => {
    const projection: Partial<T> = { ...record };
    delete projection.sourceText;
    return projection as Omit<T, "sourceText">;
  };

  return {
    contractVersion: "6",
    recordSpans,
    contactInfo: {
      name: parsed.contactInfo.name,
      headline: parsed.contactInfo.headline,
      email: parsed.contactInfo.email,
      phone: parsed.contactInfo.phone,
      location: parsed.contactInfo.location,
      linkedin: parsed.contactInfo.linkedin,
      github: parsed.contactInfo.github,
      portfolio: parsed.contactInfo.portfolio
    },
    summary: parsed.summary,
    skills: parsed.skills,
    workHistory: parsed.workHistory.map((item) => ({ spanIndex: workSpan(), ...withoutSourceText(item) })),
    projects: parsed.projects.map((item) => ({ spanIndex: projectSpan(), ...withoutSourceText(item) })),
    education: parsed.education.map((item) => ({ spanIndex: educationSpan(), ...withoutSourceText(item) })),
    certifications: parsed.certifications.map((item) => ({
      spanIndex: certificationSpan(),
      ...withoutSourceText(item)
    })),
    achievements: parsed.achievements,
    sectionStatus: parsed.sectionStatus,
    warnings: parsed.warnings
  };
}
