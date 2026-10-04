import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Document,
  HeadingLevel,
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

const paragraphs = fullSizeSyntheticResumeText.split("\n").map((text) => {
  const isSectionHeading = sectionHeadings.has(text);
  const isRecordHeading = recordHeading.test(text);
  return new Paragraph({
    heading: isSectionHeading
      ? HeadingLevel.HEADING_1
      : isRecordHeading
        ? HeadingLevel.HEADING_2
        : undefined,
    style: text.startsWith("• ") ? "ListBullet" : undefined,
    spacing: { before: 0, after: 0, line: 240 },
    keepNext: isSectionHeading || isRecordHeading,
    children: text ? [new TextRun({
      text,
      bold: isSectionHeading || isRecordHeading,
      font: "Arial",
      size: isSectionHeading ? 20 : 21
    })] : []
  });
});

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
