# Application Browser Companion

The application browser companion is a local Node.js process that launches a headed Playwright Chromium window. It is not a Vercel runtime and does not run Chromium in the deployed Next.js process.

The companion opens the immutable employer target frozen on an owned `ApplicationRun` and can inspect the visible form after an explicit command. A successful inspection is correlated and published through Apply Pilot's authenticated, owner-scoped services. The trusted control page then reads and presents the current answer packet for review. The companion does not fill employer fields, click employer controls, type answers, upload files, automate employer authentication, or submit an application.

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

## Controls, inspection, and safety

The status-only control binding exposes only four commands:

- `GET_STATUS`
- `OPEN_TARGET`
- `INSPECT_FORM`
- `CLOSE_WORKFLOW`

`OPEN_TARGET` and `INSPECT_FORM` have no payload. The companion reads the owner-scoped run and effective automation policy through the active Playwright context, then opens only `run.applyUrlSnapshot` after applying the frozen host and policy checks. `INSPECT_FORM` is available only after the frozen target is open. It reports bounded progress and either material publication, replay of an already-current packet, reinspection-required, or a recoverable safe-stop outcome.

Packet contents never travel through the page binding or companion output. The authenticated control page reads `GET /api/application-runs/<run-id>/answer-packet` through its normal same-origin web session and displays packet versions, summary counts, questions, proposed answers, manual/excluded/unsupported dispositions, review status, and freshness. This presentation is read only: it cannot approve, reject, acknowledge, or resolve packet review.

If the employer form changes, the page marks the prior packet stale and requires reinspection. Recoverable inspection failures retain safe retry guidance without inventing browser workflow state. Connection loss preserves the last authoritative companion status, offers a bounded retry when allowed, and never turns a rejected page-binding promise into a fabricated coordinator error.

The employer page is created as a separate page in one non-persistent browser context and has no opener. The Apply Pilot binding is absent from the employer page. Cross-host employer navigation is aborted before it is allowed to continue, and the final URL must equal the frozen URL except for its fragment. Unexpected popups, control-route trust loss, stale bridge generations, disallowed redirects, and unsupported authentication flows stop the workflow safely.

Closing a workflow discards its browser context. The companion does not save `storageState`, export cookies, attach to a personal Chrome profile, or persist browser state.

## Test locally

Fast companion and presentation tests are included in the normal suite and require no browser:

```bash
npm test
```

The deterministic synthetic smoke test uses real Chromium without a live employer site or applicant data:

```bash
npm run test:browser
```

The smoke test may run Chromium headless because it is test infrastructure; the production companion remains headed.
