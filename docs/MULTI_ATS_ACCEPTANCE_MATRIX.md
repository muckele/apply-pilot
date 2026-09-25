# Apply Pilot — Multi-ATS and Delivery Acceptance Matrix

Version 2.0 | 2026-09-20
**This is a proposed tracking model, not evidence that every listed provider or client browser is supported.** No real employer form was opened in this documentation task.

The accepted generic synthetic proof originated at `d501ca2` and the Human-Submit engine is merged in the PR #11 main tree. Greenhouse, Lever, Ashby, and Workable discovery modules are discovery surfaces, not provider-form execution claims. P0.4 genuine intended submission remains unverified. See [project state](APPLY_PILOT_PROJECT_STATE.md).

## 1. Three independent compatibility dimensions

1. **ATS/application surface:** provider, exact host, form variant, locale, controls and navigation.
2. **Execution runtime:** accepted local companion versus a specifically evaluated hosted runtime/configuration.
3. **Customer client:** web shell and live viewer on a specific desktop/mobile browser and accessibility setup.

A Greenhouse trial on local Chromium does not prove Greenhouse on a hosted runtime viewed through Safari. A viewer that renders on Firefox does not prove it can access a Workday flow. A public job feed does not grant submission credentials.

## 2. Provider priority

| Provider | Strategy | Discovery baseline | Current execution claim allowed by this pack |
|---|---|---|---|
| Greenhouse | Priority hardening | Existing provider/public feed documented historically | Generic synthetic proof only; live variant evidence must be supplied |
| Lever | Priority hardening | Existing provider/public feed documented historically | No blanket live support claim |
| Ashby | Priority hardening | Existing provider/public feed documented historically | No blanket live support claim |
| Workday | Characterization first | No universal applicant write API established | Supported isolated variants only after proof; multi-step/login cases manual/out of scope |
| SmartRecruiters | Staged characterization | Public discovery differs from protected application APIs | Manual fallback until promoted by evidence |
| iCIMS | Staged characterization | Portal/customer API semantics must be checked | No automatic form support implied |
| Workable | Retain existing discovery; stage browser work by demand | Existing provider documented | No automatic execution claim |
| Generic/unknown | Permitted import plus safe inspection | User-selected or permitted source | Unknown is a valid result, not an adapter guess |

Exact service hosts must come from current authorized evidence. Do not turn older `boards.greenhouse.io` examples into an exhaustive allowlist or authorize the entire `greenhouse.io` domain. Do not treat `.includes('greenhouse')` as a trust check. Do not open real targets merely to fill this matrix.

## 3. Evidence statuses

`UNKNOWN` → `DOCS_ONLY` → `LOCAL_CHARACTERIZED` → `LIVE_INSPECTED` → `ASSISTED_TRIAL_VERIFIED` → `LIMITED_SUPPORTED`.

`BLOCKED`, `MANUAL_BY_DESIGN`, `STALE_EVIDENCE`, and `NOT_APPLICABLE` can apply per action. Never promote all actions when only inspection passed. Provider-level support badges should be generated from the actual declared variant subset and evidence date.

## 4. Record schema (conceptual, not a schema migration)

For each acceptance record preserve:

| Group | Required fields |
|---|---|
| Identity | Provider/detection confidence, exact host, sanitized form-pattern identifier, locale, form revision/fingerprint |
| Evidence | Status, observation date, fixture version, code SHA, runtime/provider configuration, review receipt |
| Authorization | Exact approved trial scope, user approval reference, permitted data and actions; no credentials |
| Structure | Top-level/iframe/shadow/custom/multi-step, native families, duplicate labels, sensitive/manual questions |
| Actions | Open, inspect, correlate, propose, review, Fill, preserve, manual handoff, human Submit, attest separately |
| Delivery | Local/hosted identity; customer OS/browser/version; viewer/control mode and limitations |
| Safety | Page-owned transmission risk, target redirects, no-submit evidence, stale-state handling, cleanup |
| Quality | Eligible field count, manual required field count, factual checks, edit burden, actual exported package version |
| Operations | Active minutes, dwell/idle time, cost ledger reference, expiry/reconnect behavior, failure class |
| Privacy | Sanitized evidence path, retention category, no raw applicant content, recording/logging configuration |

Runtime change or materially changed form behavior may invalidate relevant evidence. Do not silently copy support status to a new provider/engine.

## 5. Current field/source policy

