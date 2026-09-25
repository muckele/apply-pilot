# Apply Pilot — Managed Application Workspace Architecture Brief

Version 2.0 | 2026-09-20
**Status: proposed implementation design supporting the approved web-first direction. Not implemented, procured, or authorized for live execution by this document.**

Read with [roadmap](../PRODUCT_ROADMAP.md), [provider evaluation](MANAGED_BROWSER_PROVIDER_EVALUATION.md), [release gates](RELEASE_GATES_AND_ACCEPTANCE.md), and [sources](RESEARCH_SOURCES.md). Source observations are labeled; requirements below are Apply Pilot design recommendations unless explicitly identified as current behavior.

## 1. Product experience and architectural distinction

The customer uses Apply Pilot in their preferred supported browser. A separate managed Chromium session opens the employer form. The application displays an authorized live view of that session and its task status. The user reviews materials, approves supported Fill, handles manual fields, and personally activates employer Submit through the human-control surface.

The client browser is not the automation browser. A Safari user does not need Chrome installed merely because the executor uses Chromium. This is the design target, not a browser-support claim already validated.

A normal cross-origin employer iframe is not an automation solution: ordinary same-origin restrictions limit the app's access to another site's document. The intended embedded surface is a provider/owned remote-browser viewer, not an attempt to bypass employer embedding or origin controls. [MB08]

Current source launches a separate local headed Chromium runtime, not a managed hosted workspace. Reuse its accepted policy contracts after source-led review, but do not assume its test launcher seam is an approved production integration seam. [R07]

## 2. Minimum customer journey

1. Sign in to Apply Pilot in a supported modern browser.
2. Import or review career facts and job preferences.
3. Select a suitable job and review its source/requirements.
4. Prepare and approve the job-specific package before a browser session is allocated where practical.
5. Read the data-processing disclosure and start the application workspace.
6. Inspect the employer form through the existing protected path; review proposals and manual work.
7. Explicitly activate the one allowed Fill when all gates pass.
8. Take human control after agent writes are revoked; complete manual fields and submit on the employer page.
9. Return to the separate Apply Pilot completion panel and make the existing two-step attestation.
10. End the session; observe closed/closing/termination-unverified status accurately.

No terminal, driver installation, required extension, or browser switch in the public path. Necessary user authentication, employer checks, and manual data entry may still exist. Do not market no-download as frictionless or universal automation.

## 3. Logical components

| Component | Owns | Must not own by convenience |
|---|---|---|
| Web application | Profile/material review, job selection, workspace UI, user intent | Provider master credentials, raw CDP credentials, arbitrary backend browser commands |
| Application/policy service | Existing run lifecycle, grants, owner checks, reviewed versions, mutation identity | Trust in a page instruction or viewer event as user approval |
| Session broker | Mapping user/run to provider session, access issuance, expiry, revocation | Unbounded creation from client-supplied provider IDs or URLs |
| Execution worker | Approved finite actions against one owned target, liveness/cost reporting | Generic model-written code, unrestricted browsing, automatic employer Submit in P0–P2 |
| Runtime provider adapter | Provision/attach/observe/revoke/terminate with typed capability evidence | Expanding product authority because a vendor supports extra APIs |
| Human-control gateway/viewer | Authenticated user's bounded access to their employer session/page | Model access to human pointer/keyboard/upload/submit controls |
| Durable state and event ledger | Current ownership epoch, command intents/outcomes, session state, billing facts | Real applicant DOM dumps or unredacted recording by default |
| Reconciler/watchdog | Resolve ambiguous session lifecycle and terminate owned orphans | Blind replay of application mutations or broad process/connection kills |

These are logical responsibilities, not a mandate for eight new services. Prefer a small implementation using current modules and a narrowly scoped durable worker/session boundary. Pick deployment placement from measured lifetime/network requirements, not from a generic microservice template.

## 4. Trust boundaries

The design introduces four explicit boundaries: applicant browser ↔ Apply Pilot API; Apply Pilot control plane ↔ managed-browser provider; worker ↔ employer page; human viewer ↔ the same remote employer page. Each has independent credentials, authorization, and lifecycle.

A compromised employer page must not obtain the application's privileged control binding, provider key, package service credentials, or other tenants' sessions. A stolen viewer URL must not become a reusable master browser connection. A provider connection error must not create new application authority. A job-description instruction must never influence destinations, tools, budgets, or policies.

Remote-browser providers can process screenshots, DOM, keystrokes, cookies, and uploaded documents while operating the session. Encryption in transit and an isolated JavaScript world do not make that data invisible to the provider. State this accurately in privacy design and user copy.

