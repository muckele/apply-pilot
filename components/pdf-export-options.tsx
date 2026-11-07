"use client";
import { pdfFonts, pdfFontLabels, type PdfFont } from "@/lib/documents/pdf-font";

export function PdfFontChoice({ value, onChange, disabled = false }: { value: PdfFont; onChange: (font: PdfFont) => void; disabled?: boolean }) {
  return <label className="block text-sm product-review-metadata">PDF font
    <select aria-label="PDF font" className="block w-full mt-1 min-h-[44px]" value={value} disabled={disabled} onChange={event => onChange(event.target.value as PdfFont)}>
      {pdfFonts.map(font => <option key={font} value={font}>{pdfFontLabels[font]}</option>)}
    </select>
  </label>;
}

export function ActualPdfPreview({ url, font }: { url: string; font: PdfFont }) {
  return <div data-actual-product-pdf>
    <p className="text-sm product-review-metadata">Actual PDF · {pdfFontLabels[font]} · review every page. This preview and the download below use the same PDF file.</p>
    <div className="application-background-actions">
      <a href={url} target="_blank" rel="noreferrer">Open this exact PDF in a new tab</a>
      <a href={url} download="reviewed-document.pdf">Download this exact PDF</a>
    </div>
    <iframe title="Actual exported document PDF" className="w-full min-h-[600px]" src={url} />
  </div>;
}
