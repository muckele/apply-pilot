# Resume V9 single-call diagnostic approval packet

Status: prepared and independently reviewed offline. **Not executed.** This
document does not authorize a provider request, paid parse, database write,
merge, or deployment.

## Candidate and purpose

- Implementation under test: `e712ad7829f2706b147f4b76ef49337c0d246e1b`
- Contract / prompt / cache / Gemini wire: `9 / 11 / 12 / 6`
- Purpose: one private-free provider-compatibility check of the exact 65-line
  owner-topology twin, followed by local V9 authority and consumer validation.
- It does not test the owner's genuine résumé, a private corpus, PostgreSQL,
  route persistence, production configuration, or an employer workflow.

## Exact request envelope

- Model: `gemini-3.5-flash-lite`
- Endpoint:
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`
- Method: `POST`; redirect policy: `error`; thinking level: `LOW`
- Request count: exactly one; no automatic retry
- Source: private-free V9 owner-topology-twin DOCX extraction only; the current
  fixture and packet remain uncommitted in this checkout
- Source size: 5,447 bytes / 65 lines / 46 nonblank lines
- Source SHA-256:
  `579be60d3d8e66dfd013e7cfa92a689746a4f74f811ea3c31934521f24e62799`
- Request body: 15,538 bytes
- Request SHA-256:
  `ea70c338a29242014f89eaa2b2d9b354898f262055a7746bee4862413b6237d7`
- Response schema: 2,766 bytes
- Schema SHA-256:
  `d59e1ba2ba364ddf3706fdc68922e8e1b31e492c6ee6dcbb4f40fa967d4e9db1`
- Canonical typed-projection SHA-256 (contact, work, projects, education,
  certifications; skills intentionally remain a semantic subset):
  `9b11b23902fd4680778c2e8eb68b141dd29d41e952fd4e89825d2b18267570b9`
- Maximum input: 12,000 tokens
- Maximum output: 24,000 tokens
- Maximum cost: 63,600 micros (`$0.063600`)
- Timeout: 180,000 ms
- Maximum response body: 65,536 bytes

The packet uses the repository's explicit model and registered pricing. Model
availability and provider billing are still unverified until a separately
authorized request; a rejection or transport uncertainty does not authorize a
retry.

## Offline gates already passed

- Exact source, request, schema, version, model, token, cost, byte, timeout, and
  response-size pins.
- One injected fetch and no retry.
- V9 validation of the exact six-section order, five work records, 21 work
  bullets, two projects, education record line counts `[2, 1]`, and explicit
  absence of certification, achievement, and additional source sections.
- Fixture-specific completeness checks reject omitted work bullets, project
  bullets/technologies, the 480-hour education detail, the degree credential or
  field of study, and incomplete required record cores.
- The pinned typed-projection hash also rejects count-preserving truncation to
  shorter source substrings; source-backed presence alone is not acceptance.
- Every one of the 46 nonblank source lines is reachable through server-owned
  authority.
- Application-plan, job-match, and tailoring consumer coverage.
- The separate 83-line, nine-section fixture continues to cover certification,
  achievement, additional-section, and complete-structure behavior.
- Local-interactive-only execution guard, masked credential input, bounded
  output, and no raw provider response retention.

## Required outcome for acceptance

The single request passes only if it returns HTTP success with finish reason
`STOP`, reports usage within the pinned token and cost bounds, parses under the
V9 wire schema, validates the exact ordered server record IDs and canonical
typed facts, preserves source reachability, and passes all three consumer
checks. The retained result may contain only hashes, versions, counts, safe
status, usage, and cost.

Any non-success response, timeout, uncertain transport, truncation, hash drift,
unexpected finish reason, invalid structured output, topology mismatch, or
consumer failure stops the attempt. A second request requires separate explicit
approval.

## Prepared command

After separate one-call authorization, from a clean local interactive checkout:

`scripts/run-gemini-resume-v9-diagnostic.sh`

The command must not be run in CI, Vercel, another hosted runtime, or with a
private résumé substituted for the pinned synthetic fixture.
