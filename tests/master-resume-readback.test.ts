import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";

import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MasterResumeDetail } from "@/components/master-resume-detail";
import {
  getMasterResumeDetail,
  MASTER_RESUME_DETAIL_SELECT,
  type MasterResumeDetailDto
} from "@/lib/resumes/master-resume-detail";
import { createMasterResumeRouteHandlers } from "@/lib/resumes/master-resume-route";
import { prisma } from "@/lib/prisma";
import { UnauthorizedError } from "@/lib/user-context";

const PARSED_AT = new Date("2026-10-05T04:39:07.750Z");

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function savedMaster(): MasterResumeDetailDto {
  return {
    id: "resume-owner-1",
    title: "Owner master resume",
    parsedAt: PARSED_AT,
    rawText: "Owner Name\nFive roles and two projects",
    summary: "Customer-facing technical leader.",
    skills: ["TypeScript", "SQL"],
    achievements: ["Improved a verified workflow."],
    workHistory: [{
      sourceText: "Acme | Solutions Engineer | 2022–2026",
      company: "Acme <script>alert('x')</script>",
      title: "Solutions Engineer",
      location: "Remote",
      startDate: "2022",
      endDate: "2026",
      bullets: ["Built evidence-linked workflows."]
    }],
    projects: [{
      sourceText: "Apply Pilot | 2026",
      name: "Apply Pilot",
      description: "Truthful application assistance.",
      date: "2026",
      technologies: ["Next.js"],
      bullets: ["Preserved source facts."]
    }],
    education: [{
      sourceText: "Example University | Bachelor of Arts in Business Administration",
      institution: "Example University",
      credential: "Bachelor of Arts",
      fieldOfStudy: "Business Administration",
      startDate: "2014",
      endDate: "2018",
      details: ["Completed a 480-hour practicum."]
    }],
    certifications: [{
      sourceText: "Example Certificate | Example Issuer | 2025",
      name: "Example Certificate",
      issuer: "Example Issuer",
      date: "2025",
      expirationDate: null,
      details: ["Source-backed certification detail."]
    }]
  };
}

function routeDependencies(overrides: Partial<{
  requireUserId: () => Promise<string>;
  getMasterResumeDetail: (userId: string) => Promise<MasterResumeDetailDto | null>;
}> = {}) {
  return {
    requireUserId: async () => "owner-1",
    getMasterResumeDetail: async () => savedMaster(),
    ...overrides
  };
}

test("master resume service binds the read to one owner and selects no account, file, or contact fields", async (t) => {
  let query: unknown;
  stub(t, prisma.resume, "findFirst", async (args: unknown) => {
    query = args;
    return savedMaster();
  });

  const resume = await getMasterResumeDetail("owner-1");

  assert.equal(resume?.id, "resume-owner-1");
  assert.deepEqual(query, {
    where: { userId: "owner-1", isMaster: true },
    select: MASTER_RESUME_DETAIL_SELECT,
    orderBy: { updatedAt: "desc" }
  });
  for (const excluded of ["userId", "contactInfo", "filePath", "originalName", "mimeType", "createdAt", "updatedAt"]) {
    assert.equal(Object.hasOwn(MASTER_RESUME_DETAIL_SELECT, excluded), false, `${excluded} must not be selected`);
  }
});

test("master resume GET authenticates first and returns only the owner-scoped no-store detail envelope", async () => {
  const calls: string[] = [];
  const handlers = createMasterResumeRouteHandlers(routeDependencies({
    requireUserId: async () => {
      calls.push("auth");
      return "owner-1";
    },
    getMasterResumeDetail: async (userId) => {
      calls.push(`read:${userId}`);
      return savedMaster();
    }
  }));

  const response = await handlers.GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(calls, ["auth", "read:owner-1"]);
  assert.equal(body.resume.id, "resume-owner-1");
  assert.equal(body.resume.parsedAt, PARSED_AT.toISOString());
  assert.equal(body.resume.rawText, "Owner Name\nFive roles and two projects");
  assert.deepEqual(body.resume.workHistory, savedMaster().workHistory);
  assert.deepEqual(body.resume.projects, savedMaster().projects);
  assert.deepEqual(body.resume.education, savedMaster().education);
  assert.deepEqual(body.resume.certifications, savedMaster().certifications);
  for (const excluded of ["userId", "contactInfo", "filePath", "originalName", "mimeType", "versions", "analyses"]) {
    assert.equal(Object.hasOwn(body.resume, excluded), false, `${excluded} must stay out of the readback envelope`);
  }
});