## 5. Runtime-provider contract: proposal, not existing API

A future provider boundary should be small and explicit. Suggested operations are provision a synthetic/real session under policy, attach an execution channel, obtain a restricted viewer handle, revoke viewer access, inspect session status, and request exact-session termination.

The contract should carry capability facts such as protocol/version, isolated-world support, creation expiry, runtime limits, viewer mode support, page scoping, server-side input control, recording/log controls, persistence settings, and termination verification. Unknown capabilities are not treated as supported.

Do not pass arbitrary provider options from client input. Validate identifiers server-side against the owner/run record. No publicly reachable raw debugging endpoint. A provider-generated bearer URL remains a credential even if it contains no account API token.

Provider selection is not failover permission. If the original session may have sent employer data, moving to a second vendor or creating a replacement session requires reconciliation; it cannot silently replay Fill or submission.

## 6. Protocol and topology feasibility

Verify the exact installed runtime and target provider combination. Playwright distinguishes its native protocol from CDP and warns that CDP attachment has lower fidelity for advanced functionality. Connection compatibility alone does not establish protected execution parity. [MB05]

The H1 acceptance case must exercise isolated-world creation, fixed-method calls, target lifetime, route interception, page replacement, frame identity, multiple tabs, disconnection, and exact owned cleanup. If a hosted service cannot supply these invariants, select a different runtime or stop for an explicit architecture design. Do not weaken safeguards to fit a vendor SDK.

A cloud browser cannot reach `127.0.0.1` on Mathew's laptop. Do not open an unauthenticated tunnel to local Next or the test database. Synthetic hosted evaluation needs an explicitly approved reachable fixture/control topology. Early protocol proof can use a controlled synthetic page without a production database. Any later staging/database arrangement needs its own authorization; existing local reset/seed restrictions stay in force.

Long-lived sessions require a worker lifecycle that can outlive a request without losing ownership. Do not assume the current web hosting runtime can retain a Chromium process or persistent socket for the necessary duration. Evaluate supported execution placement before coding.

## 7. Suggested session states separate from ApplicationRun

The following are conceptual session states, not existing Prisma enums or permission to migrate schema:

`REQUESTED → PROVISIONING → ATTACHED → AUTOMATION_ACTIVE → HANDOFF_PENDING → HUMAN_ACTIVE → CLOSING → CLOSED`

Exceptional states may include `PAUSED`, `RECONNECTING`, `EXPIRED`, `FAILED`, and `TERMINATION_UNVERIFIED`. Their exact names and transitions need source-led design.

ApplicationRun remains the durable business record. A session closing does not mean an application was submitted. A human viewer disconnecting does not mean review completed. Provider session status `COMPLETED` is not employer acceptance. Do not map similarly named vendor states into application completion automatically.

Session records should include opaque owner/run IDs, provider session ID, immutable target reference, grant/ownership epoch, timestamps, runtime/config versions, budget reservation ID, and last known termination evidence. Store secret URLs separately or mint them briefly; do not put them in general event records or logs.

## 8. Exclusive human/agent control

Only one actor may change the employer session at a time. Proposed transition:

1. User requests takeover in the authenticated web app.
2. Backend records a new ownership epoch and blocks new automated commands.
3. In-flight authorized action reaches a known safe boundary or the handoff stops.
4. Existing automation authority and stale writer bindings are revoked/inactivated.
5. Only then issue or activate an interactable human viewer for the exact employer page.
6. Human interaction marks affected inspection/packet authority stale where required.
7. On return, re-read durable state and reconcile; do not automatically reauthorize a consumed Fill.

Enforce this in the backend/gateway and at the mutation boundary. Hiding a button or applying CSS `pointer-events: none` is not access revocation. Browserless documents a server-enforced read-only viewer option; any chosen vendor still needs an actual bypass/revocation test in our integration. [MB04]

A malicious client can forge a “human mode” event. Human-only access must require a session-bound authorization issued after owner authentication. The model/worker should never receive the same interaction credential. This demonstrates capability separation, not physical-human detection.

## 9. Human Submit and navigation handoff

PR #7 implemented an irreversible **local** handoff through `HANDOFF_TO_HUMAN` and `END_HUMAN_SESSION`. It retires automation authority before Mathew personally completes the employer flow; the protected automated frozen-target guard is not globally disabled. Local synthetic evidence does not yet prove confirmation navigation on a genuine intended employer application. Verify that in P0.4 without granting the agent navigation or Submit authority.

