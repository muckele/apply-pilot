import { createHash } from "node:crypto";

import JSZip from "jszip";
import { z } from "zod";

import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import {
  validateCoverLetterClaims,
  validateTailoredResumeClaims,
  type ApplicationDocumentPayload
} from "@/lib/ai/application-document-claims";
import { buildCorrectionFlowDocumentReviewEnvelope } from "@/lib/ai/correction-flow-document-review-contract";
import { coverLetterSchema } from "@/lib/ai/documents";
import { hashAiInput } from "@/lib/ai/input-hash";
import { tailoredResumeSchema } from "@/lib/ai/resume";
import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
  renderCanonicalApplicationDocumentV1,
  renderGenericDocument
} from "@/lib/documents/export-renderer";
import { extractResumeDocxText } from "@/lib/resume-docx-text";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const exportArtifactSchema = z.object({
  docxByteHash: sha256Schema,
  docxExtractedTextHash: sha256Schema,
  pdfByteHash: sha256Schema,
  pdfExtractedTextHash: sha256Schema,
  docxRoundTripExact: z.boolean(),
  docxCriticalFactsPresent: z.boolean(),
  pdfCriticalFactsPresent: z.boolean()
}).strict();

export const correctionFlowDocumentExportVerificationSchema = z.object({
  inMemoryOnly: z.literal(true),
  resume: exportArtifactSchema,
  coverLetter: exportArtifactSchema
}).strict();

export type CorrectionFlowDocumentExportVerification = z.infer<
  typeof correctionFlowDocumentExportVerificationSchema
>;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

async function extractExactCanonicalDocxContent(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) throw new Error("Canonical DOCX is missing word/document.xml.");
  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
    .map((paragraph) => {
      const text = decodeXml(
        [...paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
          .map((match) => match[1])
          .join("")
      );
      return /<w:numPr(?:\s[^>]*)?>/u.test(paragraph[0]) ? `• ${text}` : text;
    })
    .join("\n");
}

function extractGeneratedPdfText(bytes: Buffer) {
  const source = bytes.toString("utf8");
  if (!source.startsWith("%PDF-1.4\n")) throw new Error("Canonical PDF header is missing.");
  return [...source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/gu)]
    .map((match) => match[1].replace(/\\([()\\])/gu, "$1"))
    .join("\n");
}

