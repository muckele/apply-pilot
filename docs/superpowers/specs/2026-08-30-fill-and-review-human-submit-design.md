# Human-Submit Fill and Review Design

Status: Human-approved architecture, awaiting implementation planning

Date: 2026-08-30

Repository checkpoint: `574627c73e9a6fec0a470e0e82f0fa470214fc60` (`Present browser inspection answer packets`)

## 1. Purpose

This document specifies the lean Human-Submit MVP extension to Apply Pilot's existing controlled application workflow. The feature lets an authenticated user review a current answer packet, ask the local browser companion to fill a deliberately small set of approved employer-form controls, inspect the resulting employer page, and personally submit the application.

The design preserves the current owner-session, policy, packet-review, browser-generation, and exact-handle boundaries. It introduces bounded employer-field writes but no Apply Pilot submission capability.

The architecture is frozen for this specification. Implementation must follow the decisions below without reopening them.

## 2. Frozen decisions

The following decisions are normative:

- `APPLICATION_FILL REQUIRED: NO`
- `FILL AUTHORITY HASH REQUIRED: NO`
- `DEDICATED FILL ATTEMPT MODEL REQUIRED: NO`
- `REVIEW AUTHORITY IMMUTABLE AFTER READY: YES`
- `DOM-WRITE SPIKE REQUIRED: YES`
- `ONE AUTOMATED FILL ATTEMPT PER RUN`
- Default automation mode: `PREPARE_ONLY`
- New opt-in automation mode: `FILL_AND_REVIEW`
- `ApplicationRun.fillAttemptId String?` is the permanent per-run consumption fence.
- `ApplicationRun.fillLeaseExpiresAt DateTime?` is the active-attempt lease deadline.
- Existing `ApplicationRunStep` stores closed, privacy-safe field outcomes.
- There is no dedicated fill-attempt model.
- There is no fill token.
- Existing `APPLICATION_READ` behavior is unchanged.
- There is no `fillAuthorityHash`.
- There is no fill-result JSON column.
- There is no generic document upload.
- There is no ATS application-form adapter in the lean MVP.
- There is no direct refill.
- There is no indirect refill.
- After `fillAttemptId` has ever been assigned, the same `ApplicationRun` can never acquire another automated fill attempt.

`APPLICATION_FILL` remains in the execution-scope enum but stays dormant and unissuable. A future delegated worker architecture may reconsider that scope, but the authenticated owner-session companion does not need a token minted and consumed by the same authority.

## 3. Goals and non-goals

### Goals

- Make the existing server-side answer-review authority reachable from the authenticated browser-control page.
- Acquire exactly one automated fill opportunity for an eligible `ApplicationRun`.
- Reverify current positive-version packet authority transactionally before acquisition.
- Fill only spike-approved controls through exact current-generation handles.
- Preserve every occupied value or selection.
- Keep raw employer current values page-local.
- Persist only closed safe field results.
- Stop safely on policy, currentness, target, event, or write failure.
- End every acquired non-cancelled attempt in `READY_FOR_USER_SUBMISSION`.
- Require an exact user attestation before completion.

### Non-goals

- Automated submission.
- More than one automated fill attempt per run.
- Fill tokens or delegated worker authority.
- Generic document upload.
- ATS-specific application-form adapters.
- Custom widgets, contenteditable, rich text, or multi-step application flows.
- Employer login automation or CAPTCHA handling.
- Confirmation-page or receipt detection.
- Cross-browser support.
- Post-MVP telemetry.

## 4. Authority and trust model

Fill authority is the conjunction of:

```text
authenticated owner session
+ APPLICATION_AUTOMATION_ENABLED === "true"
+ locked current per-user automation policy
+ policy.mode === FILL_AND_REVIEW
+ canonical allowed and non-prohibited host
+ owned ApplicationRun
+ run.state === READY
+ run.fillAttemptId === null
+ exact expected run.stateVersion
+ positive current inspection version
+ verified normalized inspection and form fingerprint
+ positive current answer-packet version
+ verified current packet hash
+ immutable packet.reviewedAt
+ readyForRunResolution
+ verified approved answer rows and canonical proposal hashes
+ ApplicationRun FOR UPDATE
+ newly generated fillAttemptId
+ live ten-minute fill lease
+ accepted live browser generation
+ unchanged applicant-event fence
+ exact correlated field and choice handles
```

PostgreSQL is authoritative for policy, packet review, run state, attempt consumption, lease, and durable results. The authenticated Apply Pilot control route initiates review and fill operations. The companion's Node process temporarily holds minimum fill material. The employer document is untrusted. The browser binding carries a no-payload command and closed status only.

`fillAttemptId` is not a bearer credential. It is both:

1. the exact active-attempt correlation identifier while the run is `FILLING`; and
2. permanent historical proof that the run's single automated fill opportunity has been consumed.

## 5. Minimal schema and migration

The conceptual Prisma delta is:

