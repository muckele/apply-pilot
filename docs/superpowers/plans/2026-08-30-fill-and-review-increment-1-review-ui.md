# Fill & Review Increment 1 — Review UI Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing server-authoritative answer review and run review
resolution reachable from the authenticated browser control page without adding
any employer-write capability.

**Architecture:** Extend the existing pure control-presentation boundary with strict review/run response parsers, exact same-origin request builders, and eligibility predicates, while keeping network and React lifecycle ownership in `ApplicationBrowserControl`. The component will atomically refresh the existing owned-run GET and current answer-packet GET, perform one globally serialized review mutation at a time, and replace local review data only from successful authoritative reads; review data never enters the browser-companion binding.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.6, Zod 3, Tailwind CSS, Node.js 24 `node:test` through `tsx`, React 19 `act`, `react-dom/client`, and JSDOM 29.

**Spec:**
`docs/superpowers/specs/2026-08-30-fill-and-review-human-submit-design.md`

## Global Constraints

- Implement Increment 1 only: expose `Approve`, `Reject`, and `Resolve review` on the authenticated Apply Pilot browser-control page.
- The frozen design baseline is `bae9a8036c5f3250c54b556dcb649c697658853e` on `feature/form-inspection-answer-packet`; the approved design SHA-256 is `78b1042e2aafa541188505761cfaa9ca488ff7fa0d5d99c61d9ded7311bb7409`. Implementation must start from the exact committed-plan SHA `2e50af33cb939286da5f7354e1e66ecebb570b53`.
- Review authority remains server-side. The UI may offer actions, but only the existing authenticated routes may approve, reject, or resolve review.
- Render answer mutation controls only when `answer.status === "PENDING" && answer.disposition === "PROPOSABLE"`.
- Never render answer mutation controls for `MANUAL_ONLY`, `EXCLUDED`, `UNSUPPORTED`, `APPROVED`, or `REJECTED` answers.
- An answer-review request contains only the current `runId`, current `answerId`, requested `status`, and exact current `answerPacketVersion`; it contains no proposal, question, packet, hash, or client-manufactured authority.
- A resolve-review request contains the exact currently presented `stateVersion`, ordered `acknowledgedReviewReasons`, `answerPacketVersion`, and `packetHash` obtained from authenticated same-origin reads.
- Successful mutation responses are not final local authority. Refresh the owned run and current packet, then render the refreshed authoritative values.
- Do not preserve optimistic answer or run state. A stale, failed, malformed, wrong-run, aborted, or late response cannot approve/reject an answer or fabricate `READY` in the UI.
- Use one global review-mutation lock across all answer actions and `Resolve review`. This prevents answer/answer and answer/resolve races and is the smallest safe concurrency scope.
- Reuse the component-generation, request-sequence, abort-controller, and ref patterns already present in `components/application-browser-control.tsx`. A settlement after generation invalidation performs no state update, notice update, authoritative refresh, binding call, or follow-on mutation.
- A refreshed packet replaces the prior packet as one unit. Old answer objects, IDs, versions, closures, and still-visible actions from an authority read being replaced cannot start a request.
- Use direct authenticated same-origin HTTP from the control page. Do not put packet content, answer IDs, proposals, review requests, review statuses, or resolve bodies through `APPLICATION_BROWSER_BINDING_NAME`.
- No employer-page write, DOM mutation, fill command, upload, click, submit, or submission inference exists in this increment.
- Do not add dependencies or a test framework. Reuse `node:test`, `tsx`, React 19 `act`, `react-dom/client`, and JSDOM.
- Keep `app/api/application-runs/[id]/route.ts`, the answer-packet GET, answer-review POST, resolve-review POST, application-run services, packet domain/service, Prisma files, and browser companion/coordinator/bridge/controller paths read-only unless execution discovers a proven contradiction to the baseline inspected by this plan.
- Do not implement `FILL_APPROVED_FIELDS`, fill-attempt APIs, `FILLING`, `FILL_AND_REVIEW`, `fillAttemptId`, `fillLeaseExpiresAt`, `APPLICATION_FILL`, a form writer, result UI, completed-by-user, document upload, ATS adapters, employer writes, or submission behavior.
- The normative no-submit invariant remains: no submit command or scope, no `requestSubmit()`, no `form.submit()`, no Apply Pilot submit-control click, no CAPTCHA bypass, no employer login automation, and no submission detection as authority. The user personally submits.

---

## Current-State Findings and File Map

### Existing authority that Increment 1 consumes without modification

- `GET /api/application-runs/[id]` in `app/api/application-runs/[id]/route.ts:18-30` authenticates ownership, rate-limits the read, and returns `{ run }` with the existing `ApplicationRunDto`.
- `ApplicationRunDto` in `lib/application-runs/contracts.ts:152-176` already includes the exact `id`, `state`, `stateVersion`, ordered `reviewReasons`, and `reviewAcknowledgedAt` needed for review presentation and resolution.
- `GET /api/application-runs/[id]/answer-packet` in `app/api/application-runs/[id]/answer-packet/route.ts:20-43` returns the verified current public packet with `answerPacketVersion`, `packetHash`, `reviewedAt`, summary readiness, answer IDs, dispositions, statuses, and proposals.
- `POST /api/application-runs/[id]/answers/[answerId]/review` in `app/api/application-runs/[id]/answers/[answerId]/review/route.ts:22-42` already accepts only `{ status: "APPROVED" | "REJECTED", answerPacketVersion }` and returns the narrow `{ answer }` DTO.
- `POST /api/application-runs/[id]/resolve-review` in `app/api/application-runs/[id]/resolve-review/route.ts:22-36` already accepts exact run version, ordered review reasons, packet version, and packet hash and returns `{ run }`.
- `reviewApplicationRunAnswer` in `lib/application-runs/service.ts:846-1021` locks the owned run and packet-scoped answer, rejects stale versions and non-pending/non-proposable authority, and persists the server-derived canonical approval hash or rejection.
- `resolveApplicationRunReview` in `lib/application-runs/service.ts:675-844` locks the owned run, compares ordered reasons exactly, verifies packet version/hash/readiness, and alone performs `REVIEW_REQUIRED -> READY` at this baseline.
- `summarizeApplicationAnswerPacket` in `lib/application-runs/answer-packet-domain.ts:972-1057` computes `readyForRunResolution` from exact current packet membership, zero pending proposable answers, and valid approved hashes.
- `getCurrentAnswerPacket` in `lib/application-runs/answer-packet-service.ts:1373-1384` performs an owner-scoped repeatable-read verification and returns no unverified packet.

**Backend precondition assessment:** `NO BACKEND PRECONDITION GAP`. The run GET supplies the two resolve fields absent from the packet DTO, so Increment 1 needs no page-prop extension and no API/service change.

