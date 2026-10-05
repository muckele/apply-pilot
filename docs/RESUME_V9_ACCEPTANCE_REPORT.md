# Resume V9 boundary-authority acceptance report

Date: 2026-10-04

Base: `origin/main` at `67094ff27c2e83fe407d5c61d9f7b12af0aa4fa4`

Branch: `codex/resume-contract-v9-boundaries`

## Scope delivered

- V9 uses exact, ordered server-catalog section and record blocks as the
  lossless source authority. Typed fields are record-local, source-backed
  semantic projections; legitimate overlap and connector words are allowed.
- V9 preflight recognizes the supported adjacent work, project, education,
  and certification header shapes, including mixed dated/undated layouts,
  without changing the frozen V8 catalog behavior.
- Contract/prompt/cache/Gemini-wire revisions are isolated at `9/11/12/6`.
  Stored V8/V7/V6/V5/V3 decoding remains centralized and tested.
- Application-plan, job-match, and tailoring projections include the corrected
  education field of study, project bullets, certification details, structured
  references, and raw-source fallback. Bounded planner truncations and
  omissions remain explicit instead of being described as lossless.
- Validation errors expose only bounded stage/code/section/field coordinates,
  billing status, and cost. Provider output and source content are not retained
  in failure diagnostics or rendered by the owner upload UI.
- The private-free synthetic DOCX extracts to the expected 6,075 bytes and 83
  lines and covers the complete requested structural topology end to end.
- A second private-free DOCX is the exact structural topology twin for the
  owner's audited source: 65 lines, 46 nonblank lines, six ordered sections,
  three skill groups, five work records/21 bullets, two projects, and education
  record lengths `[2, 1]`. The broader 83-line fixture remains separate for
  certification, achievement, and additional-section coverage.
- The exact V9 live diagnostic is prepared but unexecuted. It is pinned to the
  reviewed implementation commit, synthetic source, request, schema, versions,
  model, one-call transport, response size, timeout, and maximum cost.

## Evidence provenance and owner-document reconciliation

The exact authorized owner DOCX was found in the local Downloads folder and
freshly re-audited without provider transport. Its identity matched the
authorized 40,241-byte file and SHA-256
`18092ea6562e744523cf22295aeb28513d8cd028480427cef49acb69d234ed0d`.
Extraction reproduced 6,489 UTF-8 bytes, 65 lines, and 46 nonblank lines. V9
produced the exact six-section order, three skill records, five work records
with bullet counts `[4, 4, 5, 3, 5]`, two two-line projects, and education
record lengths `[2, 1]`. Every nonblank line was reachable exactly once; exact
source slices, record order, non-overlap, provider-payload identity, and offline
V9 request/schema preparation all passed.

The owner bytes and extracted text remain local and uncommitted. The private-free
65-line twin reproduces the same line positions and structural cardinalities
without reproducing personal content. Its 5,447-byte source has 46 nonblank
lines and 19 blank lines. The separate 83-line fixture retains 58 nonblank lines
and all nine recognized sections so optional-section behavior remains covered.

