# Application Browser Companion

The application browser companion is a local Node.js process that launches a headed Playwright Chromium window. It is not a Vercel runtime and does not run Chromium in the deployed Next.js process.

The companion opens the immutable employer target frozen on an owned `ApplicationRun` and can inspect the visible form after an explicit command. A successful inspection is correlated and published through Apply Pilot's authenticated, owner-scoped services. The trusted control page reads the current answer packet for review and, only after a separate explicit user action, can ask the existing guarded Fill orchestration to process reviewed supported fields. The companion does not click employer controls, upload files, automate employer authentication, or submit an application.

## Install

Install repository dependencies and the pinned Chromium build:

```bash
npm install
npm run browser:install
```

Chromium is stored in Playwright's normal external browser cache. No browser binary or profile is written into the repository.

If Chromium is absent, the companion stops with:

```text
Apply Pilot Chromium is not installed. Run: npm run browser:install
```

Run the install command above and start the companion again.

## Start one workflow

The Apply Pilot application must already be running at the configured origin. Start the companion with one canonical Apply Pilot origin and one `ApplicationRun` ID:

```bash
npm run application-browser -- \
  --app-origin http://localhost:3000 \
  --run-id clz8w7m9a0002qwer1234tyui
```

The companion accepts no employer URL, authentication token, cookie, answer, document content, or selector. Non-loopback Apply Pilot origins must use HTTPS. Loopback HTTP is supported deliberately for local development and tests.

Chromium always runs headed in the production companion. If the control route redirects to sign-in, authenticate manually in that headed Apply Pilot window. The page-scoped bridge is installed only after the exact authenticated route `/application-runs/<run-id>/browser` loads for the owned run.

The first MVP supports anonymous employer targets only. Employer login, MFA, SSO, email codes, password entry, account creation, and CAPTCHA handling are unsupported. If the frozen target cannot be reached exactly without employer authentication, the workflow stops safely for manual handling.

## Controls, inspection, Fill, and safety

The bounded control binding exposes seven exact, payload-free commands:

- `GET_STATUS`
- `OPEN_TARGET`
- `INSPECT_FORM`
- `FILL_APPROVED_FIELDS`
- `HANDOFF_TO_HUMAN`
- `END_HUMAN_SESSION`
- `CLOSE_WORKFLOW`

No command accepts a run ID, URL, proposal, answer ID, packet hash, version, selector, or other Fill material from React. The companion reads the owner-scoped run and effective automation policy through the active Playwright context, then opens only `run.applyUrlSnapshot` after applying the frozen host and policy checks. `INSPECT_FORM` is available only after the frozen target is open. It reports bounded progress and either material publication, replay of an already-current packet, reinspection-required, or a recoverable safe-stop outcome.

Packet contents never travel through the page binding or companion output. The authenticated control page reads `GET /api/application-runs/<run-id>/answer-packet` through its normal same-origin web session and uses owner-scoped APIs for answer approval/rejection and review resolution. Fill becomes available only when the owner page, companion status, current successful inspection, reviewed packet, `READY` run, and durable no-attempt Fill status agree, and at least one reviewed supported field appears eligible. Client-side gating is presentation only; the coordinator and server recheck the real authority.

`FILL_APPROVED_FIELDS` is allowed only in the companion's `TARGET_OPEN` workflow state and only from the user's explicit **Fill approved fields** click. The command input remains payload-free. The coordinator retains `IN_PROGRESS` before invoking the accepted guarded Fill orchestration and invokes that orchestration once. A concurrent double activation and later activation for the same published generation return the retained bounded command status instead of acquiring or writing again. The bridge returns the existing bounded outer `B1Status` used by the trusted owner control page; that status may contain its existing workflow state, run ID, target host, and inspection metadata or versions. Its nested `fillCommand` member is the disposition-only addition and exposes only `IN_PROGRESS`, `FINALIZED`, `RECOVERY_PENDING`, `CANCELLED`, or one of the closed acquisition rejection categories. `fillCommand` never exposes an attempt ID, lease, proposal, answer identity, packet/form/field fingerprint, step key, selector, target URL, employer value, candidate object, raw response body, or arbitrary exception text.