### Production files to modify

- `lib/application-browser/control-presentation.ts:21-32,119-253,423-530` — add the pure run/review schemas, projections, eligibility/readiness predicates, exact POST request builders, and strict response parsers beside the existing packet parser and presentation helpers.
- `components/application-browser-control.tsx:33-222,265-370,394-447` — replace packet-only loading with atomic run-plus-packet review loading, add generation-guarded review mutation orchestration, and render bounded review controls/notices.

### Test file to modify

- `tests/application-browser-control-presentation.test.ts:1-188,228-324,604-805,961-1185` — extend the existing pure-helper tests and mounted React/JSDOM harness. The harness already installs browser globals, captures `fetch`, installs the canonical binding, provides deferred promises, uses React `act`, and proves unmount safety.

### Files that remain read-only

- `app/application-runs/[id]/browser/page.tsx` — ownership is already checked and the component already receives the immutable run ID.
- `app/api/application-runs/[id]/route.ts`
- `app/api/application-runs/[id]/answer-packet/route.ts`
- `app/api/application-runs/[id]/answers/[answerId]/review/route.ts`
- `app/api/application-runs/[id]/resolve-review/route.ts`
- `lib/application-runs/contracts.ts`
- `lib/application-runs/service.ts`
- `lib/application-runs/answer-packet-api.ts`
- `lib/application-runs/answer-packet-domain.ts`
- `lib/application-runs/answer-packet-service.ts`
- `lib/application-browser/types.ts`
- `lib/application-browser/same-origin-client.ts` — this is the companion-side Playwright `APIRequestContext` client, not a browser-React fetch client; widening it would mix lifecycles and expose review material to the wrong boundary.
- `lib/application-browser/coordinator.ts`
- `lib/application-browser/control-bridge.ts`
- `lib/application-browser/form-inspection-controller.ts`
- `lib/application-browser/form-inspection-correlation.ts`
- `lib/application-browser/target-controller.ts`
- `scripts/application-browser-companion.ts`
- `lib/application-runs/execution-token.ts`
- `app/api/application-runs/[id]/execution-token/**`
- `prisma/schema.prisma`
- `prisma/migrations/**`

No new `control-review-client.ts` is warranted. There is one React consumer, and its request cancellation, sequence fencing, notices, and component-generation checks must stay together. Pure construction and parsing move to the already established `control-presentation.ts` boundary so they can be tested without mounting React.

## Planned Interfaces

Task 1 introduces these exact exported interfaces in `lib/application-browser/control-presentation.ts`; the later `ReviewLoad`, refresh result, and refresh signature are component-local Task 2 interfaces:

```ts
export type ReviewRunAuthority = Readonly<{
  id: string;
  state: ApplicationRunState;
  stateVersion: number;
  reviewReasons: readonly PlanReviewReason[];
}>;

export const REVIEW_REASON_LABELS: Record<PlanReviewReason, string> = {
  unknown_requirement_ids: "Some job requirements could not be matched exactly.",
  unknown_evidence_ids: "Some supporting evidence references could not be matched exactly.",
  exaggerated_evidence_removed: "Unsupported or exaggerated evidence was removed.",
  invented_numeric_claims: "Unsupported numeric claims were detected and removed.",
  planner_confidence_below_threshold: "Application-plan confidence is below the required threshold.",
  evidence_gaps_present: "Some application requirements still have evidence gaps."
};

export type PendingReviewMutation =
  | { type: "ANSWER"; answerId: string; status: "APPROVED" | "REJECTED" }
  | { type: "RESOLVE" }
  | null;

export type SameOriginReviewRequest = Readonly<{
  url: string;
  init: Readonly<{
    method: "POST";
    headers: Readonly<{ "Content-Type": "application/json" }>;
    cache: "no-store";
    body: string;
  }>;
}>;

export function isAnswerReviewEligible(
  answer: Pick<AnswerPacketAnswer, "status" | "disposition">
): boolean;

export function isResolveReviewEligible(input: {
  run: ReviewRunAuthority | null;
  packet: AnswerPacket | null;
  trusted: boolean;
}): boolean;

export function parseApplicationRunReviewResponse(
  value: unknown,
  expectedRunId: string
): ReviewRunAuthority;

export function buildAnswerReviewRequest(input: {
  runId: string;
  answerId: string;
  answerPacketVersion: number;
  status: "APPROVED" | "REJECTED";
}): SameOriginReviewRequest;

export function parseAnswerReviewResponse(
  value: unknown,
  expected: {
    runId: string;
    answerId: string;
    status: "APPROVED" | "REJECTED";
  }
): void;

export function buildResolveReviewRequest(input: {
  runId: string;
  run: ReviewRunAuthority;
  packet: AnswerPacket;
}): SameOriginReviewRequest;
```

The request builders return fixed same-origin paths and exact JSON bodies:

```ts
JSON.stringify({
  status: input.status,
  answerPacketVersion: input.answerPacketVersion
});

JSON.stringify({
  stateVersion: input.run.stateVersion,
  acknowledgedReviewReasons: [...input.run.reviewReasons],
  answerPacketVersion: input.packet.answerPacketVersion,
  packetHash: input.packet.packetHash
});
```

Neither builder accepts a proposal, question, packet answer collection, browser command, or binding callback. `buildResolveReviewRequest` snapshots the ordered reasons with a new array so later object mutation cannot alter the serialized authority.

The component uses one review state object so a run from one read cycle cannot be paired in React state with a packet from another completed cycle:

```ts
type ReviewLoad = {
  phase: "idle" | "loading" | "loaded" | "error";
  run: ReviewRunAuthority | null;
  packet: AnswerPacket | null;
  latestResponseWasNull: boolean;
  unverified: boolean;
  notice: CommandNotice | null;
};

type ReviewAuthorityRefreshResult =
  | Readonly<{ outcome: "COMMITTED" }>
  | Readonly<{ outcome: "FAILED" }>
  | Readonly<{ outcome: "SUPERSEDED" }>
  | Readonly<{ outcome: "INACTIVE" }>;

async function fetchReviewAuthority(
  expectedGeneration?: number | null
): Promise<ReviewAuthorityRefreshResult>;
```

`ReviewAuthorityRefreshResult` and `fetchReviewAuthority` are component-local rather than exported because the React component alone owns generation, request-sequence, abort, state, and ref lifecycles. The return contract is exact:

- `COMMITTED`: both reads and JSON parsing succeeded, both strict schemas and identity checks passed, the expected component generation and this read's request sequence are still current, and the function atomically committed the new `{ run, packet }` to both the `ReviewLoad` state and ref.
- `FAILED`: this invocation is still the current read for the active generation, but a read, non-success response, JSON parse, schema validation, or identity check failed; the function applied the documented failure state to the state and ref while still active.
- `SUPERSEDED`: a newer authority read owns the request sequence, so this invocation cannot commit data or authorize success copy.
- `INACTIVE`: the expected component generation is no longer active, including unmount/generation invalidation; the invocation performs no state/ref update, notice, or follow-on behavior.

