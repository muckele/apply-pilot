import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Document,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  TextRun
} from "docx";

import { fullSizeSyntheticResumeText } from "./resume-estimator-boundary-data";

const directory = dirname(fileURLToPath(import.meta.url));
const output = join(directory, "synthetic-resume-estimator-boundary.docx");
const sectionHeadings = new Set([
  "PROFESSIONAL SUMMARY",
  "CORE SKILLS",
  "PROFESSIONAL EXPERIENCE",
  "SELECTED TECHNICAL PROJECTS",
  "EDUCATION",
  "CERTIFICATIONS",
  "ACHIEVEMENTS",
  "ADDITIONAL INFORMATION"
]);
const recordHeading = /^(?:Director|Senior|Operations Analytics|Customer Experience|Business Process|Service Reliability|Planning Evidence|Certified Service)/;

const textRuns = (lines: string[]) => lines.flatMap((line, index) => [new TextRun({
  text: line,
  break: index === 0 ? undefined : 1,
  font: "Arial",
  size: 21
})]);

const blocks = fullSizeSyntheticResumeText.split("\n\n");
const paragraphs: Paragraph[] = [];
for (let index = 0; index < blocks.length; index += 1) {
  const text = blocks[index]!;
  const lines = text.split("\n");
  const bulletStart = lines.findIndex((line) => line.startsWith("• "));
  const next = blocks[index + 1];
  if (text.startsWith("Graduate Certificate") && next?.startsWith("Bachelor of Arts")) {
    paragraphs.push(new Paragraph({
      spacing: { before: 0, after: 0, line: 240 },
      children: [
        ...textRuns(lines),
        new PageBreak(),
        ...textRuns(next.split("\n"))
      ]
    }));
    index += 1;
    continue;
  }
  if (bulletStart >= 0) {
    paragraphs.push(new Paragraph({
      spacing: { before: 0, after: 0, line: 240 },
      children: textRuns(lines.slice(0, bulletStart))
    }));
    for (const bulletLine of lines.slice(bulletStart)) {
      paragraphs.push(new Paragraph({
        text: bulletLine.slice(2),
        bullet: { level: 0 },
        spacing: { before: 0, after: 0, line: 240 }
      }));
    }
    continue;
  }
  const isSectionHeading = sectionHeadings.has(text);
  const isRecordHeading = recordHeading.test(text);
  paragraphs.push(new Paragraph({
    heading: isSectionHeading
      ? HeadingLevel.HEADING_1
      : isRecordHeading
        ? HeadingLevel.HEADING_2
        : undefined,
    style: text.startsWith("• ") ? "ListBullet" : undefined,
    spacing: { before: 0, after: 0, line: 240 },
    keepNext: isSectionHeading || isRecordHeading,
    children: textRuns(lines).map((run) => run)
  }));
}

const document = new Document({
  creator: "Apply Pilot Test Fixture",
  title: "Synthetic Resume Estimator Boundary",
  subject: "Privacy-safe full-size resume admission regression fixture",
  styles: {
    default: {
      document: { run: { font: "Arial", size: 21, color: "000000" } },
      heading1: { run: { font: "Arial", size: 20, bold: true, color: "000000" } },
      heading2: { run: { font: "Arial", size: 21, bold: true, color: "000000" } }
    }
  },
  sections: [{ children: paragraphs }]
});

async function main() {
  await writeFile(output, await Packer.toBuffer(document));
}

void main();
