export const SYNTHETIC_EMPLOYER_ORIGIN = "https://employer.example.test";
export const SYNTHETIC_EMPLOYER_TARGET_URL =
  "https://employer.example.test/applications/synthetic-human-submit-v1";
export const SYNTHETIC_EMPLOYER_SUBMISSION_URL =
  "https://employer.example.test/__synthetic-human-submit";
export const SYNTHETIC_EMPLOYER_NAME = "Example Systems";
export const SYNTHETIC_EMPLOYER_ROLE = "Synthetic Customer Success Engineer";

const FIXTURE_WINDOW_STATE_KEY = "__APPLY_PILOT_SYNTHETIC_EMPLOYER_STATE__";
const GUARDED_SUITE_MARKER = "SYNTHETIC_FULL_WORKFLOW_E2E";

export type SyntheticSubmissionRequestState = "NOT_STARTED" | "PENDING" | "SUCCEEDED" | "FAILED";

export type SyntheticEmployerSnapshot = Readonly<{
  submitEventCount: number;
  submitControlClickCount: number;
  requestSubmitCallCount: number;
  formSubmitCallCount: number;
  formDataEventCount: number;
  mainFrameNavigationCount: number;
  popupCount: number;
  humanStepArmed: boolean;
  lastSubmitClickWasTrusted: boolean;
  violationCount: number;
  submissionRequestState: SyntheticSubmissionRequestState;
}>;

type SyntheticFixturePage = Readonly<{
  url(): string;
  evaluate(pageFunction: () => unknown): Promise<unknown>;
}>;

const snapshotKeys = [
  "submitEventCount",
  "submitControlClickCount",
  "requestSubmitCallCount",
  "formSubmitCallCount",
  "formDataEventCount",
  "mainFrameNavigationCount",
  "popupCount",
  "humanStepArmed",
  "lastSubmitClickWasTrusted",
  "violationCount",
  "submissionRequestState"
] as const;

const counterKeys = [
  "submitEventCount",
  "submitControlClickCount",
  "requestSubmitCallCount",
  "formSubmitCallCount",
  "formDataEventCount",
  "mainFrameNavigationCount",
  "popupCount",
  "violationCount"
] as const;

export function createInitialSyntheticEmployerSnapshot(): SyntheticEmployerSnapshot {
  return {
    submitEventCount: 0,
    submitControlClickCount: 0,
    requestSubmitCallCount: 0,
    formSubmitCallCount: 0,
    formDataEventCount: 0,
    mainFrameNavigationCount: 0,
    popupCount: 0,
    humanStepArmed: false,
    lastSubmitClickWasTrusted: false,
    violationCount: 0,
    submissionRequestState: "NOT_STARTED"
  };
}

export function parseSyntheticEmployerSnapshotValue(value: unknown): SyntheticEmployerSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid synthetic employer fixture snapshot.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...snapshotKeys].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Invalid synthetic employer fixture snapshot.");
  }
  for (const key of counterKeys) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error("Invalid synthetic employer fixture snapshot.");
    }
  }
  if (typeof record.humanStepArmed !== "boolean" || typeof record.lastSubmitClickWasTrusted !== "boolean") {
    throw new Error("Invalid synthetic employer fixture snapshot.");
  }
  if (!["NOT_STARTED", "PENDING", "SUCCEEDED", "FAILED"].includes(record.submissionRequestState as string)) {
    throw new Error("Invalid synthetic employer fixture snapshot.");
  }
  return { ...record } as SyntheticEmployerSnapshot;
}

export function readSyntheticEmployerWindowSnapshot(windowValue: unknown): SyntheticEmployerSnapshot {
  const windowRecord = windowValue as Record<string, unknown>;
  return parseSyntheticEmployerSnapshotValue(windowRecord[FIXTURE_WINDOW_STATE_KEY]);
}

function assertGuardedFixturePage(page: SyntheticFixturePage): void {
  if (process.env[GUARDED_SUITE_MARKER] !== "1") {
    throw new Error("Synthetic human-step helpers require the guarded synthetic full-workflow suite.");
  }
  if (page.url() !== SYNTHETIC_EMPLOYER_TARGET_URL) {
    throw new Error("Synthetic human-step helpers require the exact synthetic employer fixture page.");
  }
}

export async function readSyntheticEmployerSnapshot(page: SyntheticFixturePage): Promise<SyntheticEmployerSnapshot> {
  assertGuardedFixturePage(page);
  const value = await page.evaluate(() => {
    return (window as unknown as Record<string, unknown>).__APPLY_PILOT_SYNTHETIC_EMPLOYER_STATE__;
  });
  return parseSyntheticEmployerSnapshotValue(value);
}