`fetchReviewAuthority(expectedGeneration?: number | null)` starts both same-origin GETs with one abort signal, parses both responses, checks both identities against the immutable `runId`, and commits `{ run, packet }` once only after both reads pass. Every awaited boundary rechecks generation and sequence before any effect. Generation inactivity takes precedence and returns `INACTIVE`; otherwise, an active invocation whose sequence is no longer current returns `SUPERSEDED`. An automatic packet/review refresh may supersede a mutation-triggered refresh; the older call returns `SUPERSEDED`, and its mutation caller must not publish stale success. Separate endpoints can race with server mutations, so the UI treats the resulting values as a request snapshot while the POST routes retain the final exact-version/hash authority and return `409` on any mismatch.

## Failure and Lifecycle Contract

| Outcome | Local data | Controls | Follow-on behavior | Notice |
|---|---|---|---|---|
| Valid mutation response and refresh returns `COMMITTED` | Replace run and packet atomically | Recomputed from refreshed values | None beyond the one refresh | Success only after committed authoritative refresh |
| Valid mutation response and refresh returns `FAILED` | Apply the documented active read-failure state | All review mutations inert until trusted data is loaded | No mutation success; user follows the read-failure recovery | Authority-read failure notice only |
| Valid mutation response and refresh returns `SUPERSEDED` | Only the newer read may affect local data | Determined only by the newer read | No stale mutation success | None from the superseded mutation flow |
| Valid mutation response and refresh returns `INACTIVE` | No state or ref update | Component is inactive/gone | No success, notice, or follow-on effect | None |
| `409` review conflict | Preserve visible values but set `unverified: true` immediately | All review mutations inert | Start one authoritative refresh; remain inert while it is pending or if it fails | Warning that review authority changed |
| `401` | Clear run and packet | None | No automatic retry | Session-expired error |
| `403` | Clear run and packet | None | No automatic retry | Authorization error |
| `404` | Clear run and packet | None | No automatic retry | Run/answer unavailable error |
| `429` | Preserve displayed values, set them unverified | All review mutations inert | User may use `Refresh review data` after waiting | Rate-limit warning |
| `5xx` or network rejection | Preserve displayed values, set them unverified | All review mutations inert | User must refresh before another mutation | Outcome-unverified error |
| Invalid JSON, strict parser rejection, or wrong run/answer/status in a `2xx` response | Preserve displayed values, set them unverified | All review mutations inert | No success notice; user must refresh | Unsafe-response error |
| Unmount/generation invalidation before settlement | No state or refs updated | Component is gone | No read, resolve, recovery, notice, or binding call | None |

`reviewLoad.unverified` is distinct from the browser companion freshness label. A successful owned packet GET may be review-authoritative even before a companion status is accepted; a failed inspection publication or uncertain review mutation marks that review data unverified until the next successful run+packet read.

## Task 1: Pure Review Authority, Eligibility, Request, and Response Contracts

**Files:**
- Modify: `lib/application-browser/control-presentation.ts:21-32,119-253,423-530`
- Test: `tests/application-browser-control-presentation.test.ts:9-31,228-324,604-805`

**Interfaces:**
- Consumes: existing `AnswerPacket`, `AnswerPacketAnswer`, `packetResponseSchema`, `PLAN_REVIEW_REASONS`, and Prisma `ApplicationRunState` as a type.
- Produces: `ReviewRunAuthority`, `REVIEW_REASON_LABELS`, `PendingReviewMutation`, `SameOriginReviewRequest`, `isAnswerReviewEligible`, `isResolveReviewEligible`, `parseApplicationRunReviewResponse`, `buildAnswerReviewRequest`, `parseAnswerReviewResponse`, and `buildResolveReviewRequest` with the signatures in “Planned Interfaces.”

- [ ] **Step 1: Add RED pure tests for answer eligibility and exact review request construction.**

  Add table-driven assertions that only `PENDING + PROPOSABLE` returns true; explicitly cover pending `MANUAL_ONLY`, `EXCLUDED`, and `UNSUPPORTED`, plus `APPROVED + PROPOSABLE` and `REJECTED + PROPOSABLE`. Add approve and reject request assertions for the exact encoded run/answer URL, `POST`, `Content-Type: application/json`, `cache: "no-store"`, and exact parsed bodies. Put proposal/question sentinel properties on the source fixture and assert neither sentinel occurs in `url`, `headers`, or `body`.

  ```ts
  assert.deepEqual(JSON.parse(approve.init.body), {
    status: "APPROVED",
    answerPacketVersion: 3
  });
  assert.deepEqual(JSON.parse(reject.init.body), {
    status: "REJECTED",
    answerPacketVersion: 3
  });
  assert.equal(approve.url, `/api/application-runs/${RUN_ID}/answers/${ANSWER_ID}/review`);
  assert.equal(JSON.stringify([approve, reject]).includes("proposal-sentinel"), false);
  ```

- [ ] **Step 2: Add RED pure tests for run authority, review-reason labels, mutation responses, resolve readiness, and exact resolve bodies.**

  Test a valid `{ run }` response projecting only the expected run ID, known state, safe nonnegative `stateVersion`, and ordered `PLAN_REVIEW_REASONS`. Include unrelated legitimate `ApplicationRunDto` fields inside `run` and assert they are accepted but excluded from the returned projection. Reject a wrong run ID, unknown state, negative/fractional/unsafe version, duplicate reason, unknown reason, noncanonical reason order, missing run, malformed top-level value, and every unexpected top-level key. Test all six `PLAN_REVIEW_REASONS` against `REVIEW_REASON_LABELS`: every identifier maps to exactly its specified non-empty label, the mapping has no missing or extra keys, an unknown identifier cannot be presented, and mapping the server-owned `reviewReasons` array preserves its original order. Test answer-response rejection for wrong run ID, wrong answer ID, wrong status, `reviewedByUser !== true`, null/malformed review time, malformed JSON values passed to the parser, and extra top-level/answer keys. Test resolve eligibility as false until all of: trusted data, `run.state === "REVIEW_REQUIRED"`, non-null positive-version packet, `packet.reviewedAt === null`, and `readyForRunResolution === true`; test exact ordered body and absence of proposal/answer data.

  ```ts
  assert.deepEqual(JSON.parse(resolve.init.body), {
    stateVersion: 7,
    acknowledgedReviewReasons: [
      "unknown_requirement_ids",
      "evidence_gaps_present"
    ],
    answerPacketVersion: 3,
    packetHash: "a".repeat(64)
  });
  assert.equal(resolve.url, `/api/application-runs/${RUN_ID}/resolve-review`);
  ```

