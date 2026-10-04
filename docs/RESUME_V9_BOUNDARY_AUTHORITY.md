# Resume V9 Boundary Authority Correction

Status: owner-approved for local implementation, complete synthetic verification,
independent review, commit, branch push, and draft PR. No provider request, real
resume retry, production write, merge, deployment, or application submission is
authorized.

## Problem

The V8 source catalog can merge adjacent education records when the source uses a
pipe-delimited dated education header, an unbulleted complete narrative, and an
immediately adjacent pipe-delimited dated education header. Work and project
headers have explicit pipe rules, but education does not. V8 then gives the
provider one server-owned record ID for two source records, while downstream
heuristics reject every plausible one-record semantic projection.

The existing complete synthetic DOCX does not reproduce this topology: its
education entries are separated by blank lines and expanded across several
lines. The correction therefore requires a private-free structural twin of the
complete observed layout, not a fixture containing private source text.

## Authority decision

V9 makes the exact ordered server source catalog the only structural boundary
authority after preflight:

- One shared section-aware classifier recognizes deterministic structural record
  starts for work history, projects, education, and certifications.
- Exact source sections, lines, record blocks, record IDs, coverage, and order
  remain server-owned.
- The provider returns one semantic projection for each finite record ID.
- Typed values remain exact record-local source substrings. They may overlap and
  do not need to consume connector words.
- Invention, changed source, cross-record assignment, unknown/duplicate/reordered
  IDs, missing records, invalid dates, and required core-field omissions remain
  rejected.
- Post-binding punctuation, header-pair, and multiple-date heuristics no longer
  attempt to rediscover record boundaries for V9.
- Unsupported source structure still fails before provider transport.

V8 behavior remains frozen for stored V8 data and the pinned V8 diagnostic.

## Versions and compatibility

- Parse contract: `9`
- Prompt: `11`
- Cache/reservation: `12`
- Gemini wire schema: `6`

The central decoder continues to read V8, V7, V6, V5, and legacy V3 data with
their historical catalog behavior. V9 uses the corrected catalog. JSON analysis
output already carries the contract version, so no database migration or legacy
rewrite is expected. If implementation discovers a persistent schema need, work
stops for separate approval.

## Complete structural twin

The committed synthetic DOCX must preserve the observed document's structure
without private values:

- six contact lines with two blanks and two mixed pipe-delimited contact lines;
- one long summary;
- three adjacent long labelled skill groups;
- five compact pipe-header work records with twenty-one long bullets;
- two compact project header-plus-bullet records;
- three adjacent education lines: dated training header, complete 480-hour-style
  narrative, dated degree-in-subject header;
- one certification with separate issued/expiry dates, credential details, and
  narrative evidence;
- labelled achievements and an additional-information section.

The generated DOCX extracts to the exact expected private-free 83-line source.
Smaller fixtures remain responsible for absent-section behavior.

## Diagnostics and UI

Validation failures may expose only bounded, non-content diagnostics: public
error code, validation stage, canonical section, field component/path from the
closed schema, retryability, provider/billing status, and actual cost when known.
Provider output, source excerpts, credentials, and untrusted provider text are
not retained. The owner upload UI should display the safe status and cost fields
already returned by the API instead of discarding them.

## Acceptance

The complete flow is:

`DOCX extraction -> V9 catalog -> stubbed provider JSON -> validation -> route
persistence stubs -> stored decoder -> job match -> tailoring -> application
plan -> owner UI`.

Required positive cases include connector omission, source-backed overlap,
education narrative details, final-line adjacent education headers, compact
work/project/certification layouts, absent sections, grouped skills, and legacy
decoding. Required negative cases include omitted/changed/invented facts,
unknown/duplicate/reordered IDs, adjacent merges, cross-record assignment,
invalid dates, partial required projections, and unsupported ambiguous source
structure. Every synthetic source line and canonical typed fact must remain
reachable through the exact parse authority. A consumer must either preserve
that raw-source fallback or name every bounded omission/truncation with stable
IDs and counts; the application-plan projection is intentionally bounded and
must not be described as lossless.

Release readiness requires the full unit suite, typecheck, lint, build, browser
suite, independent adversarial review, and a consolidated passed/failed/untested
matrix. PostgreSQL testing is required only if persistent database behavior
changes, and then only through `npm run test:postgres`.
