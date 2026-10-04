# Source-Preserving Resume Parse Contract

Status: approved for the scoped local implementation and reviewed draft PR on 2026-10-04. A paid provider call, merge, deployment, production write, or application submission remains separately gated.

## Approved decision

Apply Pilot, rather than the model, owns all exact source text. The owner approved the coordinated parsing-contract and consumer correction after the audit summarized below. The approval covers local implementation, synthetic verification, independent review, commits, branch push, and a draft PR; it does not authorize another paid provider request, merge, deployment, production write, or application submission.

## Evidence and problem statement

The pinned PR #25 diagnostic proved that Gemini accepts the reduced wire schema. The one authorized call returned HTTP 200 and `STOP`, but local validation failed at `sourceSections[1]`. For the synthetic fixture, that path is the `PROFESSIONAL SUMMARY` envelope. The retained diagnostic cannot distinguish an exact section-kind, heading, or body mismatch from an object-level schema failure because it deliberately discarded the provider JSON and retained only a safe field path.

The current server already derives exact section order, heading, and body text from the submitted source. The provider is nevertheless asked to reproduce those values byte-for-byte, along with repeated record source text. That duplication increases response size and makes a model transcription a prerequisite for accepting source text the server already possesses.

## Approved diagnostic delta

This phase adds classification only to the local pinned diagnostic; it does not alter parser acceptance. A failed structured result now reports a fixed stage, an allowlisted internal error code, an allowlisted canonical section when the failing path identifies one, and a bounded mismatch component. Truly sectionless failures such as `contractVersion` retain a null section. Exact string comparisons expose only UTF-8 byte counts and HMAC-SHA256 fingerprints keyed by the owner-supplied diagnostic credential. Schema object-shape failures expose property counts but no property names or values. Malformed JSON and the three consumer checks receive fixed stage labels.

The diagnostic still retains no provider output, source text, compared fragments, secret, or untrusted error text. The keyed fingerprints are stable only while the same owner-supplied diagnostic credential is reused; they are not stable across credentials and are not persisted by this path. Keying prevents an offline dictionary attack against low-entropy headings and short résumé fields while preserving enough evidence to distinguish an exact-envelope mismatch from a schema-shape failure at the same field path.

## Goals

- Keep the normalized submitted source as the sole text authority.
- Preserve exact section order, headings, bodies, record boundaries, and every non-whitespace source character.
- Let the model make semantic classifications and identify structural record spans without making it a source-text store.
- Preserve typed-field source support, adjacent-record merge defenses, omission detection, invention rejection, and existing consumer inputs.
- Keep legacy v3/v5 stored results readable without a database migration or destructive rewrite.
- Reduce structured-output duplication and recalculate bounds from the new response shape.

## Non-goals

- No relaxed or fuzzy source comparison.
- No silent repair of an invalid model record boundary.
- No full local inference of ambiguous work, project, education, or certification boundaries in this first design.
- No rewrite of any owner résumé or private fixture.
- No model, key, cost-policy, production database, deployment, or submission change.

## Proposed authority split

### Server-owned source catalog

Normalize line endings once, then create an immutable request-local catalog:

- `sectionId`: stable position ID such as `section-1`.
- `section`: locally recognized canonical section type.
- `heading`: exact source heading or `null` for the preamble.
- `sourceText`: exact normalized body slice held only by the server.
- `lineIds`: ordered IDs such as `section-4-line-1` mapped to exact source line slices.
- `recordBlocks`: populated locally for contact, summary, skills, achievements, and additional sections.

The provider input should contain one annotated source representation, not both raw and annotated copies. Line IDs are metadata; the server retains the unannotated source and exact offset table.

### Model-owned interpretation

The provider returns:

- semantic typed fields, still subject to exact source-support validation;
- section status and bounded warnings;
- for work history, projects, education, and certifications, ordered structural spans expressed as existing start and end line IDs;
- each typed structural record associated with exactly one returned span.

The provider does not return section headings, complete section bodies, `sourceSections[].sourceText`, `sourceSections[].recordBlocks`, or structural record `sourceText` strings.

### Server assembly

The server validates every returned ID against the request-local catalog, slices exact normalized source text, and constructs the canonical parsed resume consumed by persistence and downstream features. It must reject before persistence when spans are unknown, reversed, overlapping, out of order, cross-section, incomplete, duplicated, or inconsistent with typed records.

## Why line IDs instead of character offsets

Numeric character offsets ask a language model to count code units precisely and create Unicode ambiguity. Stable line IDs keep the provider grammar simple and let the server own offsets. A start/end pair can still represent a multiline record. This design assumes structural records begin and end on source line boundaries, matching the existing DOCX extraction and record-boundary contract. A future need for partial-line structural spans would require a separately reviewed grammar.

