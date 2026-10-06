import { defaultResumeFormat, isResumeHeading, paginateResumeText, type ResumeFormat } from "@/lib/documents/resume-format";

const fontLabels = {
  ARIAL: "Arial",
  CALIBRI: "Calibri",
  GEORGIA: "Georgia"
} as const;

export function FormattedDocumentPreview({
  text,
  title,
  format = defaultResumeFormat,
  headingLevel = 3
}: {
  text: string;
  title: string;
  format?: ResumeFormat;
  headingLevel?: 2 | 3;
}) {
  const pages = paginateResumeText(text, format);
  const paperWidth = format.pageSize === "A4" ? "min(100%, 49.6rem)" : "min(100%, 51rem)";
  const paperAspectClass = format.pageSize === "A4" ? "sm:aspect-[210/297]" : "sm:aspect-[8.5/11]";
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className="min-w-0 space-y-3" aria-label={title} data-document-preview={title}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <Heading className="text-base font-semibold text-slate-950">{title}</Heading>
          <p className="text-sm text-slate-500">Estimated {pages.length} {pages.length === 1 ? "page" : "pages"}</p>
        </div>
        {pages.length > 2 ? (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">Review length</span>
        ) : null}
      </div>
      <p className="rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 sm:hidden" data-mobile-full-document-cue>
        Full document preview · scroll down to review every section.
      </p>
      <div className="space-y-5 overflow-x-auto rounded-lg bg-slate-200 p-3 sm:p-5">
        {pages.map((lines, pageIndex) => (
          <article
            key={pageIndex}
            className={`mx-auto h-auto overflow-visible bg-white shadow-sm sm:overflow-hidden ${paperAspectClass}`}
            data-document-page
            style={{
              width: paperWidth,
              padding: format.template === "COMPACT" ? "5.8%" : "7.2%",
              fontFamily: fontLabels[format.fontFamily],
              fontSize: `${format.fontSize * (4 / 3)}px`,
              lineHeight: format.lineSpacing / 100
            }}
          >
            <div className="h-auto overflow-visible text-slate-800 sm:h-full sm:overflow-hidden">
              {lines.map((line, lineIndex) => {
                const trimmed = line.trim();
                const identityLine = pageIndex === 0 && lineIndex === 0 && Boolean(trimmed);
                const contactLine = pageIndex === 0 && lineIndex === 1 && Boolean(trimmed);
                const heading = !identityLine && !contactLine && isResumeHeading(line);
                const bullet = /^\u2022\s+/.test(line);
                return (
                  <div
                    key={`${pageIndex}-${lineIndex}`}
                    className={identityLine
                      ? "break-words text-[1.15em] font-bold tracking-[0.03em] text-slate-950"
                      : contactLine
                        ? "break-words text-[0.9em] text-slate-600"
                        : heading
                      ? format.template === "MODERN"
                        ? "mb-1 mt-3 border-l-4 py-0.5 pl-2 font-bold uppercase"
                        : "mb-1 mt-3 border-b pb-1 font-bold uppercase"
                      : bullet
                        ? "ml-4 list-item pl-1"
                        : trimmed ? "min-h-[1em]" : "h-[0.65em]"}
                    style={heading ? { color: format.accentColor, borderColor: format.accentColor } : undefined}
                  >
                    {bullet ? line.replace(/^\u2022\s+/, "") : line || " "}
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