A **hosted** handoff still needs a separately reviewed human-control channel, scoped viewer access, server-enforced revocation of automated writes, and safe recovery. The local handoff is the behavior to preserve, not evidence that a remote viewer or provider has passed those gates.

Current Human-Submit means the user's own input activates employer Submit. An “Approve” button that asks a server/LLM to click Submit would be new submission automation and is not P2 merely because approval occurred earlier.

After the employer step, preserve the separate two-step attestation. Neither navigation, viewer disconnect, a string reading “thank you,” nor provider session end automatically records `COMPLETED_BY_USER`.

## 10. Viewer access and browser support

A viewer grant should be short-lived, owner/session/page-bound, scoped read-only or human-interactable, revocable, and excluded from logs/referrers/analytics. Validate event origin and source for any `postMessage`; a message is a UI signal, not authoritative proof of mutation or completion. Multi-tab URLs and debugging surfaces need an explicit exposure review; never accidentally give the user a control-plane page, unrelated session, or unrestricted DevTools.

A provider link may be a bearer capability accessible to anyone holding it. Wrapping it in an authenticated webpage does not automatically bind direct access to the Apply Pilot account. Test direct-link access, expiry, revocation, sharing, replay, browser-back caching, and cross-tenant use. If provider-side identity binding is insufficient, design a broker/proxy or reject the delivery mode rather than claiming account-bound security.

Verify actual Safari, Firefox, Chrome, and Edge combinations. Test third-party storage restrictions, iframe policy, popup behavior, clipboard permissions, disconnect signaling, zoom, and keyboard focus. Provider live-view documents establish availability of an interface, not our support matrix. Browserbase's live-view documentation explicitly notes mobile keyboard limitations. [MB01]

## 11. Files, login, MFA, and credentials

The user's local files and employer login do not automatically exist remotely. Keep automated upload out of the current command grammar. A later user-directed file bridge may allow a person to select an approved immutable resume and deliberately attach it in the human-controlled session. That needs a distinct file-delivery design: exact owner, document hash, content/size/type checks, short-lived access, virus/content handling as applicable, and deletion.

Do not inject arbitrary bytes into employer file inputs under the name manual upload. Do not expose all user documents to the browser provider. Show which exact resume version is being transferred, and avoid retaining extra copies.

Similarly, user-directed hosted authentication is not automatic login authority. Review passkeys, device-bound factors, MFA, region changes, account policies, and accessibility. Do not capture secrets in logs, screenshots, clipboard telemetry, or recording. Persistent login contexts require explicit consent, isolation, encryption, retention, revocation, and deletion evidence. The default proposed public scope remains anonymous direct application forms until separately expanded.

Do not enable vendor CAPTCHA solvers, stealth/evasion modes, or rotating-proxy features merely because they are available. A challenge remains a pause/manual unsupported condition under current policy; vendor feature breadth does not expand authority.

## 12. Privacy and recording defaults

Proposed defaults: ephemeral context; recording disabled; unnecessary console/network logging disabled; no raw applicant values in product diagnostics; approved documents accessible only when needed; credential/context persistence off; sensitive retention minimized. Record the effective provider configuration, not just the configuration request.

Browserbase documentation states recording is enabled by default and can be disabled while live viewing remains available. This is a reason to test defaults and downstream artifacts explicitly. Disabling video is not proof that logs or browser state are deleted. [MB02]

Review provider terms, processor obligations, region, subprocessors, data access, support access, backups, deletion latency, and incident notification before processing real applicants. Exact legal obligations depend on markets and contracts; this brief is not a legal compliance conclusion.

User copy must distinguish applicant-device processing, Apply Pilot storage, model processing, managed-browser processing, and employer processing. An input event may transmit data to the employer before the final submit control is pressed. Revocation stops future authorized work but cannot unsend already transmitted information.

## 13. Network and environment containment

Reuse positive child-environment construction and explicit dotenv-sensitive neutralization. Credentials stay server-side and are scoped to the required service. The worker gets the least required authority, not the web server's entire environment.

Separate control-plane egress from employer-browser egress. Block access to internal networks, metadata endpoints, or arbitrary user-supplied URLs as appropriate to the chosen infrastructure. Validate initial and redirected targets; a hostname allowlist alone is not a complete SSRF/DNS-rebinding design. Do not claim existing browser tests prove a future cloud network firewall.

Synthetic evaluation should deny unexpected external traffic and use synthetic values only. Live forms necessarily load remote resources; authorize those trials specifically and record minimal metadata without request payloads. Never infer absence of candidate persistence from absence of an explicit Submit request.

## 14. Disconnects, timeouts, and recovery