```prisma
enum AutomationMode {
  PREPARE_ONLY
  FILL_AND_REVIEW
}

model ApplicationRun {
  // Existing fields remain unchanged.
  fillAttemptId      String?
  fillLeaseExpiresAt DateTime?
}
```

The policy default remains `PREPARE_ONLY`. Migration alone grants no fill capability.

No other schema addition is authorized. In particular, implementation must not add:

- `fillAuthorityHash`;
- a fill-attempt model;
- fill token fields;
- fill-result JSON;
- new execution scopes;
- `SUBMITTING` or `SUBMITTED` states;
- proposal or employer-current-value persistence.

No new index is required. Attempt access is through the owned run ID, and `ApplicationRun` is the serialization point.

## 6. One automated fill attempt per run

The product fence is literal:

```text
ONE AUTOMATED FILL ATTEMPT PER RUN
```

Fill acquisition requires both:

```text
run.state === READY
AND
run.fillAttemptId === null
```

`READY` is necessary but not sufficient.

The acquisition transaction assigns `fillAttemptId` once. It is never cleared or replaced. It remains set after:

- successful completion;
- partial or failed fill;
- expired-lease recovery;
- cancellation after acquisition;
- material reinspection;
- fresh answer review;
- `COMPLETED_BY_USER`.

A previously filled run never returns to `READY` through fresh review. Post-fill review resolution returns it to `READY_FOR_USER_SUBMISSION`, where the user retains manual review and personal-submission authority. The control page must not present `Fill approved fields`, and the backend must reject a direct invocation because `fillAttemptId !== null`.

Any future refill capability requires a separate post-MVP architecture and security review.

## 7. Run-state semantics

The fill-related graph is:

```text
READY
  -> FILLING

FILLING
  -> READY_FOR_USER_SUBMISSION
  -> CANCELLED

READY_FOR_USER_SUBMISSION
  -> REVIEW_REQUIRED
     only after material reinspection publishes a new packet
  -> COMPLETED_BY_USER
  -> CANCELLED

REVIEW_REQUIRED
  -> READY
     through review resolution only when fillAttemptId === null
  -> READY_FOR_USER_SUBMISSION
     through review resolution only when fillAttemptId !== null
```

Critical acquisition predicate:

```text
READY + fillAttemptId === null
  -> eligible to acquire the run's single automated fill attempt

READY + fillAttemptId !== null
  -> not eligible for automated fill
```

Exact reinspection replay from `READY_FOR_USER_SUBMISSION` remains in `READY_FOR_USER_SUBMISSION`. It does not increment the run version, restore `READY`, or restore fill eligibility.

Pre-fill review resolution is:

```text
REVIEW_REQUIRED + fillAttemptId === null
  -> READY
```

Post-fill material reinspection and fresh review are:

```text
READY_FOR_USER_SUBMISSION
  -> REVIEW_REQUIRED

REVIEW_REQUIRED + fillAttemptId !== null
  -> READY_FOR_USER_SUBMISSION
```

The post-fill path restores manual review and personal-submission reachability without restoring automated fill. The user completes remaining fields manually and can later attest completion from `READY_FOR_USER_SUBMISSION`.

Once `READY -> FILLING` commits, every completed, partial, failed, or lost attempt ends in `READY_FOR_USER_SUBMISSION` unless cancellation wins. There is no `FILLING -> READY` edge and no general `READY_FOR_USER_SUBMISSION -> READY` edge.

## 8. Review authority and review UI

`REVIEW AUTHORITY IMMUTABLE AFTER READY: YES`

A positive-version packet can authorize fill only after the existing review-resolution transaction:

- verifies the exact current packet and packet hash;
- verifies `readyForRunResolution`;
- sets `packet.reviewedAt` once with a null guard;
- transitions pre-fill `REVIEW_REQUIRED -> READY` only when `fillAttemptId === null`;
- transitions post-fill `REVIEW_REQUIRED -> READY_FOR_USER_SUBMISSION` only when `fillAttemptId !== null`;
- increments the run state version.

Fill-authorizing answer rows cannot drift after resolution. Review mutation is `PENDING`-only, approved or rejected rows cannot be changed, and no pending proposable answer remains when resolution succeeds. Fill start rechecks every approved canonical proposal and hash under the locked run.

Version-zero legacy answers cannot authorize fill. Fill requires positive current inspection and packet versions.

The first implementation increment adds these actions to the authenticated browser-control page:

- `Approve`
- `Reject`
- `Resolve review`

They use the existing same-origin routes:

```text
POST /api/application-runs/[id]/answers/[answerId]/review
POST /api/application-runs/[id]/resolve-review
```

Approve and Reject controls appear only when both:

```text
answer.status === PENDING
AND
answer.disposition === PROPOSABLE
```

`MANUAL_ONLY`, `EXCLUDED`, and `UNSUPPORTED` answers expose no approve/reject mutation controls. The backend independently enforces review semantics and remains authoritative.

