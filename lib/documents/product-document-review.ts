import { defaultPdfFont } from "@/lib/documents/pdf-font";
import { PRODUCT_DOCUMENT_LAYOUT_VERSION, type ProductDocumentInput } from "@/lib/documents/product-document-layout";
import { defaultResumeFormat } from "@/lib/documents/resume-format";

// The review selects an existing product format; it never defines a separate rendering template.
export const PRODUCT_DOCUMENT_REVIEW_RENDERING = Object.freeze({
  renderer: "product-document-renderer" as const,
  layoutVersion: PRODUCT_DOCUMENT_LAYOUT_VERSION,
  resumeFormat: Object.freeze({ ...defaultResumeFormat, fontSize: 11 }),
  coverLetterFormat: Object.freeze({ ...defaultResumeFormat }),
  pdfFont: defaultPdfFont
});

export function productDocumentReviewInput(
  artifactType: ProductDocumentInput["artifactType"],
  content: string
): ProductDocumentInput {
  return {
    artifactType,
    content,
    resumeFormat: artifactType === "RESUME"
      ? PRODUCT_DOCUMENT_REVIEW_RENDERING.resumeFormat
      : PRODUCT_DOCUMENT_REVIEW_RENDERING.coverLetterFormat,
    pdfFont: PRODUCT_DOCUMENT_REVIEW_RENDERING.pdfFont
  };
}
