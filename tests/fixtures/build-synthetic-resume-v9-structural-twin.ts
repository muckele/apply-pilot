import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

import {
  resumeV9OwnerTopologyTwinText,
  resumeV9StructuralTwinText
} from "@/tests/fixtures/resume-v9-structural-twin-data";

const directory = dirname(fileURLToPath(import.meta.url));
const outputs = [
  {
    filename: "synthetic-resume-v9-structural-twin.docx",
    text: resumeV9StructuralTwinText,
    title: "Private-Free Resume V9 Structural Twin",
    subject: "Synthetic complete-document boundary authority fixture"
  },
  {
    filename: "synthetic-resume-v9-owner-topology-twin.docx",
    text: resumeV9OwnerTopologyTwinText,
    title: "Private-Free Resume V9 Owner-Topology Twin",
    subject: "Synthetic owner-topology boundary authority fixture"
  }
];
const headings = new Set([
  "SUMMARY",
  "SKILLS",
  "EXPERIENCE",
  "PROJECTS",
  "EDUCATION",
  "CERTIFICATIONS",
  "ACHIEVEMENTS",
  "ADDITIONAL INFORMATION"
]);

function paragraph(block: string) {
  const lines = block.split("\n");
  const heading = lines.length === 1 && headings.has(block);
  const centered = !heading && lines.every((text) =>
    text === "Casey Structure" ||
    text === "Operations Systems and Customer Delivery Leader" ||
    text.includes("example.test") ||
    text.includes("linkedin.com"));
  return new Paragraph({
    alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
    heading: heading ? HeadingLevel.HEADING_1 : undefined,
    spacing: { before: heading ? 120 : 0, after: heading ? 40 : 0, line: 240 },
    keepNext: heading,
    children: lines.map((text, index) => new TextRun({
      text,
      break: index === 0 ? 0 : 1,
      bold: heading || text === "Casey Structure" || text.includes(" | "),
      font: "Arial",
      size: heading ? 20 : 21
    }))
  });
}

function fixtureDocument(title: string, subject: string, text: string) {
  return new Document({
    creator: "Apply Pilot Test Fixture",
    title,
    subject,
    styles: {
      default: {
        document: { run: { font: "Arial", size: 21, color: "000000" } },
        heading1: { run: { font: "Arial", size: 20, bold: true, color: "000000" } }
      }
    },
    sections: [{
      properties: {
        page: { margin: { top: 792, right: 1008, bottom: 792, left: 1008 } }
      },
      children: text.split("\n\n").map(paragraph)
    }]
  });
}

async function main() {
  await Promise.all(outputs.map(async ({ filename, text, title, subject }) =>
    writeFile(
      join(directory, filename),
      await Packer.toBuffer(fixtureDocument(title, subject, text))
    )
  ));
}

void main();