The UI treats server responses as authoritative, refreshes the packet after mutation, fails closed on stale or malformed responses, and disables duplicate in-flight actions. No review authority, packet content, answer ID, or proposal enters the browser binding. No employer write exists in this increment.

## 9. Mandatory DOM-write spike

`DOM-WRITE SPIKE REQUIRED: YES`

The spike is throwaway evidence work outside the repository in a `mktemp` directory under `/private/tmp`. It uses installed Playwright and React. No spike file is committed, and the spike performs no application API mutation or submit action.

Required fixtures:

- plain HTML text input;
- React-controlled text input;
- React-controlled textarea;
- React-controlled checkbox;
- React-controlled radio group;
- React-controlled select;
- synchronous rerender or element replacement on input;
- normalization or rejection;
- pre-existing user value;
- unrelated input/change event.

Candidate comparisons are separate by family.

Text-like:

```text
ElementHandle.fill()
versus
native prototype value setter + bounded synthetic event sequence
```

`SELECT_ONE`:

```text
selectOption() with the exact correlated option ElementHandle
versus
exact option native selected setters + bounded input/change events
```

Radio:

```text
check()
versus
native checked setter + bounded input/change events
```

Boolean checkbox:

```text
check()/uncheck()
versus
native checked setter + bounded input/change events
```

The spike measures:

- event order, count, and exact target;
- `event.isTrusted` as observation only;
- framework state after rerender;
- DOM persistence;
- handle detachment;
- semantic generation change;
- applicant-event behavior;
- preservation of occupied values;
- navigation, popup, and network effects;
- ability to return only closed equality facts.

A control family is approved only if its strategy preserves occupied values, keeps framework state and DOM aligned after rerender, identifies normalization/rejection as mismatch, supports a bounded owned-mutation window, detects unrelated activity and detachment, produces no submit/navigation action, and exports no raw current value.

Evidence from one family cannot authorize another. A failing family is deferred. Production writer mechanics remain undecided until the spike is complete.

## 10. Lean control matrix

Candidate after family-specific spike evidence:

- `TEXT`
- `EMAIL`
- `TEL`
- `URL`
- `TEXTAREA`
- `SELECT_ONE`

Conditional on family-specific evidence:

- `RADIO_GROUP`
- `CHECKBOX_BOOLEAN`

Deferred:

- `NUMBER`
- `DATE`
- `SELECT_MANY`
- `CHECKBOX_GROUP`
- `FILE_UPLOAD`
- `DOCUMENT_REFERENCE` upload
- custom widgets
- contenteditable
- rich text
- multi-step navigation
- ATS-specific controls

Weak radio or Boolean-checkbox evidence defers those controls without delaying text/select support.

## 11. Fill-attempt resource

One route family is added:

```text
/api/application-runs/[id]/fill-attempt
```

### 11.1 POST: acquire and start

POST accepts a strict body containing the expected run state version. In one transaction it:

1. authenticates the owner;
2. validates the exact run path;
3. requires `APPLICATION_AUTOMATION_ENABLED === "true"`;
4. locks current policy in the established order;
5. locks the owned `ApplicationRun` with `FOR UPDATE`;
6. verifies the owner/application/job graph;
7. requires policy enabled and mode `FILL_AND_REVIEW`;
8. requires canonical host allowance and blocked/prohibited denial;
9. requires sensitive-answer policy `EXCLUDE`;
10. requires final review;
11. requires `run.state === READY`;
12. requires `run.fillAttemptId === null`;
13. requires the exact expected `stateVersion`;
14. requires positive current inspection and packet versions;
15. verifies normalized inspection and form fingerprint;
16. verifies current packet linkage and packet hash;
17. requires non-null packet `reviewedAt`;
18. requires `readyForRunResolution`;
19. requires zero pending proposable answers;
20. reverifies approved answer review fields, canonical hashes, proposal compatibility, and field fingerprints;
21. selects only spike-approved eligible material;
22. requires `eligibleFields.length >= 1`;
23. generates one `fillAttemptId`;
24. assigns a ten-minute lease;
25. transitions `READY -> FILLING`;
26. increments `stateVersion`;
27. creates bounded `ApplicationRunStep` rows;
28. writes a privacy-safe audit;
29. returns minimum fill material.

Any failure before acquisition leaves the run in `READY`, with `fillAttemptId === null` and no steps. Once assigned, `fillAttemptId` is retained permanently and is never overwritten by a later attempt.

If no approved spike-supported field is eligible, POST fails with the closed error `FILL_NO_ELIGIBLE_FIELDS` before assigning an attempt ID or lease, changing state, creating steps, or writing an acquisition audit. Specifically:

```text
run.state remains READY
run.fillAttemptId remains null
run.fillLeaseExpiresAt remains null
no ApplicationRunStep is created
no acquisition audit is created
the run's one automated fill opportunity remains unconsumed
```

Minimum fill material contains:

```text
attemptId
runStateVersion
leaseExpiresAt
formInspectionVersion
answerPacketVersion
packetHash
formFingerprint
eligible fields:
  normalizedFieldKey
  fieldFingerprint
  fieldType
  canonical proposal
```