Before Fill, the control page requires a separate acknowledgement that employer page scripts may transmit entered values to the employer or third parties before Submit. Local interception of synthetic requests is no assurance of network-free Fill or employer delivery.

Fill is intentionally long-running: the control page adds no binding timeout and does not abort the Playwright operation when React unmounts. Once the binding was invoked, the page never automatically invokes Fill again. If the binding result is lost, it marks presentation authority unverified, performs one read-only authenticated Fill-status GET and one paired run/packet refresh, and shows uncertainty guidance. It does not use generic `GET_STATUS` recovery as a reason to replay the mutation.

Durable presentation comes from `GET /api/application-runs/<run-id>/fill-attempt` with `no-store`, not from the bridge result. The page reads it on mount and at explicit synchronization points, rejects lower state versions, rejects contradictory same-version snapshots, and never polls or mutates in response. Terminal results are shown only as aggregate counts for filled, preserved-existing, runtime-manual, failed, and not-attempted steps. Step identities and field values are never rendered. Radio groups, checkbox booleans, manual-only, excluded, unsupported, and rejected fields are listed as manual work using public packet metadata only.

There is no Fill retry button, expired-attempt recovery button, background recovery, or recovery polling. `RECOVERY_PENDING` remains read-only. After any final, uncertain, rejected, or cancelled result, the user reviews every employer field and completes all remaining work manually.

If the employer form changes, the page marks the prior packet stale and requires reinspection. Recoverable inspection failures retain safe retry guidance without inventing browser workflow state. Connection loss preserves the last authoritative companion status. For non-Fill commands it offers only the existing bounded recovery where allowed; a possibly dispatched Fill is never replayed.

The control and employer pages start in separate non-persistent browser contexts. Only the control context holds the authenticated Apply Pilot session and page-scoped binding. The employer page has no opener and receives neither owner cookies nor a command binding. While automation is active, the employer page is frozen at the exact target. A later main-document request is blocked; this includes a form POST even when its URL equals the target, because a browser redirect could otherwise bypass the page route. Unexpected popups, control-route trust loss, stale bridge generations, disallowed redirects, and unsupported authentication flows stop the workflow safely.

After the Fill result is verified and protected work is settled, the owner may separately confirm **Finish manually in this browser**. `HANDOFF_TO_HUMAN` closes new inspection/Fill admission, retires the protected session and its CDP capability, then changes the retained employer page to `HUMAN_ONLY`. A failed or uncertain fence closes the disposable resources and offers manual reentry in an ordinary browser. Handoff cannot replay Fill, and a control-page refresh or departure ends the employer session. The separate human context permits HTTPS main-document navigation for manual completion, including redirects, while blocking the configured Apply Pilot origin and private or loopback destinations. Unexpected popups close and stop the session. Employer scripts can still transmit or navigate after handoff; a confirmation-looking URL does not attest to delivery.

The human session lasts at most 60 minutes, warns at 10 and 2 minutes remaining, and cannot be extended. `END_HUMAN_SESSION` closes exact-owned browser resources sooner. Cleanup failure reports `HUMAN_SESSION_CLEANUP_UNCERTAIN`; a timeout never proves closure. The owner's existing personal-submission attestation remains a separate explicit action after they personally use the employer Submit control. It records their statement, not employer-confirmed receipt.

Closing a workflow discards its browser context. The companion does not save `storageState`, export cookies, attach to a personal Chrome profile, or persist browser state.

Apply Pilot may fill reviewed supported fields, but it never submits the employer application. The user must review the employer page, complete every remaining manual field, verify preserved values, and personally click the employer site's Submit button.

## Test locally

Fast companion and presentation tests are included in the normal suite and require no browser:

```bash
npm test
```

The deterministic synthetic smoke tests use real Chromium without a live employer site or real applicant data. They cover the trusted bridge and the visible one-shot Fill activation through the protected writer, including six writable families, occupied-value preservation, serialized server order, and rapid double activation. They also exercise separate contexts, protected retirement, and local collector attribution of attempted, received, and completed synthetic navigation. These tests do not establish live ATS support:

```bash
npm run test:browser
```

The smoke test may run Chromium headless because it is test infrastructure; the production companion remains headed.