function comparable(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeBulletMarker(value: string, marker: "•" | "-") {
  return value.replace(/^\s*[-*•]\s+/u, `${marker} `);
}

function docxRoundTripComparable(value: string) {
  return value.split(/\r?\n/u).map((line) => normalizeBulletMarker(line, "•")).join("\n");
}

function pdfComparable(value: string) {
  return comparable(normalizeBulletMarker(value, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/gu, "?"));
}

function criticalFactsPresent(source: string, extracted: string, pdf: boolean) {
  const normalize = (line: string) => pdf
    ? pdfComparable(line)
    : comparable(normalizeBulletMarker(line, "•"));
  const haystack = comparable(extracted.split(/\r?\n/u).map(normalize).join("\n"));
  return source.split(/\r?\n/u)
    .map(normalize)
    .filter(Boolean)
    .every((line) => haystack.includes(line));
}

async function renderAndVerifyArtifact(
  artifactType: "RESUME" | "COVER_LETTER",
  content: string
) {
  const [docxResult, pdfResult] = await Promise.allSettled([
    renderCanonicalApplicationDocumentV1({ artifactType, content }),
    renderGenericDocument({
      content,
      format: "pdf",
      resumeFormat: {
        template: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.template,
        pageSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.pageSize,
        fontFamily: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontFamily,
        accentColor: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.accentColor,
        fontSize: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.fontSize,
        lineSpacing: CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1.lineSpacing
      }
    })
  ]);
  if (docxResult.status === "rejected" || pdfResult.status === "rejected") {
    if (docxResult.status === "fulfilled") docxResult.value.fill(0);
    if (pdfResult.status === "fulfilled") pdfResult.value.fill(0);
    throw new Error("Canonical application-document rendering failed.");
  }
  const docx = docxResult.value;
  const pdf = pdfResult.value;
  try {
    const [exactDocxResult, productionDocxResult] = await Promise.allSettled([
      extractExactCanonicalDocxContent(docx),
      extractResumeDocxText(docx)
    ]);
    if (exactDocxResult.status === "rejected" || productionDocxResult.status === "rejected") {
      throw new Error("Canonical DOCX extraction failed.");
    }
    const exactDocx = exactDocxResult.value;
    const productionDocx = productionDocxResult.value;
    const extractedPdf = extractGeneratedPdfText(pdf);
    const result = {
      pdf,
      verification: exportArtifactSchema.parse({
        docxByteHash: sha256(docx),
        docxExtractedTextHash: sha256(productionDocx),
        pdfByteHash: sha256(pdf),
        pdfExtractedTextHash: sha256(extractedPdf),
        docxRoundTripExact: docxRoundTripComparable(exactDocx) === docxRoundTripComparable(content),
        docxCriticalFactsPresent: criticalFactsPresent(content, productionDocx, false),
        pdfCriticalFactsPresent: criticalFactsPresent(content, extractedPdf, true)
      })
    };
    docx.fill(0);
    return result;
  } catch (error) {
    docx.fill(0);
    pdf.fill(0);
    throw error;
  }
}

function assertCompleteVerification(verification: CorrectionFlowDocumentExportVerification) {
  if (
    !verification.resume.docxRoundTripExact ||
    !verification.resume.docxCriticalFactsPresent ||
    !verification.resume.pdfCriticalFactsPresent ||
    !verification.coverLetter.docxRoundTripExact ||
    !verification.coverLetter.docxCriticalFactsPresent ||
    !verification.coverLetter.pdfCriticalFactsPresent
  ) {
    throw new Error("In-memory application-document export verification failed.");
  }
}

async function renderVerifiedDocuments(input: {
  resumeText: string;
  coverLetter: string;
}) {
  const [resumeResult, coverLetterResult] = await Promise.allSettled([
    renderAndVerifyArtifact("RESUME", input.resumeText),
    renderAndVerifyArtifact("COVER_LETTER", input.coverLetter)
  ]);
  if (resumeResult.status === "rejected" || coverLetterResult.status === "rejected") {
    if (resumeResult.status === "fulfilled") resumeResult.value.pdf.fill(0);
    if (coverLetterResult.status === "fulfilled") coverLetterResult.value.pdf.fill(0);
    throw new Error("Canonical application-document verification failed.");
  }
  const resume = resumeResult.value;
  const coverLetter = coverLetterResult.value;
  try {
    const verification = correctionFlowDocumentExportVerificationSchema.parse({
      inMemoryOnly: true,
      resume: resume.verification,
      coverLetter: coverLetter.verification
    });
    assertCompleteVerification(verification);
    return { verification, resumePdf: resume.pdf, coverLetterPdf: coverLetter.pdf };
  } catch (error) {
    resume.pdf.fill(0);
    coverLetter.pdf.fill(0);
    throw error;
  }
}

export async function verifyCorrectionFlowDocumentExports(input: {
  tailoredResume: z.infer<typeof tailoredResumeSchema>;
  coverLetter: z.infer<typeof coverLetterSchema>;
}) {
  const rendered = await renderVerifiedDocuments({
    resumeText: input.tailoredResume.resumeText,
    coverLetter: input.coverLetter.coverLetter
  });
  rendered.resumePdf.fill(0);
  rendered.coverLetterPdf.fill(0);
  return rendered.verification;
}

type ReviewBinding = Readonly<{
  manifestHash: string;
  exactHead: string;
  payloadHash: string;
  reviewedEvidenceHash: string;
  factCatalogHash: string;
  promptVersion: string;
  model: string;
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH";
  generationId: string;
}>;

export async function buildCorrectionFlowDocumentReviewBundle(input: {
  payload: ApplicationDocumentPayload;
  tailoredResume: unknown;
  coverLetter: unknown;
  binding: ReviewBinding;
  expectedValidatedOutputHashes: Readonly<{ tailoredResume: string; coverLetter: string }>;
}) {
  const payloadHash = hashAiInput("correctionFlowResumeDiagnosticPayload", "1", input.payload);
  if (payloadHash !== input.binding.payloadHash) throw new Error("Document review payload hash changed.");
  const reviewedEvidenceHash = hashAiInput(
    "correctionFlowResumeDiagnosticReviewedEvidence", "1", input.payload.reviewedEvidence
  );
  if (reviewedEvidenceHash !== input.binding.reviewedEvidenceHash) {
    throw new Error("Document review evidence hash changed.");
  }
  const facts = buildApplicationDocumentFactCatalog(input.payload);
  const factCatalogHash = hashAiInput("applicationDocumentFactCatalog", "7", facts);
  if (factCatalogHash !== input.binding.factCatalogHash) {
    throw new Error("Document review fact catalog hash changed.");
  }
  const tailoredResume = validateTailoredResumeClaims(
    input.payload,
    tailoredResumeSchema.parse(input.tailoredResume)
  );
  const coverLetter = validateCoverLetterClaims(
    input.payload,
    coverLetterSchema.parse(input.coverLetter)
  );
  const tailoredResumeHash = hashAiInput(
    "correctionFlowDocumentDiagnosticResume", "1", tailoredResume
  );
  const coverLetterHash = hashAiInput(
    "correctionFlowDocumentDiagnosticCoverLetter", "1", coverLetter
  );
  if (
    tailoredResumeHash !== input.expectedValidatedOutputHashes.tailoredResume ||
    coverLetterHash !== input.expectedValidatedOutputHashes.coverLetter
  ) {
    throw new Error("Document review validated output hash changed.");
  }

  const rendered = await renderVerifiedDocuments({
    resumeText: tailoredResume.resumeText,
    coverLetter: coverLetter.coverLetter
  });
  try {
    const envelope = buildCorrectionFlowDocumentReviewEnvelope({
    manifestHash: input.binding.manifestHash,
    exactHead: input.binding.exactHead,
    payloadHash,
    sourceResumeHash: hashAiInput("correctionFlowDocumentReviewSourceResume", "1", input.payload.resume ?? null),
    profileHash: hashAiInput("correctionFlowDocumentReviewProfile", "1", input.payload.profile ?? null),
    jobProjectionHash: hashAiInput("correctionFlowDocumentReviewJobProjection", "1", input.payload.job ?? null),
    reviewedEvidenceHash,
    factCatalogHash,
    promptVersion: input.binding.promptVersion,
    model: input.binding.model,
    thinkingLevel: input.binding.thinkingLevel,
    generationId: input.binding.generationId,
    documents: [
      {
        kind: "resume",
        validatedOutputHash: tailoredResumeHash,
        renderedPdfHash: rendered.verification.resume.pdfByteHash
      },
      {
        kind: "cover_letter",
        validatedOutputHash: coverLetterHash,
        renderedPdfHash: rendered.verification.coverLetter.pdfByteHash
      }
    ]
  });
  type PrivateState = {
    documents: readonly [
      { kind: "resume"; title: string; text: string; evidence: typeof tailoredResume.claimEvidence },
      { kind: "cover_letter"; title: string; text: string; evidence: typeof coverLetter.claimsUsed }
    ];
    renderedPdfs: readonly [
      { kind: "resume"; bytes: Buffer },
      { kind: "cover_letter"; bytes: Buffer }
    ];
  };
  let state: PrivateState | null = {
    documents: [
      {
        kind: "resume",
        title: "Validated tailored resume",
        text: tailoredResume.resumeText,
        evidence: tailoredResume.claimEvidence
      },
      {
        kind: "cover_letter",
        title: coverLetter.title,
        text: coverLetter.coverLetter,
        evidence: coverLetter.claimsUsed
      }
    ],
    renderedPdfs: [
      { kind: "resume", bytes: rendered.resumePdf },
      { kind: "cover_letter", bytes: rendered.coverLetterPdf }
    ]
  };
  let claimed = false;
  const disposeState = (overwrite: boolean) => {
    if (!state) return;
    if (overwrite) state.renderedPdfs.forEach((pdf) => pdf.bytes.fill(0));
    state = null;
  };
  const safe = Object.freeze({ envelope, verification: rendered.verification });
    return Object.freeze({
      safe,
      claim() {
        if (claimed) throw new Error("Document review bundle was already claimed.");
        if (!state) throw new Error("Document review bundle was released.");
        claimed = true;
        let active = true;
        const current = () => {
          if (!active || !state) throw new Error("Document review bundle claim was released.");
          return state;
        };
        return Object.freeze({
          envelope,
          get documents() { return current().documents; },
          get renderedPdfs() { return current().renderedPdfs; },
          hasPrivateInput: () => active && state !== null,
          releaseOwnership() {
            if (!active) return;
            active = false;
            disposeState(false);
          },
          dispose() {
            if (!active) return;
            active = false;
            disposeState(true);
          }
        });
      },
      dispose() {
        if (claimed) return;
        claimed = true;
        disposeState(true);
      }
    });
  } catch (error) {
    rendered.resumePdf.fill(0);
    rendered.coverLetterPdf.fill(0);
    throw error;
  }
}