It excludes questions, classifications, confidence, provenance, evidence, review timestamps, reviewer flags, document metadata, non-eligible answers, selectors, raw option values, and employer current values.

If POST commits but its response is lost, the client does not repeat acquisition or retrieve proposal material through GET. The existing `FILLING` run either finalizes normally or, after server-observed expiry, is explicitly recovered through PATCH to `READY_FOR_USER_SUBMISSION`.

### 11.2 GET: strictly read-only safe status

GET is strictly read only. It returns only:

- exact current run state and state version;
- attempt identity;
- lease deadline;
- whether the lease is live;
- whether the server observes that expired recovery is required;
- closed step results;
- closed attempt outcome and error information.

GET never returns proposals or employer current values. It may tell an active companion that policy or state no longer permits another field operation.

GET must not:

- transition run state;
- increment `stateVersion`;
- update steps;
- clear the lease;
- write an audit;
- reconcile expiry or perform any other database mutation.

### 11.3 PATCH: finalization or expired recovery

PATCH is a strict discriminated mutation contract.

Normal finalization:

```json
{
  "action": "FINALIZE",
  "fillAttemptId": "exact-attempt-id",
  "expectedStateVersion": 12,
  "outcome": "COMPLETED",
  "steps": [
    {
      "stepKey": "fill:exact-attempt-id:normalized-field-key",
      "result": "FILLED",
      "errorCode": null
    }
  ]
}
```

`outcome` is `COMPLETED` or `STOPPED_EARLY`. The request supplies the exact persisted attempt step-key set with closed field results and errors. The server locks the owned run and requires exact route identity, `state === FILLING`, attempt ID, state version, and a live lease.

Expired recovery:

```json
{
  "action": "RECOVER_EXPIRED",
  "fillAttemptId": "exact-attempt-id",
  "expectedStateVersion": 12
}
```

The client supplies no field-change assertions. Under the run lock, the server independently requires:

```text
state === FILLING
exact fillAttemptId
exact stateVersion
fillLeaseExpiresAt !== null
database time >= fillLeaseExpiresAt
```

Only then may the server transition to `READY_FOR_USER_SUBMISSION`, increment state version, clear `fillLeaseExpiresAt`, retain `fillAttemptId`, conservatively terminalize unresolved steps, record `RECOVERED_AFTER_LOSS`, and write the bounded audit. If the lease remains live, `RECOVER_EXPIRED` fails closed without mutation.

`FINALIZE` rejects duplicate, missing, extra, or malformed steps. `RECOVER_EXPIRED` accepts no client step assertions. Normal finalization transitions `FILLING -> READY_FOR_USER_SUBMISSION`, increments state version, clears the lease, and retains `fillAttemptId`.

Policy shutdown prevents future field writes but must not prevent safe finalization, because finalization relinquishes rather than grants authority.

There are no separate authorization, token-consumption, latest-material, or finalize endpoint families.

## 12. Lease and recovery

The fill lease is exactly ten minutes:

```text
FILL_LEASE_MS = 600_000
```

It is computed from database time and cannot be renewed. No background sweeper is added.

Before every field, the coordinator checks the known deadline and confirms that current authenticated status still identifies the exact run, `FILLING` state, state version, attempt ID, live lease, and effective permission. An operation that already began under live authority may finish; expiry, cancellation, or policy shutdown prevents the next field from starting.

Expired recovery is:

```text
FILLING -> READY_FOR_USER_SUBMISSION
```

Never `READY`.

GET may report that the server observes recovery is required, but GET performs no mutation. The authenticated control page or coordinator must then explicitly invoke PATCH with `action: "RECOVER_EXPIRED"`.

PATCH recovery independently proves expiry from database time. It increments state version, clears the lease, retains `fillAttemptId`, records `RECOVERED_AFTER_LOSS`, and writes one safe audit. Unresolved steps become failed/unverified with `FILL_STALE`; the UI tells the user to inspect all employer fields. Recovery never grants another automated fill.

## 13. Exact handles and production writer boundary

The writer continues the existing generation-bound correlation model:

```text
normalizedFieldKey -> exact current-generation field ElementHandle
optionKey -> exact current-generation choice ElementHandle
```

Selectors, XPath, DOM-path reconstruction, raw option-value replay, serialized handles, and cross-generation handle reuse are forbidden.

The accepted generation owns the normalized inspection, form fingerprint, inspection version, applicant-event epoch, and exact field/choice handles. The coordinator proves currentness before acquisition and again before the first write.

Per field, the spike-approved writer:

1. checks lease and authenticated attempt authority;
2. checks target ownership and generation currentness;
3. checks the applicant-event fence;
4. resolves the exact correlated field and choice handles;
5. classifies the current value page-locally;
6. preserves an occupied control without writing;
7. opens one bounded owned-mutation window for an empty eligible control;
8. performs exactly one typed operation;
9. validates the event window;
10. verifies only a closed post-write equality result;
11. stops on unexpected activity, mismatch, invalidity, detachment, or generation loss;
12. marks later untouched fields `NOT_ATTEMPTED`;
13. finalizes once.

