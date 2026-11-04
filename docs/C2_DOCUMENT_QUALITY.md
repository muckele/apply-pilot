# C2 document quality correction

This bounded candidate improves cover-letter planning and ordinary product exports. It does not expand the factual claim contract. Authored synthetic samples and stubbed transport are offline evidence; they do not qualify Gemini writing quality or establish owner acceptance.

## Writing and provenance

The cover prompt asks for two supported job priorities, one existing exact published context line per evidence paragraph, and related complete responsibility/result facts. A paragraph may contain several factual sentences, but each sentence keeps its own fact ID. Repeating a synthesized whole claim under multiple IDs is forbidden. Employer prefixes and causal explanations cannot be added unless their complete wording is itself one supported standalone fact.

The complete submitted catalog remains available, including its existing provenance. No new ranking, truncation, qualification inference, uncited-line exemption or fact transformation is introduced. Claim/quality validators, wire schemas, source resolution and mandatory current reviewed-evidence coverage are unchanged. The separate authored C2 benchmark leaves the frozen qualification wire fixture untouched.

Application-document prompt/cache identity advances from 10 to 11. This is the existing shared résumé/letter namespace, so résumé cache identity also advances even though its writing prompt is unchanged. Model, thinking, limits, consent, spending controls and no-retry behavior remain unchanged. The diagnostic's 70 facts and payload/reviewed-evidence hashes are unchanged; its version-namespaced catalog pin and changed cover wire hash are updated. Historical v10 receipts are not rewritten and cannot authorize a v11 run.

## Product rendering

Product layout version 3 includes the actual height/spacing of the following record and first detail when keeping a section or record heading together. Ordinary DOCX exports add Heading1 sections, Heading2 records and heading keep-with-next. Product preview and export continue to share the layout. Prepared-run document authority, content and source ordering are unchanged.

Product layout version 4 additionally aligns single-leading-bullet recognition with the seven styles already accepted by the factual contract (`-`, `*`, `•`, `▪`, `◦`, `–`, `—`, each followed by whitespace). Product PDF/DOCX and preview use the existing canonical bullet; export verification shares the same recognition. Internal punctuation and factual text are preserved. Rendering manifests bind version 4, invalidating older rendering consent without changing writing prompt/cache 11. See the [second stopped-run investigation](CORRECTION_FLOW_RESUME_DIAGNOSTIC.md#october-16-second-stopped-run-and-offline-bullet-correction).

The 11 pt samples use an existing supported choice. The global 10 pt default is unchanged. Short samples retain natural whitespace; no padding, shrinking or fact deletion is used to fill pages. An expansive A4 12 pt / 150 spacing sample remains three pages with sparse later pages and a continued bullet.

Direct PDFs remain untagged and use standard PDF font substitutions. DOCX can wrap differently in Word/LibreOffice; the browser is a layout guide, not a pixel-identical Word renderer. Heading structure improves DOCX semantics but does not establish PDF/UA, full list semantics or assistive-technology conformance.

## Regression coverage for the 27 investigation outcomes

Related outcomes share fixtures and table cases rather than a second copied validator or large frozen-response corpus. New composition tests exercise the real fact-ID assembler; existing reference, negation, invention and wire-schema controls are reused.

| Investigation outcomes | Regression coverage |
| --- | --- |
| Minimal first-person control; correct employer prefix with one fact or merged citations; full delivery control; full employer prefix with one, duplicate or merged mappings | `application-document-composition.test.ts`: correct employer metadata does not authorize composing a prefix |
| Complete attributed wording genuinely present as one source fact | Same file: attributed sentence accepted when complete wording is one source fact |
| Two complete source sentences incorrectly merged into one claim; same sentences mapped separately | Same file: independent atomic mappings in one paragraph |
| Whole synthesized claim repeated under four IDs; merged citations still insufficient | Same file: repeating or merging IDs cannot validate synthesis |
| Novel generic connective rejected; existing published connective exempt | Same file: exact connective exemption |
| Correct contextual job fact cannot support an applicant claim | `application-document-claims.test.ts`: job-description evidence cannot establish an applicant fact (shared validator) |
| Inflated 42→420 accounts; dropped median; dropped business-day qualifier; reversed before/after; inflated 18→38% | `application-document-composition.test.ts`: C2 numeric/time qualifier table |
| Employer ownership swapped across records; unsupported reporting/mentoring causal join | Same file: joint citations cannot transfer ownership or manufacture causality |
| Genuine excerpt assigned to adjacent record | Same file: adjacent-record excerpt rejection |
| Unknown reference | `application-document-claims.test.ts`: unknown references and absent excerpts |
| Job requirement cannot become applicant qualification | Same file: job-description evidence cannot establish an applicant fact; profile goals/preferred roles controls |
| Invented applicant freewriting | Same file: invented skill, uncited facts and truthful-looking freewriting rejection |
| Negation reversed | Same file: affirmative claims cannot reverse negated evidence |

The additional unknown fact-ID case remains covered by `application-document-fact-catalog.test.ts`. Authored C2 tests check two distinct exact contexts, independent fact IDs, mandatory reviewed evidence, changed-outcome rejection and the long fixture's twelve-year summary. A production generation-path test uses stubbed transport to verify full catalog/provenance delivery, unchanged validation, accounting and the v11 assembled cache. Existing paid guards verify the current cache query excludes v10.

Run `npm test`, `npm run lint`, `npm run typecheck`, the production build and synthetic browser suite under the repository's credential/database safeguards. Actual PDF/DOCX inspection remains necessary: validator success and geometry checks alone do not prove readable writing or pagination. No database migration or paid/owner run is part of this correction.

## Diagnostic/product rendering parity correction

The two-document diagnostic and visible review now call the ordinary product renderer for both PDF and DOCX, and build their on-screen pages from the same product layout version 4. They select the reviewed existing 11 pt résumé option and the normal 10 pt cover-letter format, with Helvetica PDFs. The global default and current styling are unchanged. The safe manifests disclose the renderer, layout version, both full format objects and PDF font. Diagnostic contract 2 and visible-review contract 3 hash that rendering plan; historical manifest consent cannot authorize the changed plan. Writing prompt/cache remains 11.

Regressions compare all four outputs against the actual ordinary export route, compare the on-screen layout, check heading rules in headless Chromium, reject changed rendering manifests before mocked dispatch, and verify ordered PDF text including WinAnsi punctuation. DOCX comparison preserves ordered substantive paragraphs; blank-line spacing is encoded geometrically by the product export. Credential-free injected unit harnesses cover simulated post-consent behavior. No real launcher consent, credential input, provider call or owner window is part of this correction; the real key boundary remains owner-only until separately approved.
