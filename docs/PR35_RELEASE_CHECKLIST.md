# PR35 release checklist

Status: independently reviewed offline candidate. Publication is a draft-PR/CI step, not permission to merge, deploy, spend or submit an application.

The bounded C2 working-tree correction advances the shared application-document prompt/cache identity to v11 and product layout to v3; it is not yet published. Its checks and limitations are tracked in [C2 document quality](C2_DOCUMENT_QUALITY.md). The checkmarks below retain their original integration evidence and are not a fresh acceptance receipt for this correction.

- [x] Reviewed integration and font source pins match; unrelated duplicate dependency directory stays excluded.
- [x] Complete synthetic source, job-only corrections, generation stubs, actual exports and invalidation: unit 2039/2039, browser 390/390, guarded local PostgreSQL 16 140/140.
- [x] Credential-free production webpack build, standalone typecheck, lint and diff check pass. Browser/DB suites use synthetic data and mocked providers.
- [x] Actual ordinary PDF preview and its exact download have identical bytes for Helvetica and Times, for résumé and cover letter. Multi-page tests preserve complete ordered text and measured page bounds.
- [x] DOCX retains Arial/Calibri/Georgia. PDF standard fonts are unembedded; Word and PDF can wrap differently, and PDF viewers can render differently. The browser drawing is a DOCX layout guide. Mobile controls and direct PDF opening are verified; universal mobile inline rendering is not claimed.
- [x] Prepared-run V1 exports and permanent consumed-Fill authority remain unchanged. Edits or changed evidence cannot acquire fresh approval through font selection.
- [ ] Record final commit/remote head and require CI success for that exact SHA; a previous green SHA does not qualify this head.
- [ ] Qualify current Gemini writing quality: authored samples, stubs, exported-file checks and CI do not demonstrate live model compliance with application-document prompt/cache v11.
- [ ] Obtain a separate merge/release decision, migration and deployment review, and intended authenticated-flow verification before any production release. Existing PR35 schema additions remain subject to the established migration gate; this integration adds no new migration.

The next smallest controlled test is a separately authorized two-call synthetic document review on the final clean exact head: one résumé and one cover letter, pinned Gemini 3.8 Flash LOW, current prompt v11 and hash-bound manifest. Use the existing consented document-review launcher and its frozen synthetic payload; inspect both source/citation validation and actual files, then complete visible review. Do not repeat parsing, matching or evidence persistence, retry failed/uncertain calls, switch model, access owner data or interact with an employer. The owner must approve the exact manifest/data/cost envelope before credential handoff or either call; this checklist does not grant that approval.

That narrow test qualifies the existing synthetic diagnostic fixture only. The fuller three-job offline sample is not silently substituted into the launcher, and a successful diagnostic does not prove production persistence, every future provider response or the full intended application journey.

See [product review/export boundaries](PRODUCT_REVIEW_EXPORT_INTEGRATION.md), [native DOCX qualification](NATIVE_DOCX_QUALIFICATION.md) and [release gates](RELEASE_GATES_AND_ACCEPTANCE.md).
