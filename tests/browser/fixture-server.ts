import { createServer, type IncomingMessage, type Server } from "node:http";

export const BROWSER_SMOKE_RUN_ID = "clz8w7m9a0002qwer1234tyui";
export const SYNTHETIC_EMPLOYER_URL = "https://employer.example.test/apply?posting=123#start";

type PublicationRequest = Readonly<{
  ordinal: number;
  path: string;
  contentType: string;
  rawBody: string;
  parsedBody: Record<string, unknown>;
  disposition: "MATERIAL" | "REPLAY";
}>;

const FIXTURE_PACKET_HASH = "b".repeat(64);
const FIXTURE_NORMALIZED_FIELD_KEY = "1".repeat(64);

function publicAnswerPacket() {
  return {
    inspectionVersion: 1,
    answerPacketVersion: 1,
    packetHash: FIXTURE_PACKET_HASH,
    reviewedAt: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    summary: {
      fieldCount: 1,
      proposableCount: 1,
      pendingReviewCount: 1,
      approvedCount: 0,
      rejectedCount: 0,
      manualOnlyCount: 0,
      excludedCount: 0,
      unsupportedCount: 0,
      manualRequiredCount: 1,
      readyForRunResolution: false
    },
    answers: [{
      id: "answer-integrated-name",
      normalizedFieldKey: FIXTURE_NORMALIZED_FIELD_KEY,
      question: "Name",
      fieldType: "TEXT",
      classification: "PERSONAL_NAME",
      disposition: "PROPOSABLE",
      dispositionReason: null,
      choices: [],
      proposal: { kind: "SCALAR", value: "Ada Lovelace" },
      required: false,
      requiresReview: true,
      sensitive: false,
      valueRedacted: false,
      status: "PENDING",
      reviewedByUser: false,
      reviewedAt: null
    }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalWithoutFragment(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function readUtf8Body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
  let runState: "READY" | "REVIEW_REQUIRED" = "READY";
  let stateVersion = 0;
  let inspectionVersion = 0;
  let answerPacketVersion = 0;
  let firstInspectionReportCanonical: string | null = null;
  let publicationHitCount = 0;
  const capturedPublicationRequests: PublicationRequest[] = [];
  let packetReadOrdinal = 0;
  let holdNextPacketRead = false;
  let heldPacketRead: Readonly<{ ordinal: number; path: string }> | null = null;
  let resolveHeldPacketRead: ((value: Readonly<{ ordinal: number; path: string }>) => void) | null = null;
  let heldPacketReadPromise: Promise<Readonly<{ ordinal: number; path: string }>> | null = null;
  let releaseHeldPacketRead: (() => void) | null = null;

  const alternateServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Alternate origin</title><p>Trust boundary left.</p>");
  });
  const alternatePort = await listen(alternateServer);
  alternateOrigin = `http://127.0.0.1:${alternatePort}`;

  const controlServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", controlOrigin || "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === `/api/application-runs/${BROWSER_SMOKE_RUN_ID}`) {
      if (runDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, runDelayMs));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        run: {
          id: BROWSER_SMOKE_RUN_ID,
          state: runState,
          stateVersion,
          applyHost: "employer.example.test",
          applyUrlSnapshot: SYNTHETIC_EMPLOYER_URL
        }
      }));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/application-runs/${BROWSER_SMOKE_RUN_ID}/answer-packet`
    ) {
      packetReadOrdinal += 1;
      if (holdNextPacketRead) {
        holdNextPacketRead = false;
        heldPacketRead = { ordinal: packetReadOrdinal, path: url.pathname };
        resolveHeldPacketRead?.(heldPacketRead);
        await new Promise<void>((resolve) => {
          releaseHeldPacketRead = resolve;
        });
        releaseHeldPacketRead = null;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        runId: BROWSER_SMOKE_RUN_ID,
        current: answerPacketVersion === 0 ? null : publicAnswerPacket()
      }));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === `/api/application-runs/${BROWSER_SMOKE_RUN_ID}/form-inspection`
    ) {
      publicationHitCount += 1;
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        response.writeHead(415, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "UNSUPPORTED_MEDIA_TYPE" }));
        return;
      }
      const rawBody = await readUtf8Body(request);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "INVALID_JSON" }));
        return;
      }
      if (
        !isRecord(parsedBody) ||
        !Number.isSafeInteger(parsedBody.expectedStateVersion) ||
        !Number.isSafeInteger(parsedBody.expectedFormInspectionVersion) ||
        !Number.isSafeInteger(parsedBody.expectedAnswerPacketVersion) ||
        typeof parsedBody.observedUrl !== "string" ||
        !isRecord(parsedBody.inspectionReport) ||
        canonicalWithoutFragment(parsedBody.observedUrl) !== canonicalWithoutFragment(SYNTHETIC_EMPLOYER_URL)
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "INVALID_REQUEST_BODY" }));
        return;
      }

      const reportCanonical = JSON.stringify(parsedBody.inspectionReport);
      const material =
        runState === "READY" &&
        stateVersion === 0 &&
        inspectionVersion === 0 &&
        answerPacketVersion === 0 &&
        parsedBody.expectedStateVersion === 0 &&
        parsedBody.expectedFormInspectionVersion === 0 &&
        parsedBody.expectedAnswerPacketVersion === 0;
      const replay =
        runState === "REVIEW_REQUIRED" &&
        stateVersion === 1 &&
        inspectionVersion === 1 &&
        answerPacketVersion === 1 &&
        parsedBody.expectedStateVersion === 1 &&
        parsedBody.expectedFormInspectionVersion === 1 &&
        parsedBody.expectedAnswerPacketVersion === 1 &&
        reportCanonical === firstInspectionReportCanonical;
      if (!material && !replay) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "RUN_DOCUMENT_STALE" }));
        return;
      }

      const disposition = material ? "MATERIAL" as const : "REPLAY" as const;
      if (material) {
        runState = "REVIEW_REQUIRED";
        stateVersion = 1;
        inspectionVersion = 1;
        answerPacketVersion = 1;
        firstInspectionReportCanonical = reportCanonical;
      }
      capturedPublicationRequests.push({
        ordinal: capturedPublicationRequests.length + 1,
        path: url.pathname,
        contentType,
        rawBody,
        parsedBody: structuredClone(parsedBody),
        disposition
      });
      response.writeHead(material ? 201 : 200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({
        replayed: replay,
        run: {
          id: BROWSER_SMOKE_RUN_ID,
          state: runState,
          stateVersion
        },
        current: { inspectionVersion, answerPacketVersion }
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/application-automation-policy") {
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
    publicationHits: () => publicationHitCount,
    coordinatorPacketReadGateActive: () => holdNextPacketRead || releaseHeldPacketRead !== null,
    publicationRequests: () => capturedPublicationRequests.map((request) => ({
      ...request,
      parsedBody: structuredClone(request.parsedBody)
    })),
    holdNextCoordinatorPacketRead() {
      if (holdNextPacketRead || releaseHeldPacketRead) {
        throw new Error("A coordinator packet read is already held.");
      }
      holdNextPacketRead = true;
      heldPacketRead = null;
      heldPacketReadPromise = new Promise((resolve) => {
        resolveHeldPacketRead = resolve;
      });
    },
    async waitForHeldCoordinatorPacketRead() {
      if (heldPacketRead) return heldPacketRead;
      if (!heldPacketReadPromise) {
        throw new Error("No coordinator packet read gate is armed.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          heldPacketReadPromise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for the held coordinator packet read.")),
              5_000
            );
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    releaseHeldCoordinatorPacketRead() {
      holdNextPacketRead = false;
      resolveHeldPacketRead = null;
      releaseHeldPacketRead?.();
      releaseHeldPacketRead = null;
    },
    async close() {
      holdNextPacketRead = false;
      releaseHeldPacketRead?.();
      releaseHeldPacketRead = null;
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