- [ ] **Step 3: Run the focused test and verify RED.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: FAIL at module load because the planned review exports do not exist yet; no existing test should fail before those import/undefined failures.

- [ ] **Step 4: Implement the strict schemas and pure helpers.**

  Use a closed list of all current `ApplicationRunState` values and `z.enum(PLAN_REVIEW_REASONS)`. Refine `reviewReasons` so each reason is unique and its index in `PLAN_REVIEW_REASONS` strictly increases. Define the top-level response as `z.object({ run: runAuthoritySchema }).strict()`. Define `runAuthoritySchema` with the minimum required authority fields `id`, `state`, `stateVersion`, and `reviewReasons`, followed explicitly by `.strip()`: legitimate unrelated `ApplicationRunDto` fields are accepted and stripped, while the returned value is only the narrow authority projection. Check the parsed ID against `expectedRunId` and clone `reviewReasons`. Reuse this same parser for the run GET and successful resolve POST. Define the answer mutation response as strict `{ answer: { id, runId, status, reviewedByUser, reviewedAt, sensitive, valueRedacted } }` and compare its identity/status to the request snapshot. Build request objects from scalar inputs only. Return resolve eligibility false for already reviewed packets and every state other than `REVIEW_REQUIRED`.

  Add the one closed presentation mapping exactly as declared in “Planned Interfaces.” It contains only the six `PlanReviewReason` identifiers and these exact strings; the component renders `run.reviewReasons.map((reason) => REVIEW_REASON_LABELS[reason])`, so display order remains server-owned and unknown identifiers cannot pass the run parser. Do not add fallback text or additional reason identifiers.

  ```ts
  export function isAnswerReviewEligible(
    answer: Pick<AnswerPacketAnswer, "status" | "disposition">
  ): boolean {
    return answer.status === "PENDING" && answer.disposition === "PROPOSABLE";
  }

  export function isResolveReviewEligible(input: {
    run: ReviewRunAuthority | null;
    packet: AnswerPacket | null;
    trusted: boolean;
  }): boolean {
    return input.trusted &&
      input.run?.state === "REVIEW_REQUIRED" &&
      input.packet !== null &&
      input.packet.reviewedAt === null &&
      input.packet.summary.readyForRunResolution;
  }
  ```

- [ ] **Step 5: Run the focused test and verify GREEN.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: PASS, including the new eligibility, exact reason-label mapping/order, request-body, precise run-parser projection, response-parser, and resolve-contract cases.

- [ ] **Step 6: Run neighboring contract regressions.**

  Run:

  ```bash
  node --import tsx --test tests/application-run-contracts.test.ts tests/application-run-answer-packet-api.test.ts tests/application-browser-same-origin-client.test.ts
  ```

  Expected: PASS. These confirm the server contract schemas/public packet projection and companion-side same-origin boundary remain unchanged.

- [ ] **Step 7: Inspect the task diff and whitespace.**

  Run:

  ```bash
  git diff -- lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  git diff --check
  ```

  Expected: only the pure review contracts/tests are present; no binding command, API route, service, Prisma, fill, or employer-write changes; `git diff --check` prints nothing.

- [ ] **Step 8: Commit Task 1.**

  ```bash
  git add lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  git commit -m "Add review UI request contracts"
  ```

## Task 2: Authoritative Review Loading and Approve/Reject Reachability

**Files:**
- Modify: `components/application-browser-control.tsx:6-47,89-222,346-370,394-447`
- Test: `tests/application-browser-control-presentation.test.ts:41-188,228-324,961-1185`

**Interfaces:**
- Consumes: `ReviewRunAuthority`, `PendingReviewMutation`, `isAnswerReviewEligible`, `buildAnswerReviewRequest`, `parseAnswerReviewResponse`, and existing `parseAnswerPacketResponse` from Task 1.
- Produces: component-local `ReviewLoad`, `ReviewAuthorityRefreshResult`, `fetchReviewAuthority(expectedGeneration?: number | null): Promise<ReviewAuthorityRefreshResult>`, `invalidateReviewAuthority(...)`, and `reviewAnswer(answer, status)` behavior; no new exported production API.

- [ ] **Step 1: Upgrade the mounted harness and add RED visibility/request tests.**

  Make the fetch handler route-aware: the initial mount receives one `GET /api/application-runs/${RUN_ID}` response and one `GET /api/application-runs/${RUN_ID}/answer-packet` response, both using `cache: "no-store"` and the same abort signal. Add a valid run fixture containing `state: "REVIEW_REQUIRED"`, `stateVersion`, and ordered `reviewReasons`. Add helpers that find buttons inside the article for a specific question so repeated `Approve`/`Reject` labels remain unambiguous.

  Assert:

  - the pending proposable article renders enabled `Approve` and `Reject` buttons with accessible names containing the action and question;
  - pending manual-only, excluded, and unsupported articles render neither button;
  - approved and rejected proposable articles render neither button;
  - clicking `Approve` sends one exact request and no proposal;
  - clicking `Reject` sends one exact request and no proposal;
  - a deferred first request plus a second click produces exactly one POST;
  - while any answer request is pending, every answer review control and the review-data refresh button is disabled and the active button says `Approving…` or `Rejecting…`.

- [ ] **Step 2: Add RED authoritative refresh, failure, replacement, lifecycle, and binding-privacy tests.**

  Use route-aware queued/deferred fetch responses to cover all of the following:

  1. A valid answer-review response followed by a refresh returning `COMMITTED` triggers exactly one new run GET and one new packet GET; only the committed refreshed authority changes the displayed status/counts and produces the success notice.
  2. A valid answer-review response followed by a current refresh failure returns `FAILED`, applies the documented authority failure state, and produces no mutation success notice.
  3. A valid answer-review response whose refresh is overtaken by a newer automatic or manual authority read returns `SUPERSEDED`; only the newer read may commit, and the mutation flow produces no stale success notice.
  4. A valid answer-review response whose refresh becomes inactive through unmount/generation invalidation returns `INACTIVE` and produces no state/ref update, success notice, or follow-on behavior.
  5. Prove live stale-action safety with one primary mounted sequence: (A) render current answer A and its enabled action; (B) begin an authority replacement/refetch and hold both new reads while old content remains visible; (C) while held, assert `reviewLoad` is loading/unverified, the old visible action is disabled/inert, and activation creates zero POSTs; (D) complete the read with a new packet version and answer B identity; (E) assert answer A's action is gone, only answer B's current action dispatches, and its request contains B's answer ID and the new packet version.
  6. Exercise the `currentAnswer !== answer` dispatch guard directly at the mounted harness's existing deferred React commit boundary: after the authority ref has advanced to answer B but while the old answer A render is still live, activate A's still-connected action and assert zero POSTs. Do not remove a node or use a detached DOM event as proof, and do not add a production abstraction solely for this test.
  7. `409` marks old review data untrusted before starting one run+packet refresh; a held refresh reuses the live pending-replacement proof above, and a successful replacement removes the old answer action.
  8. `401`, `403`, and `404` clear run/packet review authority and render the bounded corresponding notice.
  9. `429`, representative `500` and `503`, and a network rejection preserve the displayed packet text but mark it unverified and disable all review mutations without changing displayed answer status.
  10. A `200` whose `json()` rejects, wrong-run answer DTO, wrong-answer DTO, wrong-status DTO, or strict-parser-invalid DTO produces no success notice, no local status mutation, and inert review data.
  11. Unmount before a valid or rejected answer mutation settles; settlement performs no state update and adds no run GET, packet GET, resolve POST, recovery action, notice, or binding invocation.
  12. Install a binding spy, complete approve and reject flows, and assert it receives zero commands. Serialize all binding inputs and assert absence of the answer ID, proposal sentinel, packet hash, `APPROVED`, `REJECTED`, and review request URL.

  Use React-captured `console.error` assertions only if React emits an actual post-unmount update warning in this test environment; the primary proof is the absence of every follow-on effect above.