## Lossless and structural invariants

The assembled result is accepted only when all of the following hold:

1. Every locally derived section appears once and in exact order.
2. Locally deterministic non-structural blocks exactly cover their section under the existing rules.
3. Every structural span belongs to its declared section and references existing ordered line IDs.
4. Structural spans are ordered, non-overlapping, and cover every non-whitespace structural-section character exactly once.
5. Existing paragraph, date-line, pipe-header, bullet-marker, and adjacent-record boundary guards accept each split.
6. Each structural typed record maps one-to-one to one accepted span.
7. Every non-null typed string occurs verbatim in its server-sliced record or section.
8. Typed arrays cannot duplicate one source occurrence to amplify facts.
9. Section status agrees with locally observed headings and accepted typed records.
10. Application-plan, job-match, and tailoring consumers receive the same canonical fields and raw-source fallback as today.

The server must never substitute a locally guessed structural split after rejecting the model's spans.

## Provider grammar

Use a closed object schema with required fields and `additionalProperties: false`. Span endpoints are strings validated against the request-local ID allowlist after the response returns. Do not expand a large dynamic enum of every line ID into the response schema; that would increase schema complexity and recreate the Gemini rejection risk. Canonical Zod bounds remain authoritative, while the Gemini wire projection may continue to omit only the reviewed `maxItems` constraints.

The minimal new structural shape is conceptually:

```text
recordSpan: { sectionId, startLineId, endLineId }
typedRecord: { spanIndex, semantic fields... }
```

`spanIndex` is a bounded local array index, not authority by itself. The server validates the referenced span and creates exact `sourceText` from it.

## Compatibility and versioning

- Introduce a new parse contract version rather than changing v5 meaning in place.
- Bump prompt, cache, and Gemini wire revisions coherently; the proposed sequence after PR #25 is prompt 7, cache 8, and wire 3.
- Cache keys must isolate the new annotated input and response grammar from v5/cache-7 results.
- Keep the central legacy decoder for persisted v3 and v5 outputs.
- Persist newly assembled canonical output under the new contract version only after validation.
- The analysis/output columns already store JSON; no persistent schema field or database migration is expected. If implementation discovers a database constraint that requires migration, stop for separate approval.
- Do not rewrite existing rows or replay old provider responses into the new contract.

## Token and capacity tradeoffs

The annotated source adds short line IDs to provider input. In exchange, the response removes repeated section bodies, record blocks, and structural record source strings. The current full synthetic output repeats the same source several times, so the response should shrink materially, but implementation must measure rather than assume the new bound.

Recompute:

- maximum annotated input bytes and token estimate;
- maximum response bytes from the exact new schema;
- structural record and line-ID limits;
- the diagnostic response-body cap;
- maximum reserved output tokens and cost.

Do not raise global policy limits merely to accommodate the new representation. Reject a source locally if its lossless catalog cannot fit the reviewed bounds.

## Alternatives considered

### Keep model-copied source and add diagnostics only

Smallest immediate change and useful for evidence, but retains avoidable transcription and output-size risk. Appropriate only as observability for PR #25, not the preferred long-term authority design.

### Locally bind envelopes but keep model-copied structural records

Removes the observed summary-envelope failure class with less work, but structural source text remains duplicated and vulnerable to the same transcription problem. It is a viable staged intermediate only if its cache/contract version is explicit.

### Fully local structural segmentation

Eliminates provider span selection but risks silently turning ambiguous headers or metadata into records. It is not proposed until a broader corpus proves deterministic rules can preserve the current fail-closed behavior.

### Relax exact equality or fuzzy-match provider text

Rejected. It can hide omissions, invented text, punctuation changes, or merged records and weakens the lossless authority.

## Acceptance evidence required before a paid test

- Red/green tests for unknown, reversed, overlapping, gapped, duplicated, cross-section, reordered, and adjacent-merge spans.
- The complete synthetic DOCX must exercise extraction, stubbed provider spans, server slicing, validation, route persistence stubs, application planning, job match, and tailoring.
- Every source line and canonical typed fact must remain reachable.
- Legitimate connector words and overlapping typed projections must pass.
- Legacy v3/v5 reads and cache isolation must pass.
- Exact estimator and response-cap tests must cover the full fixture.
- Independent review must report no unresolved findings.
- A separately authorized masked diagnostic is required before release consideration.

## Approval boundary

No new parse-contract implementation should begin until the owner approves this authority split, line-ID span grammar, version sequence, and staged-versus-direct migration choice.
