import type { StandardPdfFontName } from "@/lib/documents/document-typography";

export const pdfFonts = ["HELVETICA", "TIMES"] as const;
export type PdfFont = (typeof pdfFonts)[number];
export const defaultPdfFont: PdfFont = "HELVETICA";
export const pdfFontLabels: Record<PdfFont, string> = { HELVETICA: "Helvetica", TIMES: "Times" };

export const pdfFontNames: Record<PdfFont, { regular: StandardPdfFontName; bold: StandardPdfFontName; italic: StandardPdfFontName }> = {
  HELVETICA: { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" },
  TIMES: { regular: "Times-Roman", bold: "Times-Bold", italic: "Times-Italic" }
};