- [ ] **Step 3: Run the focused test and verify RED.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: FAIL because the component still makes only the packet GET and renders no answer mutation controls.

- [ ] **Step 4: Replace packet-only loading with atomic review-authority loading.**

  Rename the component state/ref from `PacketLoad`/`packetLoadRef` to `ReviewLoad`/`reviewLoadRef`. Replace `fetchPacket` with `fetchReviewAuthority(expectedGeneration?: number | null): Promise<ReviewAuthorityRefreshResult>`; make it issue the owned-run GET and packet GET under one component generation, request sequence, and abort controller. At the start of the active/current invocation, commit `phase: "loading"` and `unverified: true` to state/ref while retaining prior run/packet values only as visible context, making every old action inert before either read settles. Check generation/sequence/abort after each awaited boundary. Parse both values before one state/ref update. Return exactly `COMMITTED`, `FAILED`, `SUPERSEDED`, or `INACTIVE` under the “Planned Interfaces” contract, with inactive generation taking precedence over sequence supersession. Preserve the current automatic refresh key behavior by calling the new combined read after successful inspection status; this automatic read increments the same authority-read sequence and therefore returns `SUPERSEDED` from any older mutation-triggered read it overtakes.

  For read failures, use the failure table in this plan. A transient failure may keep the last rendered values for context but must set `unverified: true`; an authentication/ownership/not-found failure clears both `run` and `packet`. Rename the UI control from `Refresh packet` to `Refresh review data`, with `Refreshing…` while the combined read is pending.

- [ ] **Step 5: Implement globally serialized answer mutations without optimistic authority.**

  Add `pendingReviewMutation` state plus a synchronously maintained `pendingReviewMutationRef` so two clicks in one React turn cannot dispatch twice. Add a mutation abort controller and abort it during component cleanup. At dispatch, reread `reviewLoadRef.current`, require loaded/non-unverified data, require the captured answer object to be the same current packet member, and rerun `isAnswerReviewEligible`. Snapshot the exact scalar request fields before `fetch`.

  ```ts
  const current = reviewLoadRef.current;
  const currentAnswer = current.packet?.answers.find((entry) => entry.id === answer.id);
  if (
    pendingReviewMutationRef.current !== null ||
    current.phase !== "loaded" ||
    current.unverified ||
    currentAnswer !== answer ||
    !isAnswerReviewEligible(currentAnswer)
  ) return;
  ```

  After the POST, verify the component generation before parsing or changing refs. A schema-valid, identity-valid POST response is only a refresh trigger, never sufficient authority for success copy. Await `fetchReviewAuthority(expectedGeneration)` and branch on its exact result: publish success only for `outcome === "COMMITTED"`; for `FAILED`, publish no mutation success and retain the authority-read failure state/notice already applied by the refresh; for `SUPERSEDED`, publish no stale success because only the newer read owns authority; for `INACTIVE`, do nothing. On `409`, mark current review data unverified and begin one combined refresh. On every other failure, apply the table exactly. The answer objects and summary remain unchanged until a valid combined read replaces them.

- [ ] **Step 6: Render bounded answer controls and accessible notices.**

  Inside each answer article, render a small action group only when `isAnswerReviewEligible(answer)` is true. Use `PrimaryButton` for approve and `SecondaryButton` for reject, `type="button"`, and explicit `aria-label` values such as `Approve proposed answer for Portfolio URL`. Disable both during any review mutation, any unverified/error/loading review state, or when the article is no longer current. Show `Approving…`/`Rejecting…` only on the active answer/action.

  Give review notices `aria-live="polite"`; give auth, ownership, malformed, and uncertain-outcome errors `role="alert"`. Keep browser-companion `commandNotice` separate so an HTTP review result cannot be mistaken for binding status.

- [ ] **Step 7: Run the focused test and verify GREEN.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: PASS for all pure and mounted tests, including exact requests, authoritative refresh, stale inertness, auth/transient/malformed failure handling, duplicate suppression, packet replacement, unmount safety, and no binding review data.