There is no automatic retry, selector fallback, corrective second write, or refill.

## 14. Current-value privacy

Raw employer current values remain page-local.

Permitted pre-write facts:

```text
EMPTY
OCCUPIED
INVALID
DETACHED
```

Permitted post-write facts:

```text
MATCHED
MISMATCHED
INVALID
DETACHED
```

Text-like controls ask only whether the current value is empty. Any nonempty value is preserved. Post-write comparison uses the approved proposal inside page evaluation and returns only a closed match result. Any real `SELECT_ONE` or radio selection is occupied. Boolean checkbox behavior uses only checked state, the approved Boolean, and the applicant-event fence.

No raw current value may cross through:

- Node results;
- binding;
- status;
- API;
- database;
- steps;
- logs;
- audits;
- events;
- errors;
- diagnostics.

## 15. User-edit preservation and event attribution

The design states literally:

```text
NEVER OVERWRITE AN OCCUPIED VALUE OR EXISTING SELECTION.
```

There is no force overwrite, ownership inference, corrective second write, direct refill, indirect second fill, or browser-session replay.

Any applicant input/change after the accepted inspection invalidates fill start. During one writer operation, a page-local owned-mutation window stores only exact target identity, allowed event types, bounded expected event counts, observed counts, and an unexpected-event flag. It stores no values.

Only the spike-proven event footprint on the exact target is accounted as owned. Another target, wrong type, extra event, or event outside the window is unexpected and stops the attempt before the next field. Global observation is never disabled. `event.isTrusted` is observation only and never proof of human or Apply Pilot authority.

## 16. ApplicationRunStep convention

Each eligible field uses:

```text
action = FILL_FIELD
stepKey = fill:<fillAttemptId>:<normalizedFieldKey>
attemptNumber = 1
sequence = canonical eligible-field order
adapter = null
artifactReference = null
```

Allowed safe result literals only:

```text
FILLED
PRESERVED_EXISTING
MANUAL
FAILED
NOT_ATTEMPTED
```

Result mapping uses existing fields:

| Result | Step status | `redactedValueSummary` | Error |
|---|---|---|---|
| `FILLED` | `SUCCEEDED` | `FILLED` | `null` |
| `PRESERVED_EXISTING` | `SKIPPED` | `PRESERVED_EXISTING` | `null` |
| `MANUAL` | `SKIPPED` | `MANUAL` | `null` |
| `FAILED` | `FAILED` | `FAILED` | one closed fill error |
| `NOT_ATTEMPTED` | `SKIPPED` | `NOT_ATTEMPTED` | stopping error or `null` |

`redactedValueSummary` contains only those closed literals and no free-form text. Steps contain no proposal, current value, selector, raw option value, private question text, evidence, provenance, page detail, or arbitrary exception.

Attempt outcomes are:

```text
COMPLETED
STOPPED_EARLY
RECOVERED_AFTER_LOSS
```

Minimal closed errors are:

```text
FILL_POLICY_DENIED
FILL_REVIEW_REQUIRED
FILL_ALREADY_IN_PROGRESS
FILL_NO_ELIGIBLE_FIELDS
FILL_STALE
FILL_TARGET_TRUST_LOST
FILL_UNEXPECTED_MUTATION
FILL_WRITE_FAILED
FILL_INTERNAL
```

## 17. Binding and coordinator contract

The new exact command is:

```json
{ "type": "FILL_APPROVED_FIELDS" }
```

It has no payload. The parser rejects answers, proposals, versions, packet hashes, attempt IDs, tokens, selectors, URLs, overwrite flags, submit options, and unknown keys.

Conceptual flow:

```text
user clicks Fill approved fields
-> exact trusted control route invokes no-payload binding
-> coordinator excludes Inspect/Fill overlap
-> coordinator proves target and accepted generation
-> POST fill-attempt acquires the run's single fill opportunity
-> backend returns minimum material
-> writer executes canonical eligible fields
-> coordinator stops on policy/currentness/event/write failure
-> PATCH persists closed results
-> backend enters READY_FOR_USER_SUBMISSION
-> control page presents safe results
-> user reviews the employer page and personally submits
```

Binding status is limited to in-progress, completed attempt outcome, reinspection/stale failure, and a safe closed error. Field results are read from authenticated GET, not transported through the binding. Packet content and fill material never enter binding input or output.

## 18. Reinspection after fill

`READY_FOR_USER_SUBMISSION` permits inspection.

Exact replay:

- remains `READY_FOR_USER_SUBMISSION`;
- publishes no new packet;
- does not increment state version;
- does not restore fill eligibility.

Material reinspection:

- publishes a new inspection and packet;
- transitions `READY_FOR_USER_SUBMISSION -> REVIEW_REQUIRED`;
- increments state version;
- requires fresh review.

