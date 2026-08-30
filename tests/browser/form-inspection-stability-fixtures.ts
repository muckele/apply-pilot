import { createServer, type Server } from "node:http";

export const STABLE_FORM_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      .conditionally-visible { display: none; }
      #reveal:checked ~ .conditionally-visible { display: block; }
    </style>
  </head>
  <body>
    <main>
      <form id="application-form">
        <fieldset>
          <legend>Applicant</legend>
          <label for="full-name">Full name</label>
          <input id="full-name" name="full_name" autocomplete="name" required>
          <p id="name-help">Use your legal name.</p>
        </fieldset>
      </form>
    </main>
  </body>
</html>`;

export const APPLICANT_STATE_FORM_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      .conditional-field { display: none; }
      #reveal:checked ~ .conditional-field { display: block; }
    </style>
  </head>
  <body>
    <form>
      <label for="reveal">Show portfolio question</label>
      <input id="reveal" type="checkbox" name="reveal">
      <div class="conditional-field">
        <label for="portfolio">Portfolio URL</label>
        <input id="portfolio" name="portfolio">
      </div>
    </form>
  </body>
</html>`;

export const OPEN_SHADOW_FORM_HTML = `<!doctype html>
<html>
  <body>
    <form>
      <label for="name">Name</label>
      <input id="name" name="name">
      <div id="represented-host" role="combobox" tabindex="0" aria-label="Office"></div>
      <application-note id="existing-shadow-host"></application-note>
    </form>
    <script>
      const host = document.getElementById("existing-shadow-host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = "<span>Passive note</span>";
    </script>
  </body>
</html>`;

export const SHADOW_ROOT_LIFETIME_FORM_HTML = `<!doctype html>
<html>
  <body>
    <form id="shadow-lifetime-form">
      <label for="shadow-name">Name</label>
      <input id="shadow-name" name="name">
      <application-historical id="historical-shadow-host" role="combobox" tabindex="0" aria-label="Historical office"></application-historical>
      <application-current id="current-shadow-host"></application-current>
    </form>
    <script>
      document.getElementById("historical-shadow-host")
        .attachShadow({ mode: "open" }).innerHTML = "<span>Historical passive note</span>";
      document.getElementById("current-shadow-host")
        .attachShadow({ mode: "open" }).innerHTML = "<span>Current passive note</span>";
    </script>
  </body>
</html>`;

export const SEMANTIC_SURFACE_FORM_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>.hidden-by-test { display: none; }</style>
  </head>
  <body>
    <form id="primary-form">
      <fieldset id="identity-group">
        <legend id="identity-legend">Identity</legend>
        <label id="name-label" for="name">Full name</label>
        <input id="name" name="name" aria-describedby="name-help" required>
        <p id="name-help">Use your legal name.</p>
      </fieldset>
      <fieldset id="location-group">
        <legend>Location</legend>
        <label for="country">Country</label>
        <select id="country" name="country">
          <optgroup id="americas" label="Americas">
            <option id="us-option">United States</option>
          </optgroup>
        </select>
      </fieldset>
    </form>
    <label for="external-field">External profile</label>
    <input id="external-field" name="external" form="primary-form">
    <aside id="unrelated-clock">0</aside>
  </body>
</html>`;

export const CSSOM_FORM_HTML = `<!doctype html>
<html>
  <head>
    <style>.cssom-target { display: block; }</style>
  </head>
  <body>
    <form>
      <label for="always">Name</label>
      <input id="always" name="always">
      <div class="cssom-target">
        <label for="conditional">Portfolio</label>
        <input id="conditional" name="conditional">
      </div>
    </form>
  </body>
</html>`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The B2.2b fixture server did not expose a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startFormInspectionStabilityServer(): Promise<Readonly<{
  origin: string;
  close(): Promise<void>;
}>> {
  const server = createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/other"
      ? STABLE_FORM_HTML.replace("Full name", "Preferred name")
      : STABLE_FORM_HTML);
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => closeServer(server)
  };
}
