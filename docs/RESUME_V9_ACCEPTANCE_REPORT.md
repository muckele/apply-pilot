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

## Acceptance matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Full unit/integration suite | Passed | `npm test`: 1,701/1,701 passed |
| TypeScript | Passed | `npm run typecheck` passed from clean generated state |
| Lint | Passed | `npm run lint` passed with no warnings |
| Browser suite | Passed | `npm run test:browser`: 369/369 passed |
| Focused V9 source/provider/route flow | Passed | 56/56 passed after final boundary changes |
| Independent adversarial review | Passed | No Critical/Important findings; a 65-case supported-header matrix passed against the current bytes and V8 matched base `67094ff` in every case |
| Synthetic DOCX extraction through consumers | Passed | Extraction -> stubbed provider -> V9 validation -> route persistence stubs -> stored decoding/application plan/job match/tailoring |
| Negative authority cases | Passed | Omitted/invented/reordered IDs and source, cross-record facts, adjacent merges, and unsafe diagnostics fail closed |
| Production build | Failed / pre-existing blocker | `npm run build` could not start Turbopack because the environment denied its internal bind (`EPERM`). `npx next build --webpack` compiled successfully, then Next's generated route-export checker rejected existing exported route factory helpers in unchanged routes. Clean standalone typecheck passes. |
| PostgreSQL suite | Not applicable | No Prisma schema, migration, or persistent database behavior changed; no database reset or mutation was run |
| Real provider / paid parse | Intentionally untested | Prohibited by scope; provider JSON was stubbed |
| Private resume corpus / owner's resume | Intentionally untested | Prohibited by scope; only the synthetic fixture was used |
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

The final independent verdict is ready for the next authorized step, with no
remaining Critical or Important findings.

## Remaining blocker

The repository-wide Next production build does not reach a clean completion in
this workspace for the two reasons recorded above. No changed V9 file is named
by the webpack route-export failure. This draft must not be described as having
a passing build until CI or a repository-wide route-export correction proves
that separately.
