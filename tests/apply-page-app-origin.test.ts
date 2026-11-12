import assert from "node:assert/strict";
import test from "node:test";

import { resolveAppOrigin } from "@/lib/apply-page/app-origin";

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const noHeaders = headers({});

test("a configured origin wins over request headers", () => {
  assert.equal(
    resolveAppOrigin({ env: { APP_BASE_URL: "https://apply.example.com/path" }, headers: headers({ host: "other.test" }) }),
    "https://apply.example.com"
  );
});

test("an empty or blank APP_BASE_URL falls through to AUTH_URL", () => {
  for (const blank of ["", "   "]) {
    assert.equal(
      resolveAppOrigin({ env: { APP_BASE_URL: blank, AUTH_URL: "https://auth.example.com" }, headers: noHeaders }),
      "https://auth.example.com"
    );
  }
});

test("production ignores request headers", () => {
  assert.equal(
    resolveAppOrigin({ env: { NODE_ENV: "production" }, headers: headers({ host: "apply.example.com", "x-forwarded-proto": "https" }) }),
    null
  );
});

test("non-production falls back to request headers", () => {
  assert.equal(
    resolveAppOrigin({ env: { NODE_ENV: "development" }, headers: headers({ host: "localhost:3000" }) }),
    "http://localhost:3000"
  );
  assert.equal(
    resolveAppOrigin({ env: {}, headers: headers({ "x-forwarded-host": "apply.example.com", "x-forwarded-proto": "https, http" }) }),
    "https://apply.example.com"
  );
});

test("invalid values give null", () => {
  assert.equal(resolveAppOrigin({ env: { APP_BASE_URL: "not a url", AUTH_URL: "ftp://x.test" }, headers: noHeaders }), null);
  assert.equal(resolveAppOrigin({ env: { NODE_ENV: "development" }, headers: headers({ host: "evil host" }) }), null);
});