For a previously filled run, successful fresh review requires `fillAttemptId !== null` and transitions:

```text
REVIEW_REQUIRED -> READY_FOR_USER_SUBMISSION
```

It does not transition the run to `READY`. The user handles remaining employer fields manually and retains the completion-attestation path:

```text
READY_FOR_USER_SUBMISSION -> COMPLETED_BY_USER
```

The control page and backend both enforce this fence:

```text
pre-fill review resolution:
  REVIEW_REQUIRED + fillAttemptId === null -> READY

post-fill review resolution:
  REVIEW_REQUIRED + fillAttemptId !== null -> READY_FOR_USER_SUBMISSION

fill acquisition:
  state === READY && fillAttemptId === null
```

No path in this design clears or replaces `fillAttemptId`.

## 19. Completed-by-user attestation

Endpoint:

```text
POST /api/application-runs/[id]/complete-by-user
```

Exact strict body:

```json
{
  "attestation": "USER_PERSONALLY_SUBMITTED_ON_EMPLOYER_SITE"
}
```

The minimum transaction:

1. authenticates the owner;
2. locks the owned run;
3. requires `READY_FOR_USER_SUBMISSION`;
4. requires the exact attestation literal;
5. transitions to `COMPLETED_BY_USER`;
6. increments `stateVersion`;
7. sets `completedAt`;
8. clears `activeRunKey`;
9. clears `fillLeaseExpiresAt`;
10. retains `fillAttemptId`;
11. updates the owning `Application` to `APPLIED`;
12. sets `dateApplied` if absent;
13. writes one audit;
14. writes one application timeline event.

It does not update `JobPosting`, create CRM follow-up, create a next action, inspect the employer page, detect confirmation, infer a receipt, or claim Apply Pilot submitted.

## 20. Policy and adapter boundary

Fill requires:

```text
APPLICATION_AUTOMATION_ENABLED === "true"
policy.enabled === true
policy.mode === FILL_AND_REVIEW
canonical host allowed
canonical host not blocked or prohibited
sensitiveAnswerPolicy === EXCLUDE
finalReviewRequired === true
```

Empty allowed hosts denies fill. Blocked or prohibited hosts win. `generic-native` is not added to `permittedAdapters`; the generic writer is core behavior, not an ATS adapter.

Discovery connectors are not form adapters. A future form adapter may implement the typed writer boundary but may not weaken backend review, policy, host, run-state, one-attempt, generation, privacy, occupied-value, lease, or no-submit invariants.

## 21. Concurrency semantics

- Two fill starts serialize on `ApplicationRun`; the first assigns `fillAttemptId` and enters `FILLING`, and the second fails.
- Any later fill invocation fails because `fillAttemptId !== null`; post-fill fresh review returns the run to `READY_FOR_USER_SUBMISSION`, not `READY`.
- Fill and answer review serialize through the run lock and immutable row guards.
- Review resolution chooses `READY` only for a pre-fill run with `fillAttemptId === null`; it chooses `READY_FOR_USER_SUBMISSION` for a post-fill run with `fillAttemptId !== null`.
- Exact packet replay may finish without changing authority; material publication cannot overlap `FILLING`.
- Fill and Inspect are mutually exclusive in the coordinator, and backend publication rejects `FILLING`.
- Cancellation before acquisition prevents it. Cancellation after acquisition prevents future fields at the next authority checkpoint and retains `fillAttemptId`.
- Policy mutation follows existing lock order. Disablement prevents future fields but not safe finalization.
- Browser loss may cause the lease to expire. Read-only GET reports recovery required, and exact `RECOVER_EXPIRED` PATCH performs the transition to `READY_FOR_USER_SUBMISSION` while retaining `fillAttemptId`.
- Finalize and cancel have one serialized winner; neither can restore fill eligibility.
- Material reinspection and completion have one serialized winner.

An operation already begun under live authority may finish. Cancellation, policy shutdown, or lease expiry prevents subsequent field operations at the next checkpoint.

## 22. Threat-model reconciliation

- Review authority cannot drift because approved/rejected rows are immutable and fill start reverifies them.
- Version-zero authority cannot fill.
- An expired lease cannot renew or return the run to `READY`.
- GET fill-attempt is read only and cannot reconcile expiry or mutate any persisted state.
- Expired recovery requires an explicit `RECOVER_EXPIRED` PATCH and independent database-time proof.
- Exact replay cannot restore fill eligibility.
- Post-fill material reinspection and fresh review return to `READY_FOR_USER_SUBMISSION`, preserving both completion reachability and the permanent one-fill fence.
- Zero eligible fields cannot consume the one-fill opportunity because eligibility is checked before attempt ID, lease, state, steps, or audit mutation.
- Raw current values never leave page evaluation.
- Packet contents and proposals never enter the binding.
- Steps never reveal proposals or current values.
- Employer JavaScript cannot obtain an Apply Pilot fill token because none exists.
- Origin isolation and control-page-only binding prevent employer JavaScript from obtaining owner-session request authority.
- The run lock and permanent attempt fence prevent concurrent and sequential second fills.
- Fill and Inspect cannot overlap.
- Completion requires exact user attestation.
- Apply Pilot has no submission command, scope, state, endpoint, or writer method.

