// Hypothetical, provider-neutral structures. No vendor DOM or applicant data was copied.
export const ATS_FIXTURE_VERSION = "p0.1-local-v1";

export function mixedNativeApplicationHtml(): string {
  return `<!doctype html><html><body>
    <form id="application" aria-label="Synthetic application" action="/submit" method="post">
      <input type="hidden" name="tracking" value="SYNTHETIC-HIDDEN-DO-NOT-EXPORT">
      <label for="email">Email address</label><input id="email" type="email" required>
      <label for="profile">LinkedIn profile URL</label><input id="profile" type="url" aria-describedby="profile-help">
      <span id="profile-help">A public professional profile.</span>
      <label>Resume <input id="resume" type="file" required></label>
      <label><input id="legal" type="checkbox" required>I certify this application</label>
      <button id="submit" type="submit">Submit application</button>
    </form>
    <script>
      window.transportAttempts = { fetch: 0, xhr: 0, beacon: 0, submit: 0 };
      document.querySelector('#profile').addEventListener('input', () => {
        window.transportAttempts.fetch += 1;
        fetch('/collector/fetch', { method: 'POST', body: 'synthetic' }).catch(() => {});
        window.transportAttempts.xhr += 1;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/collector/xhr');
        xhr.send('synthetic');
        window.transportAttempts.beacon += 1;
        navigator.sendBeacon('/collector/beacon', 'synthetic');
      });
      document.querySelector('#application').addEventListener('submit', () => {
        window.transportAttempts.submit += 1;
      });
    </script>
  </body></html>`;
}

export function changingSelectApplicationHtml(): string {
  return `<!doctype html><html><body><form aria-label="Synthetic options application">
    <label>LinkedIn profile URL<input id="existing" type="url" value="https://existing.example.test/profile"></label>
    <label for="availability">Availability</label>
    <select id="availability" required><option value="" disabled selected>Choose availability</option></select>
    <label>Portfolio URL<input id="duplicate-a" type="url"></label>
    <label>Portfolio URL<input id="duplicate-b" type="url"></label>
    <label hidden>Hidden tracking<input id="hidden" value="SYNTHETIC-TRACKING"></label>
  </form></body></html>`;
}

export function confirmationApplicationHtml(): string {
  return `<!doctype html><html><body><form id="application" action="/confirmation" method="get">
    <label>LinkedIn profile URL<input type="url"></label>
    <button id="in-place" type="submit">Confirm in place</button>
    <button id="navigate" type="submit">Submit application</button>
  </form><output id="confirmation"></output>
  <script>
    window.humanActions = 0;
    window.submitEvents = 0;
    document.querySelector('#application').addEventListener('submit', (event) => {
      window.submitEvents += 1;
      if (event.submitter?.id === 'in-place') {
        event.preventDefault();
        document.querySelector('#confirmation').textContent = 'Application received';
      }
    });
    document.querySelector('#in-place').addEventListener('click', () => {
      window.humanActions += 1;
    });
    document.querySelector('#navigate').addEventListener('click', () => { window.humanActions += 1; });
  </script></body></html>`;
}

export function multiStepBarrierHtml(): string {
  return `<!doctype html><html><body><form aria-label="Synthetic staged application">
    <label>LinkedIn profile URL<input type="url"></label>
    <label>Employer account password<input id="password" type="password" value="SYNTHETIC-NOT-A-CREDENTIAL"></label>
    <label><input id="captcha" type="checkbox">I am not a robot</label>
    <button id="next" type="button">Next step</button>
  </form></body></html>`;
}