export async function armSyntheticHumanSubmission(page: SyntheticFixturePage): Promise<void> {
  assertGuardedFixturePage(page);
  await page.evaluate(() => {
    const state = (window as unknown as Record<string, unknown>).__APPLY_PILOT_SYNTHETIC_EMPLOYER_STATE__ as
      | Record<string, unknown>
      | undefined;
    if (!state || state.submissionRequestState !== "NOT_STARTED" || state.humanStepArmed !== false) {
      throw new Error("Synthetic employer fixture is not at the pre-human submission boundary.");
    }
    state.humanStepArmed = true;
  });
}

export function assertNoSyntheticEmployerSubmission(
  snapshot: SyntheticEmployerSnapshot,
  syntheticSubmissionEndpointCount: number
): void {
  const violations = [
    ...counterKeys
      .filter((key) => snapshot[key] !== 0)
      .map((key) => `${key}=${snapshot[key]}`),
    ...(syntheticSubmissionEndpointCount === 0
      ? []
      : [`syntheticSubmissionEndpointCount=${syntheticSubmissionEndpointCount}`])
  ];
  if (violations.length > 0) {
    throw new Error(`Synthetic employer submission boundary was crossed: ${violations.join(", ")}.`);
  }
}

export function renderSyntheticEmployerFixture(): string {
  const initialState = JSON.stringify(createInitialSyntheticEmployerSnapshot());
  const stateKey = JSON.stringify(FIXTURE_WINDOW_STATE_KEY);
  const endpoint = JSON.stringify(SYNTHETIC_EMPLOYER_SUBMISSION_URL);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${SYNTHETIC_EMPLOYER_ROLE} — ${SYNTHETIC_EMPLOYER_NAME}</title>
  </head>
  <body>
    <main>
      <h1>${SYNTHETIC_EMPLOYER_ROLE}</h1>
      <p>${SYNTHETIC_EMPLOYER_NAME}</p>
      <dl aria-label="Synthetic applicant identity">
        <dt>Applicant</dt><dd>Alex Example</dd>
        <dt>Email</dt><dd>alex.example@example.test</dd>
      </dl>
      <form aria-label="Synthetic job application">
        <label for="portfolio-url">Portfolio URL</label>
        <input id="portfolio-url" name="portfolioUrl" type="url" value="">

        <label for="profile-url">LinkedIn profile URL</label>
        <input id="profile-url" name="profileUrl" type="url" value="https://existing-profile.example.test/alex">

        <label for="availability">When can you start?</label>
        <textarea id="availability" name="availability"></textarea>

        <label for="manual-certification">
          <input id="manual-certification" name="manualCertification" type="checkbox" required>
          I certify that I reviewed this synthetic application
        </label>

        <button type="submit">Submit synthetic application</button>
      </form>
    </main>
    <script>
      (() => {
        "use strict";
        const state = Object.seal(${initialState});
        const stateKey = ${stateKey};
        const submissionEndpoint = ${endpoint};
        const form = document.querySelector("form");
        const submitControl = document.querySelector("button[type='submit']");
        Object.defineProperty(window, stateKey, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: state
        });

        const requestSubmit = HTMLFormElement.prototype.requestSubmit;
        Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", {
          configurable: true,
          writable: true,
          value: function syntheticBlockedRequestSubmit() {
            state.requestSubmitCallCount += 1;
            state.violationCount += 1;
          }
        });

        const submit = HTMLFormElement.prototype.submit;
        Object.defineProperty(HTMLFormElement.prototype, "submit", {
          configurable: true,
          writable: true,
          value: function syntheticBlockedFormSubmit() {
            state.formSubmitCallCount += 1;
            state.violationCount += 1;
          }
        });

        window.addEventListener("beforeunload", () => {
          state.mainFrameNavigationCount += 1;
        });
        window.open = function syntheticBlockedPopup() {
          state.popupCount += 1;
          state.violationCount += 1;
          return null;
        };

        form.addEventListener("formdata", () => {
          state.formDataEventCount += 1;
        });
        submitControl.addEventListener("click", (event) => {
          state.submitControlClickCount += 1;
          state.lastSubmitClickWasTrusted = event.isTrusted === true;
        }, true);
        form.addEventListener("submit", (event) => {
          state.submitEventCount += 1;
          event.preventDefault();
          if (state.humanStepArmed !== true) {
            state.violationCount += 1;
            return;
          }
          state.humanStepArmed = false;
          if (state.submissionRequestState !== "NOT_STARTED") {
            state.violationCount += 1;
            return;
          }

          new FormData(form);
          state.submissionRequestState = "PENDING";
          window.fetch(submissionEndpoint, {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ submission: "synthetic-human-submit-v1" })
          }).then((response) => {
            if (!response.ok) throw new Error("synthetic endpoint rejected submission");
            state.submissionRequestState = "SUCCEEDED";
          }).catch(() => {
            state.submissionRequestState = "FAILED";
          });
        });

        void requestSubmit;
        void submit;
      })();
    </script>
  </body>
</html>`;
}