## Acceptance matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Full unit/integration suite | Passed | `npm test`: 1,710/1,710 passed after the final diagnostic correction; the initial sandbox run's sole loopback `EPERM` disappeared under the guarded local-network rerun |
| TypeScript | Passed | `npm run typecheck` passed from clean generated state |
| Lint | Passed | `npm run lint` passed with no warnings |
| Browser suite | Passed | `npm run test:browser`: 369/369 passed |
| Focused V9 source/provider/route flow | Passed | 63/63 source-catalog, diagnostic, V9 provider, and route tests passed |
| Pinned V9 diagnostic preparation | Passed offline / not executed live | 7/7 request, injected one-call flow, permitted degree-overlap/list-marker variants, omission and count-preserving truncation rejection, and bounded CLI tests passed; no provider transport occurred |
| Exact 65-line owner topology twin | Passed | 46 nonblank facts, 19 blanks, six sections; V8 education `[3]`, V9 education `[2, 1]`, five work records/21 bullets, two projects, absent certification/achievement/additional sections, and every nonblank line reachable |
| Broader 83-line complete topology | Passed | Nine sections retain certification, achievement, and additional-section extraction and consumer coverage independently of the exact-topology diagnostic |
| Independent adversarial review | Passed | The final command-readiness correction review returned READY with 35/35 focused cases, both permitted variants, and omission/truncation/order/invention failures independently reproduced. Earlier reviews also verified all immutable request hashes, absent-section consumers, privacy/transport stops, the supported-header matrix, and unchanged broader-fixture content. |
| Synthetic DOCX extraction through consumers | Passed | Extraction -> stubbed provider -> V9 validation -> route persistence stubs -> stored decoding/application plan/job match/tailoring |
| Negative authority cases | Passed | Omitted/invented/reordered IDs and source, cross-record facts, adjacent merges, and unsafe diagnostics fail closed |
| Local production build | Failed / environment and pre-existing repository blockers | `npm run build` could not start Turbopack because the environment denied its internal bind (`EPERM`), including after an approved unsandboxed retry. `npx next build --webpack` compiled successfully, then Next's generated route-export checker rejected existing exported route factory helpers in unchanged routes. Clean standalone typecheck passes. |
| Hosted committed-candidate build | Passed | Push and pull-request GitHub Actions passed the repository's normal `npm run build` for implementation commit `e712ad7829f2706b147f4b76ef49337c0d246e1b` and the first committed diagnostic packet at `26105ef4f36efe9cfdaa8e5f145d9651e5d229a3`; every later diagnostic-only correction still requires exact-head CI before owner execution |
| PostgreSQL suite | Not applicable | No Prisma schema, migration, or persistent database behavior changed; no database reset or mutation was run |
| Real provider / paid parse | Intentionally untested | Prohibited by scope; provider JSON was stubbed |
| Owner DOCX | Fresh offline audit passed | Exact 40,241-byte/SHA-256 identity; 6,489-byte extraction, 65 lines/46 nonblank, six sections, full reachability, five work records/21 bullets, two projects, and V9 education `[2, 1]`; no provider transport or retained private extract |
| Production database write | Intentionally untested | Prohibited by scope |
| Merge / deploy / application submission | Intentionally untested | Prohibited by scope |

## Independent review resolution

The reviewer initially found adjacent-record gaps for unpunctuated work,
project, education, and certification records, a V8 certification-boundary
regression, and an overbroad consumer-losslessness claim. The final design:

- keeps V8 certification pipe-header behavior frozen;
- recognizes supported V9 next-record header alternatives only after an
  established preceding segment, with education credential discrimination;
- covers dated, undated, pipe, metadata, credential-ID, bullet, and complete
  narrative header combinations in regression matrices; and
- distinguishes lossless parse authority/full tailoring raw source from the
  intentionally bounded application-plan raw projection.

The exact-topology review initially found no application-candidate defect. A
later command-readiness review identified an over-strict diagnostic-only exact
typed-projection comparison: production-valid degree/subject overlap and a
complete bullet without its list marker were rejected. The diagnostic now uses
a narrow canonical fingerprint that normalizes those two permitted forms while
retaining omission, shortened-bullet, shortened-technology, and
count-preserving truncation rejection. The independent final correction verdict
is READY. Owner execution still requires passing exact-head CI after this
correction.

## Production identity and remaining boundaries

The canonical read-only production health check on 2026-10-04 returned HTTP 200,
environment `production`, and version `67094ff27c2e`. Readiness returned HTTP
200 with database and configuration checks `ok`; Gemini was reported as
`configured_unverified`. This supersedes the stale assumption that production
still ran `df8d104`. Deployment identity supplied for this checkpoint is
`6845321195`.

The repository-wide Next production build still does not complete locally for
the two reasons recorded above, and no changed V9 file is named by the webpack
route-export failure. Exact-head hosted CI separately proves that the normal
build passes on its runner.

No live V9 provider response, paid request, or production database write has
occurred. Provider availability, real structured-output compatibility, actual
usage/cost, and database persistence against production remain unverified. The
diagnostic wrapper is an approval packet, not authorization to execute it. See
`docs/RESUME_V9_LIVE_DIAGNOSTIC_PACKET.md`.