Distinguish client viewer loss, worker disconnect, provider session loss, application API timeout, and employer mutation ambiguity. Do not map every timeout to retry.

Read-only status checks may be retried under bounded backoff. Non-idempotent application actions must reconcile before any repeat. A reconnect can renew viewing of a still-owned session if policy permits; it cannot renew application approval, regenerate stale writer bindings silently, or reset Fill consumption. A new empty session is not recovery of unsaved employer state.

Provider session maximum duration and human-view timeout differ; for example, Browserless documents that live handoff cannot extend the session's absolute maximum. Reflect the real remaining budget in UI and worker deadlines. [MB03]

Before expiry, warn the user, avoid beginning a mutation that cannot finish within policy, and preserve approved package/business state. Never promise unsaved employer fields can be resumed unless the same live session or an authorized persistence mechanism actually proves it.

## 15. Resource ownership and operational cleanup

Each hosted session must have a durable exact owner before it becomes externally usable. Use a creation intent, bounded provisioning, idempotent reconciliation, and exact provider ID. If session creation returns ambiguously, search/reconcile by that owned intent if supported; do not repeatedly create paid sessions blindly.

Normal shutdown should revoke user/agent access, stop new work, close the runtime, request provider termination, observe a terminal status, and reconcile billing. A disconnected WebSocket is not proof the remote browser stopped. An unknown termination state becomes `TERMINATION_UNVERIFIED` or equivalent, disables further use, and requires bounded watchdog/operational follow-up. Do not report “clean” while owned resources remain unverified.

Local `BrowserServer.kill()` tests remain valuable but do not prove cloud termination. A vendor may not expose a child PID; validate its exact-session termination API and status semantics. Reject a provider if required ownership guarantees cannot be met. Never kill broad process names or other tenants' sessions.

Database cleanup remains governed by current local test rules. Await transaction outcomes and use supported engine/statement semantics; a timer observes a deadline rather than cancels SQL. Do not expand a helper-level guarantee into an absolute guarantee for arbitrary noncooperative tasks.

## 16. Scheduling and cost controls

Generate reusable materials before provisioning browsers where possible. Reserve session cost, enforce user/global concurrency, set a deliberate expiry, and measure automated time, human review dwell, idle time, reconnects, failures, and provider billable duration separately.

Do not keep hundreds of forms open awaiting indefinite human review. Queue prepared packages, allocate a browser near actual use, and stop at a known safe boundary before expiry. A future suspend/resume feature must prove what state survives; do not infer it from a persistence marketing claim.

Cache job analysis and stable approved facts safely across retries while retaining user/version isolation. Do not cache employer credentials or raw candidate DOM as a shortcut. Cost limits must fail safely without leaving ambiguous mutations or pretending a session completed.

## 17. Acceptance test inventory

| Test | Expected outcome |
|---|---|
| Two users attempt the same viewer/session identifier | Only the owner can view/control; no cross-tenant data |
| Worker command races human takeover | One actor epoch wins; revoked/stale action cannot write |
| Viewer opens provider URL directly after revocation | Access is rejected or a documented blocker remains |
| Worker crashes after Fill acquisition | No second Fill; durable reconciliation and safe pause |
| Client closes tab during human review | No inferred completion; session expires/cleans according to policy |
| Employer redirects on human Submit | Reviewed handoff works or fails safely without broad agent navigation |
| Recording/log settings drift | Session blocked before real data or privacy incident signaled |
| Provider create/terminate response lost | Exact owned intent reconciled; no duplicate paid session or false cleanup |
| Slow network and keyboard-only navigation | Usable bounded experience or honest unsupported fallback |
| Remote file attachment | Only specifically user-selected approved artifact; no generic agent upload |
| Provider-switch suggestion after possible submit | Reconcile first; no replay |
| Local and hosted synthetic workflow | Same policy semantics; differences explicitly documented |

## 18. Implementation order and stop conditions

Begin with H0 source-led feasibility planning, then a separately authorized H1 synthetic runtime proof. Do not start with billing, a generalized agent language, or a complete distributed browser platform. Reuse existing application service and proof fixtures.

Stop for design review if hosted parity requires generic evaluation, broader target authority, session tokens in public logs, unrevocable viewer access, shared user profiles, default CAPTCHA evasion, hidden recording, remote destructive database testing, or fabricated output. If human submission navigation or file handling cannot fit current safety, propose a separate narrow capability instead of bypassing it.

The output of H0 is an evidence-backed implementation plan, not vendor selection by assertion. The output of H5 is a tested public experience on declared browsers and form variants, not a promise that every job site works.