test("master resume GET rejects unauthenticated callers before reading", async () => {
  let readCalls = 0;
  const handlers = createMasterResumeRouteHandlers(routeDependencies({
    requireUserId: async () => { throw new UnauthorizedError(); },
    getMasterResumeDetail: async () => { readCalls += 1; return savedMaster(); }
  }));

  const response = await handlers.GET();

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(readCalls, 0);
});

test("master resume GET represents absence explicitly and repeated reads remain side-effect free", async () => {
  let reads = 0;
  const handlers = createMasterResumeRouteHandlers(routeDependencies({
    getMasterResumeDetail: async () => {
      reads += 1;
      return null;
    }
  }));

  const first = await handlers.GET();
  const second = await handlers.GET();

  assert.deepEqual(await first.json(), { resume: null });
  assert.deepEqual(await second.json(), { resume: null });
  assert.equal(first.headers.get("Cache-Control"), "private, no-store");
  assert.equal(second.headers.get("Cache-Control"), "private, no-store");
  assert.equal(reads, 2);
});

test("an interrupted master read is not replayed automatically and a later navigation can retry", async () => {
  let attempts = 0;
  const handlers = createMasterResumeRouteHandlers(routeDependencies({
    getMasterResumeDetail: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic interrupted read");
      return savedMaster();
    }
  }));

  const interrupted = await handlers.GET();
  assert.equal(interrupted.status, 500);
  assert.equal(interrupted.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await interrupted.json(), { error: "The saved master resume could not be read." });
  assert.equal(attempts, 1);

  const retriedByNavigation = await handlers.GET();
  assert.equal(retriedByNavigation.status, 200);
  assert.equal((await retriedByNavigation.json()).resume.id, "resume-owner-1");
  assert.equal(attempts, 2);
});

test("saved master detail renders structured sections, safe text, and responsive layouts without editing controls", () => {
  const html = renderToStaticMarkup(createElement(MasterResumeDetail, { resume: savedMaster() }));
  const document = new JSDOM(html).window.document;
  const text = document.body.textContent ?? "";

  assert.match(text, /Work history/);
  assert.match(text, /1 role · 1 bullet/);
  assert.match(text, /Projects/);
  assert.match(text, /Education/);
  assert.match(text, /Bachelor of Arts/);
  assert.match(text, /Business Administration/);
  assert.match(text, /Completed a 480-hour practicum/);
  assert.match(text, /Certifications/);
  assert.match(text, /Source-backed certification detail/);
  assert.match(text, /Source text saved · 2 lines/);
  assert.equal(document.querySelector("script"), null);
  assert.equal(document.querySelector("input, textarea, select, button, form"), null);
  assert.match(html, /md:grid-cols-2/);
  assert.match(html, /xl:grid-cols-3/);
  assert.match(html, /break-words/);
});

test("saved master detail handles absent and legacy stored fields without inventing values", () => {
  const legacy: MasterResumeDetailDto = {
    ...savedMaster(),
    rawText: null,
    summary: null,
    skills: [],
    achievements: [],
    workHistory: [{
      company: "Legacy Co",
      role: "Operations lead",
      bullets: [],
      highlights: ["Coordinated scheduling."]
    }],
    projects: [{ name: "Legacy Project", technologies: ["SQL"] }],
    education: [{ school: "Legacy School", program: "Legacy Program" }],
    certifications: null
  };
  const html = renderToStaticMarkup(createElement(MasterResumeDetail, { resume: legacy }));
  const text = new JSDOM(html).window.document.body.textContent ?? "";

  assert.match(text, /Operations lead/);
  assert.match(text, /Coordinated scheduling/);
  assert.match(text, /Legacy Project/);
  assert.match(text, /Legacy School/);
  assert.match(text, /Legacy Program/);
  assert.match(text, /No certifications saved/);
  assert.match(text, /Source text unavailable/);
  assert.doesNotMatch(text, /undefined|null/);
});

test("the Resumes page uses the shared owner-scoped read service and read-only detail component", () => {
  const page = readFileSync(new URL("../app/(product)/resumes/page.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/resumes/master/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/resumes/master-resume-detail.ts", import.meta.url), "utf8");

  assert.match(page, /getMasterResumeDetail/);
  assert.match(page, /MasterResumeDetail/);
  assert.doesNotMatch(page, /prisma\.resume\.findFirst/);
  assert.doesNotMatch(route, /checkRateLimit|export\s+(?:async\s+)?function/);
  assert.deepEqual([...route.matchAll(/^export\s+(?:const|function|async function)\s+(\w+)/gmu)].map((match) => match[1]), ["GET"]);
  assert.doesNotMatch(service, /\.(?:create|update|upsert|delete|deleteMany|updateMany)\s*\(/u);
});
