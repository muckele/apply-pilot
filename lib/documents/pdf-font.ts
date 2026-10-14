export const pdfFonts = ["HELVETICA", "TIMES"] as const;
export type PdfFont = (typeof pdfFonts)[number];
export const defaultPdfFont: PdfFont = "HELVETICA";
export const pdfFontLabels: Record<PdfFont, string> = { HELVETICA: "Helvetica", TIMES: "Times" };

export const pdfFontNames: Record<PdfFont, { regular: string; bold: string }> = {
  HELVETICA: { regular: "Helvetica", bold: "Helvetica-Bold" },
  TIMES: { regular: "Times-Roman", bold: "Times-Bold" }
};