Automatic field types remain `TEXT`, `EMAIL`, `TEL`, `URL`, `TEXTAREA`, `SELECT_ONE` with eligible reviewed proposals and current authority. The current classifier makes contact questions manual; a text field for first name is not automatic solely because TEXT is supported. Professional links and availability are possible proposable categories. Document references do not grant file upload.

Manual/excluded/unsupported cases include radio, checkbox, file upload, custom widgets, sensitive/legal decisions, many contact fields, multi-step/login/CAPTCHA flows, and iframe-owned controls according to current source. Inspect actual classifications, not a generic assumption that all such cases have identical reasons.

One permanent Fill attempt remains. Human edits and conditional fields after that point do not create another automated pass. Existing nonempty values are preserved under the accepted contract; only bounded outcome labels are persisted rather than raw employer-side values.

## 6. Synthetic fixture coverage

Cover native labels/ARIA, generated IDs, field reorder, duplicates, requiredness, professional links, availability, manual contact, document alternatives, legal/EEO, hidden tracking values, select placeholders, prefilled values, async population, replacement during input, custom widgets, frames, and stale generations.

For no-submit and transport evidence include local input/change autosave attempts, fetch/XHR/beacon or equivalent controlled traps, in-place simulated human submit and navigational confirmation. Test harness pointer/keyboard operations do not grant equivalent production agent authority. A purely local mock packet does not establish production publication or persistence behavior.

Tests/docs characterization should truthfully record current gaps. Do not ship a permanently broken normal suite or silently skip an unsafe case. Record genuine RED for a defect, keep characterization labels honest, and authorize the corresponding production repair separately.

## 7. Live evidence ladder

**Offline sources and local fixtures:** current default. No real employer or applicant data.

**Authorized public read-only inspection:** exact targets approved separately; no field changes/upload/submit; use disposable local state and sanitized structural records. Page-load traffic may still occur.

**Sanitized local reproduction:** reproduce only the material structure, not employer scripts, branding, full DOM, hidden tokens, or applicant content.

**Public synthetic Fill:** not currently authorized or required. A page may transmit a synthetic value before Submit; a test interception layer is not proof of the unmodified product's transport behavior.

**Genuine intended application:** user chooses a real job and explicitly authorizes the trial, knowing values may transmit. Approved Fill on eligible fields; user completes manual work and personally submits; attestation follows. Do not create fake applicants or duplicate live applications for testing.

**Hosted counterpart:** any real applicant hosted trial additionally requires accepted provider privacy/access/termination evidence. Local permission does not automatically authorize a new remote processor.

## 8. Proposed minimum support gate

A supported provider/form-family claim should have representative synthetic normal/adverse cases, reviewed host/source rules, at least two materially different authorized read-only examples, and one genuine intended-application trial with useful reviewed Fill and functioning human confirmation navigation. These numbers are proposed policy and not statistical certification. A narrower beta must explicitly state its limitations.

A field-fill claim is insufficient if the user cannot finish the actual application because the guard blocks submission navigation. Conversely, a manual-only successful application does not prove automated Fill. Record each capability separately.

## 9. Customer browser matrix

| Client | Web shell target | Interactive remote workspace | Release rule |
|---|---|---|---|
| Current Safari desktop | Required target | Must be tested | No extension required |
| Current Firefox desktop | Required target | Must be tested | No extension required |
| Current Chrome desktop | Required target | Must be tested | Extension optional |
| Current Edge desktop | Required target | Must be tested | Extension optional |
| iOS/mobile Safari | Responsive shell target | Unverified until keyboard/file/touch evidence | Do not advertise parity prematurely |
| Android/mobile browser | Responsive shell target | Unverified until interaction evidence | Explicit limitations/fallback |
| Internet Explorer | Outside launch target | Not planned | Show an honest supported-browser message |
| Assistive technology | Accessible shell target | Separate real task testing | Video visibility alone is not accessibility |

## 10. Usefulness and release wording

Measure active applicant minutes, package editing, eligible automation, required manual work, outcomes and support burden. A form with zero eligible proposals may be inspectable but cannot be marketed as meaningful automated application assistance without another demonstrated benefit.

Approved-style claim: “Human-reviewed assistance on the tested native-form variants listed here.” Avoid “supports every Greenhouse job,” “90 guarantees an interview,” or “works on all browsers” without evidence. Attach limitations and last verification date to support claims.
