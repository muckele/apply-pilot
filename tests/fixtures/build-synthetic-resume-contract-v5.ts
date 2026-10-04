import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";

const directory = dirname(fileURLToPath(import.meta.url));
const output = join(directory, "synthetic-resume-contract-v5.docx");

function line(text: string, options: { bold?: boolean; center?: boolean; heading?: boolean } = {}) {
  return new Paragraph({
    alignment: options.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    heading: options.heading ? HeadingLevel.HEADING_1 : undefined,
    spacing: { before: options.heading ? 120 : 0, after: options.heading ? 40 : 0, line: 240 },
    keepNext: options.heading,
    children: [new TextRun({ text, bold: options.bold || options.heading, font: "Arial", size: options.heading ? 20 : 21 })]
  });
}

function blank() {
  return new Paragraph({ spacing: { after: 0 }, children: [] });
}

const paragraphs = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    style: "Title",
    spacing: { after: 20 },
    children: [new TextRun({ text: "Jordan Example", bold: true, font: "Arial", size: 34, color: "000000" })]
  }),
  line("Systems Operations Analyst", { bold: true, center: true }),
  line("Riverton, CA | (555) 010-1000 | jordan@example.test", { center: true }),
  line("https://portfolio.example.test/jordan | https://www.linkedin.com/in/jordan-example | https://github.com/jordan-example", { center: true }),
  blank(),
  line("SUMMARY", { heading: true }),
  line("Systems operations analyst who builds reliable workflows and explains technical changes clearly. Experienced in customer operations, data quality, and cross-functional delivery."),
  blank(),
  line("SKILLS", { heading: true }),
  line("Data: SQL, Excel, reporting"),
  line("Delivery: Agile, stakeholder communication"),
  line("Platforms: TypeScript, PostgreSQL, Azure"),
  blank(),
  line("EXPERIENCE", { heading: true }),
  line("Operations Analyst", { bold: true }),
  line("Northwind Services"),
  line("Location: Toronto, Canada"),
  line("Jan 2022 - Present"),
  line("• Built TypeScript workflow checks with PostgreSQL and Azure."),
  line("• Improved monthly reporting accuracy by 18%."),
  blank(),
  line("Customer Support Specialist", { bold: true }),
  line("Contoso Labs"),
  line("Remote"),
  line("Jun 2019 - Dec 2021"),
  line("• Resolved technical onboarding issues for enterprise customers."),
  line("• Documented support patterns for product and engineering teams."),
  blank(),
  line("PROJECTS", { heading: true }),
  line("Apply Pilot | Truthful Application Workflow | 2026", { bold: true }),
  line("Technologies: TypeScript, PostgreSQL"),
  line("• Built a review-first application workflow with TypeScript and PostgreSQL."),
  blank(),
  line("Service Health Board | Reliability Reporting Dashboard | 2025", { bold: true }),
  line("Technologies: SQL, Azure"),
  line("• Created a dashboard that summarized service health trends."),
  blank(),
  line("EDUCATION", { heading: true }),
  line("Operations Analytics Certificate", { bold: true }),
  line("Synthetic Institute"),
  line("Jan 2021 - Jun 2021"),
  line("• Completed a 480-hour program in operations analytics and data reporting."),
  blank(),
  line("Bachelor of Arts in Business Administration", { bold: true }),
  line("Example University"),
  line("Sep 2014 - Jun 2018"),
  blank(),
  line("CERTIFICATIONS", { heading: true }),
  line("Certified Service Operations Professional | Synthetic Board | 2024", { bold: true }),
  line("Credential ID: SYN-12345"),
  blank(),
  line("ACHIEVEMENTS", { heading: true }),
  line("Operational Excellence: Received the 2024 Process Improvement Award."),
  line("Customer Impact: Recognized for clear incident communications."),
  blank(),
  line("ADDITIONAL INFORMATION", { heading: true }),
  line("Volunteer: Mentored career changers through a community technology program.")
];

const document = new Document({
  creator: "Apply Pilot Test Fixture",
  title: "Jordan Example Resume",
  subject: "Synthetic resume parsing contract fixture",
  styles: {
    default: {
      document: { run: { font: "Arial", size: 21, color: "000000" } },
      title: { run: { font: "Arial", size: 34, bold: true, color: "000000" } },
      heading1: { run: { font: "Arial", size: 20, bold: true, color: "000000" } }
    }
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 792, right: 1008, bottom: 792, left: 1008 }
      }
    },
    children: paragraphs
  }]
});

async function main() {
  await writeFile(output, await Packer.toBuffer(document));
}

void main();