- [ ] **Step 8: Run neighboring browser-control regressions.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-bridge.test.ts tests/application-browser-companion.test.ts tests/application-browser-same-origin-client.test.ts
  ```

  Expected: PASS. `B1Command`, the canonical binding name, companion cleanup, bridge trust, and companion same-origin client surface remain unchanged.

- [ ] **Step 9: Run typecheck and inspect the task diff.**

  Run:

  ```bash
  npm run typecheck
  git diff -- components/application-browser-control.tsx lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  git diff --check
  ```

  Expected: typecheck PASS; the diff contains only the two production files and one test file authorized for Increment 1; no binding type, page, route, service, Prisma, fill, employer DOM, or submit changes; whitespace check prints nothing.

- [ ] **Step 10: Commit Task 2.**

  ```bash
  git add components/application-browser-control.tsx lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  git commit -m "Expose server-authoritative answer review"
  ```

## Task 3: Resolve-Review Reachability and Final Regression Hardening

**Files:**
- Modify: `components/application-browser-control.tsx:89-370,394-447`
- Test: `tests/application-browser-control-presentation.test.ts:41-188,228-324,961-1185`
- Verify read-only: `tests/application-run-routes.test.ts:262-311,539-703,1130-1200`
- Verify read-only: `tests/application-run-service.test.ts:1183-1249,1368-1700,1700-2053`
- Verify read-only: `tests/application-run-answer-packet-api.test.ts:208-end`
- Verify read-only: `tests/application-run-answer-packet-service.test.ts:597-700`

**Interfaces:**
- Consumes: `REVIEW_REASON_LABELS`, `isResolveReviewEligible`, `buildResolveReviewRequest`, `parseApplicationRunReviewResponse`, the Task 2 `ReviewLoad`, `ReviewAuthorityRefreshResult`, `fetchReviewAuthority`, mutation lock/ref, generation checks, and invalidation behavior.
- Produces: `resolveReview()` component behavior and the final review-resolution UI; no new exported production API.

- [ ] **Step 1: Add RED resolve visibility, exact-request, and success-refresh tests.**

  Add mounted cases proving:

  - `Resolve review` is rendered but disabled when `readyForRunResolution` is false;
  - readiness true does not enable it when run state is not `REVIEW_REQUIRED`, packet `reviewedAt` is non-null, review data is unverified, a read is loading, or any answer/resolve mutation is pending;
  - with trusted `REVIEW_REQUIRED` run authority and ready packet, clicking sends exactly one POST to `/api/application-runs/${RUN_ID}/resolve-review` with exact `stateVersion`, ordered `acknowledgedReviewReasons`, `answerPacketVersion`, and `packetHash`;
  - the body has no answer ID, proposal, questions, packet answers, binding name, or browser command;
  - duplicate clicks and an answer click while resolve is pending produce exactly one mutation request;
  - a valid resolve response triggers exactly one combined run+packet refresh; only a refresh returning `COMMITTED` may use the refreshed run state and packet `reviewedAt` to remove resolution availability and produce the success notice;
  - resolve refresh results follow the same exact four-way contract as answer review: `FAILED`, `SUPERSEDED`, and `INACTIVE` produce no resolve success copy, and only the active/current read may apply its documented state.

- [ ] **Step 2: Add RED stale/failure/unmount/packet-replacement resolve tests.**

  Add mounted cases proving:

  - a `409` resolve response never changes the displayed run to `READY`, marks old authority inert, and begins one refresh;
  - `401`, `403`, `404`, `429`, `5xx`, network rejection, invalid JSON, a wrong-run `{ run }`, an unknown run state, invalid version/reasons, and strict-parser-invalid response follow the same failure table as answer review;
  - a stale resolve response never fabricates `reviewedAt` or success copy;
  - while a packet/run replacement is held pending, the old resolve authority may remain visible for context but its still-connected button is disabled/inert and sends no POST; after replacement, only the current version/hash/state/reasons can dispatch;
  - valid and rejected resolve settlements after unmount produce no state, notice, follow-on GET, answer POST, second resolve POST, or binding call;
  - a binding spy receives zero commands across a successful resolve flow, and serialized binding inputs omit the exact resolve body and packet hash.

- [ ] **Step 3: Run the focused test and verify RED.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: FAIL because no resolve control or `resolveReview()` mutation path exists in the component.

- [ ] **Step 4: Implement resolve review through the shared mutation surface.**

  Render current run state/version and the ordered current review reasons in the packet summary area so the user can see the authority being acknowledged. For each server-owned identifier, render exactly `REVIEW_REASON_LABELS[reason]` in the same array order while preserving the raw ordered identifiers only in the request snapshot. The mapping contains exactly:

  - `unknown_requirement_ids` → `Some job requirements could not be matched exactly.`
  - `unknown_evidence_ids` → `Some supporting evidence references could not be matched exactly.`
  - `exaggerated_evidence_removed` → `Unsupported or exaggerated evidence was removed.`
  - `invented_numeric_claims` → `Unsupported numeric claims were detected and removed.`
  - `planner_confidence_below_threshold` → `Application-plan confidence is below the required threshold.`
  - `evidence_gaps_present` → `Some application requirements still have evidence gaps.`

  Unknown identifiers cannot pass `parseApplicationRunReviewResponse` and therefore have no display fallback. When the reason array is empty, render `No planner review reasons require acknowledgment.`

  Add `resolveReview()` using the same pending ref, generation snapshot, abort controller, response-status mapping, parser, and combined refresh as `reviewAnswer`. Before dispatch, reread `reviewLoadRef.current`, require `isResolveReviewEligible(...)`, and build from those exact current objects. The active label is `Resolving…`; all answer and resolve controls are disabled for the duration. A valid response is only a trigger for the combined authoritative refresh and never directly updates displayed run state. Await the refresh result and apply the same branch exactly: success copy only for `COMMITTED`; no success for `FAILED` or `SUPERSEDED`; no state/ref/notice/follow-on effect for `INACTIVE`.

- [ ] **Step 5: Render resolve availability and bounded copy.**

  Place `Resolve review` beside the packet readiness message. Keep it visible but disabled before readiness so the user understands the next step. Use `aria-describedby` to associate it with readiness and review-reason copy. Preserve the footer statement that Apply Pilot does not fill fields, upload documents, click employer controls, or submit the application.

- [ ] **Step 6: Run the focused test and verify GREEN.**

  Run:

  ```bash
  node --import tsx --test tests/application-browser-control-presentation.test.ts
  ```

  Expected: PASS for every Required RED Test Matrix group plus the repository-derived run-state, reviewed-packet, noncanonical-reason, exact reason-label, committed-refresh-result, and live pending-replacement cases.

- [ ] **Step 7: Run read-only backend regression proof.**

  Run:

  ```bash
  node --import tsx --test tests/application-run-routes.test.ts tests/application-run-service.test.ts tests/application-run-answer-packet-api.test.ts tests/application-run-answer-packet-service.test.ts
  ```

  Expected: PASS. These existing tests prove strict request bodies, authentication/ownership, no-store responses, exact version/reason/hash fences, packet readiness derivation, immutable answer review, safe DTOs, rollback, and verified current-packet reads. No new route tests are planned because Increment 1 does not change those contracts or implementations.

- [ ] **Step 8: Run the complete non-PostgreSQL test and browser smoke gates.**

  Run:

  ```bash
  npm test
  npm run test:browser
  ```

  Expected: PASS. The browser suite confirms frozen B2.4b inspection publication, control binding, generation invalidation, packet HTTP privacy, and trust-loss behavior remain green with no employer-write path added.

- [ ] **Step 9: Run static and production build gates.**

  Run:

  ```bash
  npm run typecheck
  npm run lint
  npm run build
  git diff --check
  ```

  Expected: every command exits zero and `git diff --check` prints nothing. PostgreSQL concurrency is not required because all API routes, services, transactions, state-machine code, packet domain/service code, and Prisma files remain byte-for-byte unchanged; the exact-SHA CI PostgreSQL harness plus the focused read-only server regressions cover the unchanged concurrency authority.

- [ ] **Step 10: Prove scope and binding privacy from the final diff.**

  Run:

  ```bash
  git diff --name-only 2e50af33cb939286da5f7354e1e66ecebb570b53

  git diff \
    2e50af33cb939286da5f7354e1e66ecebb570b53 \
    -- \
    components/application-browser-control.tsx \
    lib/application-browser/control-presentation.ts \
    tests/application-browser-control-presentation.test.ts
  rg -n "FILL_APPROVED_FIELDS|APPLICATION_FILL|requestSubmit|form\.submit|fillAttemptId|fillLeaseExpiresAt" components/application-browser-control.tsx lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  ```

  Expected: the name list contains exactly, and contains nothing beyond:

  ```text
  components/application-browser-control.tsx
  lib/application-browser/control-presentation.ts
  tests/application-browser-control-presentation.test.ts
  ```

  The review confirms every HTTP review action remains outside the binding. The ripgrep command exits `1` with no matches.

- [ ] **Step 11: Commit Task 3.**

  ```bash
  git add components/application-browser-control.tsx lib/application-browser/control-presentation.ts tests/application-browser-control-presentation.test.ts
  git commit -m "Expose review resolution on browser control"
  ```

## Required RED Test Matrix

| # | Planned RED case | Task | Primary assertion |
|---:|---|---:|---|
| 1 | Pending proposable answer | 1/2 | Shows enabled `Approve` and `Reject` only from the eligibility predicate |
| 2 | Pending manual-only answer | 1/2 | Shows neither mutation button |
| 3 | Pending excluded answer | 1/2 | Shows neither mutation button |
| 4 | Pending unsupported answer | 1/2 | Shows neither mutation button |
| 5 | Approved proposable answer | 1/2 | Shows neither mutation button |
| 6 | Rejected proposable answer | 1/2 | Shows neither mutation button |
| 7 | Approve request | 1/2 | Exact run/answer/version and `{ status: "APPROVED", answerPacketVersion }`; no proposal |
| 8 | Reject request | 1/2 | Exact run/answer/version and `{ status: "REJECTED", answerPacketVersion }`; no proposal |
| 9 | Answer review with committed refresh | 2 | `COMMITTED` is returned; refreshed data changes UI and only then is success copy shown |
| 10 | Stale answer review | 2 | Old packet becomes inert before held automatic refresh settles |
| 11 | `401`/`403`/`404` | 2/3 | Clear review authority and show bounded fail-closed copy |
| 12 | `429`/`5xx`/network | 2/3 | Preserve display for context, create no authority, disable mutation until refresh |
| 13 | Malformed review response | 1/2/3 | Invalid JSON/schema creates no success and marks data inert |
| 14 | Wrong-run review response | 1/2/3 | Strict identity parser rejects; no local authority or success notice |
| 15 | Duplicate click | 2/3 | Synchronous global pending ref permits exactly one POST |
| 16 | Settlement after unmount | 2/3 | No state/notice/fetch/resolve/binding follow-on effect |
| 17 | Live pending authority replacement | 2/3 | Old content may remain visible while loading/unverified, but its still-connected actions are disabled/inert; after commit only the new answer/version/hash can dispatch |
| 18 | Resolve before readiness | 1/3 | Visible but disabled until trusted server-presented readiness and run state agree |
| 19 | Resolve request | 1/3 | Exact state version, ordered reasons, packet version, and packet hash only |
| 20 | Resolve with committed refresh | 3 | Starts combined refresh; only `COMMITTED` refreshed authority removes availability and permits success copy |
| 21 | Stale resolve | 3 | Does not fabricate `READY`, `reviewedAt`, or success copy |
| 22 | Binding privacy | 2/3 | Binding receives no review command/data across approve, reject, or resolve |
| 23 | Reviewed packet cannot resolve twice | 1/3 | Non-null packet `reviewedAt` keeps resolve disabled even if summary is malformedly claimed ready |
| 24 | Noncanonical review reasons | 1 | Parser rejects duplicates, unknown identifiers, and order drift before request construction |
| 25 | Run/packet read mismatch | 2 | Server `409` remains final authority; no frontend resolution is inferred |
| 26 | Current-answer identity guard | 2 | At the mounted deferred commit boundary, a still-connected old action whose answer object is no longer current sends no request; no detached DOM event is used |
| 27 | Answer mutation refresh failure | 2 | Valid POST plus `FAILED` refresh applies authority failure state and shows no mutation success |
| 28 | Answer mutation refresh superseded | 2 | Valid POST plus `SUPERSEDED` refresh shows no stale success; only the newer read may commit |
| 29 | Answer mutation refresh inactive | 2 | Valid POST plus `INACTIVE` refresh causes no state/ref/notice/follow-on effect or success |
| 30 | Resolve refresh non-commit outcomes | 3 | `FAILED`, `SUPERSEDED`, and `INACTIVE` follow the same no-success/effect rules as answer review |
| 31 | Exact review-reason labels | 1/3 | All and only six identifiers map to the six exact strings; unknown cannot present; display preserves server order |
| 32 | Run parser strip projection | 1 | Required authority fields validate; legitimate unrelated inner DTO fields are accepted then excluded from the projection |
| 33 | Run parser strict top level | 1 | Any unexpected key beside top-level `run` is rejected |
| 34 | Automatic refresh supersession | 2/3 | Automatic packet/review refresh shares the read sequence and suppresses success from an older mutation-triggered refresh |

## Commit Strategy

1. `Add review UI request contracts`
   - Exact files: `lib/application-browser/control-presentation.ts`, `tests/application-browser-control-presentation.test.ts`
   - Deliverable: pure eligibility, strict parser, and exact request contracts; independently covered by the focused control-presentation test and neighboring contract tests.
2. `Expose server-authoritative answer review`
   - Exact files: `components/application-browser-control.tsx`, `lib/application-browser/control-presentation.ts`, `tests/application-browser-control-presentation.test.ts`
   - Deliverable: combined authority reads, approve/reject reachability, global duplicate suppression, authoritative refresh, failure handling, replacement safety, unmount safety, and binding privacy.
3. `Expose review resolution on browser control`
   - Exact files: `components/application-browser-control.tsx`, `lib/application-browser/control-presentation.ts`, `tests/application-browser-control-presentation.test.ts`
   - Deliverable: exact resolve request, readiness gating, ordered reason presentation, stale/failure safety, final regression proof, and no-fill/no-submit evidence.

Each commit is independently testable and contains no backend, Prisma, binding, coordinator, companion, employer-write, fill, or submit implementation.

## Execution Start Checkpoint

Before Task 1 or any implementation edit, verify that implementation starts from exact SHA `2e50af33cb939286da5f7354e1e66ecebb570b53`. If it does not, STOP before editing and require a separately human-reviewed rebase/replan. Use only that explicit SHA as the implementation base in the final scope proof.

## Completion Gate

Increment 1 is complete only when all of the following are true:

- Approve and reject are reachable from the authenticated browser-control page and remain server-authoritative.
- Answer mutation controls exist only for `PENDING + PROPOSABLE`.
- Resolve review is reachable with exact current `stateVersion`, ordered `acknowledgedReviewReasons`, `answerPacketVersion`, and `packetHash`.
- Readiness only enables the UI; the server retains final review-resolution authority.
- Every schema-valid mutation response is only a refresh trigger. The UI presents success only when the awaited authoritative run+packet refresh returns `outcome === "COMMITTED"`; `FAILED`, `SUPERSEDED`, and `INACTIVE` never present mutation success.
- The refresh result contract is deterministic at every exit: `COMMITTED` means the active/current read committed both parsed authorities to state and ref; `FAILED` means the active/current read applied its documented failure state; `SUPERSEDED` means a newer authority-read sequence owns all effects; `INACTIVE` means generation invalidation permits no state/ref/notice/follow-on effect.
- Stale/conflict, auth/ownership/not-found, rate-limit, transient, network, malformed, and wrong-identity outcomes fail closed.
- Duplicate actions are suppressed across the entire review mutation surface.
- Late/unmounted responses are inert and cannot start a refresh, resolve, recovery, notice, or binding call.
- Packet replacement invalidates all old answer actions and resolve snapshots.
- Live actions displayed during a held authority replacement are disabled/inert, and after replacement only the new answer identity and packet version can dispatch.
- All and only the six closed review-reason identifiers render the six exact `REVIEW_REASON_LABELS` strings in server-owned order; unknown identifiers cannot pass parsing.
- The run response parser uses a strict top-level `{ run }`, validates the minimum inner authority fields, deliberately strips legitimate unrelated inner DTO fields, checks expected run identity, and reuses the same projection for run GET and resolve POST.
- Answer IDs, proposals, packets, review status requests, and resolve bodies never enter `APPLICATION_BROWSER_BINDING_NAME`.
- No employer write, fill, upload, click, submit, or submission-detection capability exists.
- Frozen B2.4b browser behavior remains green.
- The focused control-presentation/mounted-component test passes.
- Neighboring browser-control tests pass.
- Existing backend review, route, packet DTO, and packet verification regressions pass read-only.
- `npm test` passes.
- `npm run test:browser` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run build` passes.
- `git diff --check` is clean.
- Final implementation diff contains only `components/application-browser-control.tsx`, `lib/application-browser/control-presentation.ts`, and `tests/application-browser-control-presentation.test.ts` unless a separately reviewed backend precondition gap is proven before execution.