Employer JavaScript can observe its own DOM and may react to input events. The host allowlist, bounded control matrix, exact handles, one-operation windows, stop behavior, and human review limit that residual risk. The design does not claim to prevent arbitrary employer-page reactions.

## 23. No-submit invariant

The following block is normative and verbatim:

```text
NO SUBMIT COMMAND

NO SUBMIT SCOPE

NO requestSubmit()

NO form.submit()

NO Apply Pilot submit-control click

NO CAPTCHA BYPASS

NO employer login automation

NO submission detection as authority

USER PERSONALLY SUBMITS.
```

There is no `SUBMITTING` state, `SUBMITTED` state, Enter-key submit path, generic click primitive, submit backend route, or automatic completion from employer DOM/network behavior. A submit observer is not a security guarantee and is omitted unless the spike demonstrates a narrowly bounded defense-in-depth benefit.

## 24. Implementation increments

Implementation is test-first and proceeds in this exact order.

### Increment 1: Review UI reachability — 10–14 hours

Goal: expose Approve, Reject, and Resolve review on the authenticated control page using existing backend routes. No binding review content and no employer write.

Primary scope:

- modify `components/application-browser-control.tsx`;
- modify `lib/application-browser/control-presentation.ts`;
- extend `tests/application-browser-control-presentation.test.ts`.

RED cases cover exact packet/version requests, Approve/Reject visibility only for `PENDING + PROPOSABLE` answers, absence of mutation controls for `MANUAL_ONLY`/`EXCLUDED`/`UNSUPPORTED`, stale and malformed responses, duplicate suppression, unmount safety, packet refresh, resolve readiness, and absence of binding content.

Completion requires unit/UI/type/lint success with no employer-write implementation.

### Increment 2: Throwaway DOM-write spike — 10–16 hours

Goal: obtain family-specific evidence outside the repository.

The spike uses only a fresh directory created by `mktemp -d` under `/private/tmp`. Repository paths remain read-only. RED assertions cover controlled rerender, normalization, occupied preservation, bounded events, unrelated activity, detachment, side effects, and closed outputs.

Completion requires a family evidence matrix and an unchanged repository.

### Increment 3: Lean policy/state/schema/fill-attempt backend — 28–42 hours

Goal: add the minimal migration, permanent one-attempt fence, fill resource, read-only status, explicit PATCH recovery, conditional review-resolution state edges, and material reinspection behavior.

Likely create:

- `prisma/migrations/20260830120000_add_fill_and_review/migration.sql`;
- `lib/application-runs/fill-attempt.ts`;
- `app/api/application-runs/[id]/fill-attempt/route.ts`;
- unit, route, migration, and PostgreSQL fill-attempt tests.

Likely modify:

- `prisma/schema.prisma`;
- application-run policy, contracts, state machine, service, and answer-packet service;
- existing state, policy, packet, and concurrency tests.

Execution-token files and `APPLICATION_READ` semantics remain read-only.

RED cases include every policy/review/version/hash gate, `fillAttemptId === null`, simultaneous starts, zero eligible fields returning `FILL_NO_ELIGIBLE_FIELDS` without any attempt/lease/state/step/audit mutation, lost-response behavior, strictly read-only GET, live-lease rejection of `RECOVER_EXPIRED`, database-time expired recovery through PATCH, exact FINALIZE step sets, policy-disable finalization, pre-fill review resolution to `READY`, post-fill review resolution to `READY_FOR_USER_SUBMISSION`, replay/material state behavior, and privacy-safe persistence.

Completion requires migration, unit, route, and real PostgreSQL race suites.

### Increment 4: Lean generation-bound typed writer — 18–30 hours

Goal: implement only spike-approved control families against exact current-generation handles.

Likely create typed DOM/writer modules and unit/Chromium fixtures. Likely modify the inspection controller and correlation boundary without adding selectors.

RED cases cover occupied preservation, one mutation, exact choice handles, applicant-event invalidation, mismatch without correction, detachment, expiry, closed errors, current-value privacy, and absence of submit primitives.

Completion requires family-specific unit and Chromium success. Failed families remain unrepresentable as eligible material.

### Increment 5: Coordinator/companion integration — 12–18 hours

Goal: connect the exact no-payload command to authenticated acquisition, per-field authority checks, the typed writer, and finalization.

Likely modify browser types, coordinator, same-origin client, control bridge, companion script, control component, presentation model, and their tests.

RED cases cover strict command shape, frame trust, Fill/Inspect exclusion, duplicate Fill exclusion, generation/epoch checks, material mismatch, per-field cancellation/policy fencing, lost response behavior, closed binding status, target loss, and no automatic retry.

Completion requires coordinator unit and integrated Chromium smoke tests.

### Increment 6: Result UI and completed-by-user — 10–16 hours

