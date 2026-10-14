# Product document review and ordinary exports

The job detail page now presents the complete master source and target job, existing missing-fact correction review, and selected tailored documents in three stages. Stage navigation changes local UI state only. Saving reviewed evidence, reassessment, generation, editing and export retain their existing authenticated routes and explicit consent controls.

Unsaved document drafts remain separate by document kind and version. Switching documents retires pending responses and PDF object URLs without discarding drafts. A changed saved document surfaces a conflict and blocks saving/exporting until the owner explicitly discards the old draft. Unsaved edits, changed evidence and stale evidence bindings disable actual PDF preview and downloads. Review is not application approval.

Ordinary exports (`/api/documents/export`) and browser previews use the selected template, page size, font preference, size, spacing and accent. The body comes from stored document content; version titles remain filenames and UI metadata. PDF and DOCX retain complete ordered source paragraphs. PDF rejects unsupported glyphs explicitly instead of replacing them silently. DOCX retains continuous identifiers rather than turning wrapped lines into separate paragraphs.

## Compatibility boundary

Prepared-run V1 exports remain on `lib/application-runs/document-export.ts` and `lib/documents/export-renderer.ts`; neither implementation changes in this integration. Existing packet authority, one permanent Fill and consumed-Fill semantics are unchanged. Durable exact-document approval and reusable master-profile promotion remain separate decisions. No database migration is included.

## Verification and limits

Synthetic actual-route verification exercises owned reads, complete three-job source, desktop/mobile Light/Dark/System, OS theme changes and persistence, computed metadata contrast, navigation without API mutations, draft preservation/discard, delayed export retirement, explicit reassessment cost confirmation, actual PDF/DOCX exports and stale-export rejection. Providers are stubbed and no employer is accessed.

Actual owned ordinary-export files were converted with signed official LibreOffice 26.8.1 on this Mac. Its isolated font catalog initially substituted FrankRuhlHofshi/LinuxLibertine for the requested Georgia. Explicit discovery of the installed Mac system fonts fixes that qualification setup without changing the DOCX or substituting another font. Native PDF font metadata now contains Georgia/Georgia-Bold; independent visual review and measured page bounds verify the complete three-page custom résumé. The DOCX retains A4, 12 pt body text, exact 150% spacing and the selected accent. PDF.js verifies complete ordered source text; text extraction alone is not the fidelity gate. Actual default Arial exports retain two résumé pages and one letter page. See [NATIVE_DOCX_QUALIFICATION.md](NATIVE_DOCX_QUALIFICATION.md) for the reproducible setup and its scope.

Parity means tested content, DOCX settings and page counts. The direct PDF exporter uses Helvetica/Times substitutions; DOCX uses named native fonts and renderer reflow. The Georgia preview explicitly discloses the PDF's Times mapping so the owner can choose DOCX to retain Georgia. Browser/PDF conservative wrapping and DOCX paragraph reflow do not establish identical line breaks, geometry or pixels. Qualification requires the selected fonts to be installed in the reader's renderer; universal renderer behavior is not claimed.

The strict production webpack build and standalone typecheck now pass. Fifteen application-run/policy route modules re-export only their original HTTP handlers from library modules; all relocated implementations and dependency wiring are byte-identical to their prior route implementations. Existing factory tests import the library modules. No authorization, validation, evidence, consent, Fill or cache behavior changes. Default Turbopack still encounters this environment's local bind restriction; the supported webpack path passes without suppressing checks.

Authored samples and offline stubs provide no evidence of Gemini writing quality. No paid qualification, production write, application submission, merge or deployment is part of this integration.