The PostgreSQL concurrency harness is intentionally excluded from the Increment 1 execution gate. The exact-SHA baseline already passed it, and this plan changes no database schema, transaction, lock order, service, API route, packet verification, state transition, or concurrency-sensitive backend code.

## Spec Coverage Map

| Frozen Increment 1 requirement | Planned coverage |
|---|---|
| Review UI reachable before fill | Tasks 2 and 3 mounted UI tests |
| `PENDING + PROPOSABLE` only | Task 1 predicate and Task 2 six-state render matrix |
| Exact approve/reject requests without proposal | Task 1 builders and Task 2 captured-fetch assertions |
| Exact resolve authority from current reads | Existing run/packet GET findings, Task 1 builder, Task 3 mounted request |
| Server-authoritative refresh | Task 2 deterministic four-outcome loader and both mutation success suites; success copy only after `COMMITTED` |
| Stale/conflict safety | Failure table and Tasks 2/3 held-refresh tests |
| Auth/ownership/not-found safety | Failure table and Tasks 2/3 status matrix |
| Rate-limit/transient safety | Failure table and Tasks 2/3 status/network matrix |
| Malformed/wrong-run safety | Task 1 parsers and Tasks 2/3 mounted response cases |
| Duplicate suppression | Global pending ref and Tasks 2/3 double-action cases |
| Unmount/late settlement | Generation/abort rules and Tasks 2/3 deferred settlements |
| Packet replacement | Atomic `ReviewLoad`, live pending-replacement test, and direct still-connected current-object dispatch-guard test |
| Resolve availability | Task 1 predicate and Task 3 readiness/state/reviewedAt matrix |
| Review-reason presentation | Task 1 exact six-entry pure mapping tests and Task 3 server-order rendering |
| Run parser precision | Task 1 strict top-level, `.strip()` inner projection, identity, invalid state/reason, and legitimate-extra-field tests |
| Binding privacy | Read-only binding types plus mounted spies in Tasks 2/3 |
| Accessibility/copy | Task 2 action labels/live notices and Task 3 described readiness/reasons |
| No fill/no submit | Global constraints, read-only paths, final source scan, completion gate |