Goal: present closed results and add exact human completion attestation.

Likely create the completion route, completion service, and tests. Likely modify contracts, state machine, control UI, presentation model, and concurrency tests.

RED cases cover safe result rendering, recovery-required status without GET mutation, explicit recovery action, no value disclosure, strict attestation, exact state/ownership, duplicate completion, post-fill material reinspection and fresh review returning to `READY_FOR_USER_SUBMISSION`, subsequent completion reachability, material-reinspection race, Application update, one audit/event, and absence of unrelated downstream mutations.

Completion requires unit, route, component, and PostgreSQL success.

### Increment 7: Integrated Chromium/PostgreSQL proof and docs — 8–14 hours

Goal: prove the complete Human-Submit workflow and document only verified behavior.

Likely create integrated Chromium and PostgreSQL tests. Likely update `README.md`, `docs/CONTROLLED_APPLICATION_AUTOMATION.md`, `docs/APPLICATION_BROWSER_COMPANION.md`, and browser fixtures.

RED cases cover review-before-fill, one automated attempt, zero-eligible non-consumption, occupied preservation, applicant-event invalidation, read-only recovery status, explicit PATCH crash recovery, exact replay, post-fill material reinspection and fresh review returning to `READY_FOR_USER_SUBMISSION` without fill restoration, human attestation, no submission path, privacy, and the lock-race matrix.

Completion requires unit, browser, PostgreSQL, typecheck, lint, build, and diff-check success.

## 25. Engineering estimate

| Increment | Estimate |
|---|---:|
| Review UI reachability | 10–14 hours |
| Throwaway DOM-write spike | 10–16 hours |
| Lean policy/state/schema/fill-attempt backend | 28–42 hours |
| Lean generation-bound typed writer | 18–30 hours |
| Coordinator/companion integration | 12–18 hours |
| Result UI and completed-by-user | 10–16 hours |
| Integrated Chromium/PostgreSQL proof and docs | 8–14 hours |
| **Total** | **96–150 hours** |

Planning number: **124 hours**

Likely range: **110–138 hours**

Contingency ceiling: **150 hours**

The largest uncertainty is the DOM-write spike, especially framework-controlled rerender, handle detachment, and event behavior.

The estimate excludes ATS adapters, file upload, custom widgets, contenteditable, multi-step navigation, cross-browser support, post-MVP telemetry, employer login, and automated submission.

## 26. Remaining human decisions

Exactly two implementation-time human decisions remain:

1. Select the exact canonical employer hosts for the first allowlisted rollout.
2. If both radio/checkbox strategies pass, decide whether exact-control Playwright click semantics are acceptable; otherwise defer those families.

No additional architecture question is introduced by this specification.

## 27. Acceptance criteria

The implemented feature is acceptable only when all of the following are true:

- Review UI is usable before fill capability exists.
- Fill requires a positive, current, completely reviewed packet.
- Fill acquisition requires `state === READY && fillAttemptId === null`.
- Fill acquisition with zero eligible approved spike-supported fields fails with `FILL_NO_ELIGIBLE_FIELDS` before assigning an attempt ID or making any persistent acquisition change.
- `fillAttemptId` is assigned once and never cleared or replaced.
- The same run can never receive another automated fill.
- Exact replay does not change `READY_FOR_USER_SUBMISSION`.
- Pre-fill review resolution with `fillAttemptId === null` enters `READY`.
- Post-fill material reinspection and fresh review with `fillAttemptId !== null` return to `READY_FOR_USER_SUBMISSION`.
- Post-fill fresh review preserves the later `COMPLETED_BY_USER` attestation path without restoring automated fill eligibility.
- GET fill-attempt is strictly read only.
- All expired-lease state, step, lease, outcome, and audit mutations occur only through `PATCH action: RECOVER_EXPIRED` after server-side expiry proof.
- Only spike-approved control families are writable.
- Occupied values and selections are never overwritten.
- Raw employer current values never cross page evaluation.
- Unexpected events, mismatch, detachment, and target loss stop safely.
- Expired `FILLING` recovers only to `READY_FOR_USER_SUBMISSION`.
- Steps contain only closed safe outcomes and errors.
- Completion requires the exact user attestation.
- No Apply Pilot submit path exists.
- All seven increments' test gates pass.

## 28. Spec consistency statement

This specification contains one and only one automated fill opportunity per `ApplicationRun`. No state transition, reinspection result, review resolution, lease recovery, UI action, or backend route clears or replaces a previously assigned `fillAttemptId`. Pre-fill review resolves to `READY` only when `fillAttemptId === null`. Post-fill material reinspection and fresh review resolve back to `READY_FOR_USER_SUBMISSION` when `fillAttemptId !== null`, preserving manual completion and personal-submission attestation without creating a second fill path. GET fill-attempt is read only, expired recovery mutates only through `PATCH action: RECOVER_EXPIRED`, and zero eligible fields cause no persistent acquisition change. Remaining employer fields are completed manually by the user.
