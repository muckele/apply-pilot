import { createHash } from "node:crypto";

import JSZip from "jszip";

import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
  renderCanonicalApplicationDocumentV1
} from "@/lib/documents/export-renderer";
import { paginateResumeText, type ResumeFormat } from "@/lib/documents/resume-format";
import { extractResumeDocxText } from "@/lib/resume-docx-text";
import type { SyntheticOneJobFixture } from "@/evaluation/synthetic-one-job-fixture";

const canonicalResumeFormat: ResumeFormat = Object.freeze({
  template: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.template,
  pageSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.pageSize,
  fontFamily: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontFamily,
  accentColor: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.accentColor,
  fontSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontSize,
  lineSpacing: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.lineSpacing
});

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

async function extractExactCanonicalDocxContent(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("Canonical DOCX is missing word/document.xml.");

  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
    .map((paragraph) => {
      const text = decodeXml(
        [...paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map((match) => match[1])
          .join("")
      );
      return /<w:numPr(?:\s[^>]*)?>/.test(paragraph[0]) ? `• ${text}` : text;
    })
    .join("\n");
}

function criticalFacts(content: string) {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function longUnicodeResumeContent() {
  return [
    "SYNTHETIC LONG-FORM CANDIDATE",
    "Los Angeles | synthetic-long@example.test",
    "",
    "SUMMARY",
    "Café résumé · naïve validation · São Paulo",
    "",
    "EXPERIENCE",
    "Synthetic Export Fidelity Lead — Example Systems",
    ...Array.from({ length: 48 }, (_, index) =>
      `• Continuation evidence ${index + 1}: preserved source-backed delivery detail across a deliberately long canonical document.`
    ),
    "",
    "PROJECTS",
    "Multipage export validation",
    "• Verified that the final section remains present after canonical DOCX pagination.",
    "",
    "EDUCATION",
    "Bachelor of Arts in Business Administration — Example University",
    "",
    "CERTIFICATIONS",
    "Synthetic Technical Program — 480 hours"
  ].join("\n");
}

export type SyntheticExportFidelityArtifact = Readonly<{
  artifactType: "RESUME" | "COVER_LETTER";
  fileName: string;
  bytes: Buffer;
  byteHash: string;
  previewContent: string;
  previewContentHash: string;
  extractedContent: string;
  extractedContentHash: string;
  productionExtractedText: string;
  productionExtractedTextHash: string;
  previewPageCount: number;
  missingCriticalFacts: readonly string[];
}>;

async function buildArtifact(input: {
  artifactType: "RESUME" | "COVER_LETTER";
  fileName: string;
  content: string;
}): Promise<SyntheticExportFidelityArtifact> {
  const bytes = await renderCanonicalApplicationDocumentV1({
    artifactType: input.artifactType,
    content: input.content
  });
  const [extractedContent, productionExtractedText] = await Promise.all([
    extractExactCanonicalDocxContent(bytes),
    extractResumeDocxText(bytes)
  ]);
  const missingCriticalFacts = criticalFacts(input.content).filter(
    (fact) => !productionExtractedText.includes(fact)
  );

  return Object.freeze({
    artifactType: input.artifactType,
    fileName: input.fileName,
    bytes,
    byteHash: sha256(bytes),
    previewContent: input.content,
    previewContentHash: sha256(input.content),
    extractedContent,
    extractedContentHash: sha256(extractedContent),
    productionExtractedText,
    productionExtractedTextHash: sha256(productionExtractedText),
    previewPageCount: paginateResumeText(input.content, canonicalResumeFormat).length,
    missingCriticalFacts: Object.freeze(missingCriticalFacts)
  });
}

export async function buildSyntheticOneJobExportFidelityEvidence(fixture: SyntheticOneJobFixture) {
  const artifacts = await Promise.all([
    buildArtifact({
      artifactType: "RESUME",
      fileName: "synthetic-one-job-resume.docx",
      content: fixture.review.resumeText
    }),
    buildArtifact({
      artifactType: "COVER_LETTER",
      fileName: "synthetic-one-job-cover-letter.docx",
      content: fixture.review.coverLetterText
    }),
    buildArtifact({
      artifactType: "RESUME",
      fileName: "synthetic-one-job-long-unicode-resume.docx",
      content: longUnicodeResumeContent()
    })
  ]);
  const manifest = Object.freeze({
    schemaVersion: 1,
    rendererProfile: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
    artifacts: artifacts.map((artifact) => Object.freeze({
      artifactType: artifact.artifactType,
      fileName: artifact.fileName,
      byteHash: artifact.byteHash,
      previewContentHash: artifact.previewContentHash,
      extractedContentHash: artifact.extractedContentHash,
      productionExtractedTextHash: artifact.productionExtractedTextHash,
      previewPageCount: artifact.previewPageCount,
      missingCriticalFacts: artifact.missingCriticalFacts
    }))
  });

  return Object.freeze({ artifacts: Object.freeze(artifacts), manifest });
}