## Plan Self-Review Record

- **Spec coverage:** Every Increment 1 requirement in frozen design sections 8, 17 privacy boundary, 23 no-submit invariant, 24 Increment 1, and 27 acceptance criteria maps to a task and test above. Later-increment executable work is absent.
- **Placeholder scan:** Clean. Every implementation step names exact behavior, interfaces, commands, expected red/green outcome, file scope, and commit.
- **Refresh-result consistency:** `fetchReviewAuthority(expectedGeneration?: number | null): Promise<ReviewAuthorityRefreshResult>` and the exact `COMMITTED | FAILED | SUPERSEDED | INACTIVE` outcomes are used consistently in Planned Interfaces, Tasks 2/3, the failure table, RED matrix, and completion gate. No valid POST alone authorizes success, and automatic refresh supersession cannot create stale success copy.
- **Type/interface consistency:** The same `ReviewRunAuthority`, `REVIEW_REASON_LABELS`, `PendingReviewMutation`, `SameOriginReviewRequest`, parser, predicate, and builder names/signatures are used in all tasks and tests. Request property names exactly match the current server schemas.
- **Exact implementation base:** Final scope commands compare against `2e50af33cb939286da5f7354e1e66ecebb570b53`; no relative-revision scope base remains. A different implementation start SHA requires a separately reviewed rebase/replan before editing.
- **Live stale-action proof:** Primary replacement coverage holds old content visibly inert during a pending authority read, then proves only the new answer identity/version dispatches. The current-object guard is exercised at a still-connected React commit boundary; no detached-node event is planned.
- **Review-reason copy:** The pure mapping contains exactly the six approved strings, has no unknown fallback, and preserves the server-owned reason order.
- **Run-parser precision:** Top-level response shape is strict; minimum inner authority fields are validated and unrelated legitimate run DTO fields are explicitly stripped from the returned projection. The same parser covers run GET and resolve POST.
- **Scope:** Only two existing production files and one existing test file are planned for implementation. No page, API, service, packet-domain, Prisma, companion, coordinator, bridge, or execution-token change is included.
- **No fill/no submit:** No command, scope, API, state activation, schema field, DOM writer, employer control operation, upload, or submission behavior is introduced.
