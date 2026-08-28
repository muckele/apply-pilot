import { createServer, type Server } from "node:http";

export const BROWSER_SMOKE_RUN_ID = "clz8w7m9a0002qwer1234tyui";
export const SYNTHETIC_EMPLOYER_URL = "https://employer.example.test/apply?posting=123#start";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture server did not receive a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startBrowserFixtureServers() {
  let runDelayMs = 0;
  let mutationHits = 0;
  let controlOrigin = "";
  let alternateOrigin = "";

  const alternateServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Alternate origin</title><p>Trust boundary left.</p>");
  });
  const alternatePort = await listen(alternateServer);
  alternateOrigin = `http://127.0.0.1:${alternatePort}`;

  const controlServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", controlOrigin || "http://127.0.0.1");
    if (url.pathname === `/api/application-runs/${BROWSER_SMOKE_RUN_ID}`) {
      if (runDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, runDelayMs));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        run: {
          id: BROWSER_SMOKE_RUN_ID,
          state: "READY",
          applyHost: "employer.example.test",
          applyUrlSnapshot: SYNTHETIC_EMPLOYER_URL
        }
      }));
      return;
    }
    if (url.pathname === "/api/application-automation-policy") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        effectiveEnabled: true,
        allowedHosts: ["employer.example.test"],
        blockedHosts: []
      }));
      return;
    }
    if (url.pathname === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Child frame</title><p>Untrusted child frame.</p>");
      return;
    }
    if (url.pathname === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Unexpected popup</title>");
      return;
    }
    if (url.pathname === "/mutation") {
      mutationHits += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === `/application-runs/${BROWSER_SMOKE_RUN_ID}/browser`) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html>
        <html>
          <head><title>Apply Pilot B1 control</title></head>
          <body>
            <h1>Apply Pilot B1 control</h1>
            <iframe id="child" src="/frame"></iframe>
            <a id="alternate" href="${alternateOrigin}/left-control">Leave control origin</a>
          </body>
        </html>`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  const controlPort = await listen(controlServer);
  controlOrigin = `http://127.0.0.1:${controlPort}`;

  return {
    controlOrigin,
    alternateOrigin,
    controlUrl: `${controlOrigin}/application-runs/${BROWSER_SMOKE_RUN_ID}/browser`,
    popupUrl: `${controlOrigin}/popup`,
    mutationUrl: `${controlOrigin}/mutation`,
    setRunDelay(milliseconds: number) {
      runDelayMs = milliseconds;
    },
    mutationHits: () => mutationHits,
    async close() {
      await Promise.all([closeServer(controlServer), closeServer(alternateServer)]);
    }
  };
}

export function syntheticEmployerHtml(mutationUrl: string): string {
  return `<!doctype html>
    <html>
      <head><title>Synthetic employer application</title></head>
      <body>
        <form id="application" action="${mutationUrl}" method="post">
          <label>Name <input id="name" name="name" value=""></label>
          <button id="submit" type="submit">Submit application</button>
        </form>
        <script>
          window.__b1Trap = { clicks: 0, keys: 0, inputs: 0, submissions: 0 };
          document.addEventListener('click', () => { window.__b1Trap.clicks += 1; }, true);
          document.addEventListener('keydown', () => { window.__b1Trap.keys += 1; }, true);
          document.addEventListener('input', () => { window.__b1Trap.inputs += 1; }, true);
          document.addEventListener('submit', () => { window.__b1Trap.submissions += 1; }, true);
        </script>
      </body>
    </html>`;
}
