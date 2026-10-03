import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import OpenAI from "openai";

import { parseResumeTextWithMeta, validateParsedResumeOutput, type ParsedResume } from "@/lib/ai/resume";
import { getOpenAIClient } from "@/lib/ai/client";
import { PublicApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

const resumeText = `Jordan Example
jordan@example.test

SUMMARY
Customer success manager supporting technical onboarding.

EXPERIENCE
Customer Success Manager
Example Co
Remote
2022 - Present
Led customer onboarding.
Improved retention by 10%.

SKILLS
Customer Success
SQL

EDUCATION
Example University
B.S. Business
2021`;

const parsedOutput: ParsedResume = {
  contractVersion: "3",
  contactInfo: {
    sourceText: "Jordan Example\njordan@example.test",
    name: "Jordan Example",
    headline: null,
    email: "jordan@example.test",
    phone: null,
    location: null,
    linkedin: null,
    github: null,
    portfolio: null
  },
  summary: "Customer success manager supporting technical onboarding.",
  skills: ["Customer Success", "SQL"],
  workHistory: [{
    sourceText: "Customer Success Manager\nExample Co\nRemote\n2022 - Present\nLed customer onboarding.\nImproved retention by 10%.",
    company: "Example Co",
    title: "Customer Success Manager",
    location: "Remote",
    startDate: "2022",
    endDate: "Present",
    bullets: ["Led customer onboarding.", "Improved retention by 10%."]
  }],
  projects: [],
  education: [{
    sourceText: "Example University\nB.S. Business\n2021",
    institution: "Example University",
    credential: "B.S.",
    fieldOfStudy: "Business",
    startDate: null,
    endDate: "2021",
    details: []
  }],
  certifications: [],
  achievements: [],
  sectionStatus: {
    summary: "present", skills: "present", workHistory: "present", projects: "absent",
    education: "present", certifications: "absent", achievements: "absent"
  },
  warnings: []
};

function emptyParsedResume() {
  const output = structuredClone(parsedOutput);
  output.summary = "";
  output.skills = [];
  output.workHistory = [];
  output.projects = [];
  output.education = [];
  output.certifications = [];
  output.achievements = [];
  for (const section of Object.keys(output.sectionStatus) as Array<keyof typeof output.sectionStatus>) {
    output.sectionStatus[section] = "absent";
  }
  return output;
}

function stub(t: TestContext, owner: object, name: string, replacement: unknown) {
  const methods = owner as Record<string, unknown>;
  const original = methods[name];
  methods[name] = replacement;
  t.after(() => { methods[name] = original; });
}

function environment(t: TestContext) {
  const changes: Record<string, string | undefined> = {
    AI_ENABLED: "true",
    AI_PROVIDER: "gemini",
    AI_MOCK_MODE: "false",
    GEMINI_API_KEY: "synthetic-never-log",
    GEMINI_FAST_MODEL: "gemini-3.8-flash",
    OPENAI_API_KEY: undefined,
    OPENAI_MOCK_MODE: undefined,
    AI_MAX_REQUEST_COST_CENTS: undefined,
    AI_CONFIRMATION_THRESHOLD_CENTS: undefined
  };
  for (const [name, value] of Object.entries(changes)) {
    const prior = process.env[name];
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function providerResponse(value: unknown, usage = {
  promptTokenCount: 160,
  candidatesTokenCount: 80,
  thoughtsTokenCount: 20,
  totalTokenCount: 260
}) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: usage
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function installLedger(t: TestContext, cachedOutput?: unknown, options: {
  failSucceededReconciliation?: boolean;
  priorStatus?: "RESERVED" | "UNCERTAIN";
} = {}) {
  let reservation: Record<string, unknown> | null = options.priorStatus
    ? { id: "prior-reservation", status: options.priorStatus }
    : null;
  let failSucceededReconciliation = options.failSucceededReconciliation === true;
  const reservations: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const cacheWrites: Array<Record<string, unknown>> = [];

  stub(t, prisma.aIResponseCache, "findFirst", async () => cachedOutput ? { output: cachedOutput } : null);
  stub(t, prisma.aIBudgetReservation, "findMany", async () =>
    reservation?.status === "RESERVED" ? [{ id: reservation.id }] : []);
  stub(t, prisma.aIBudgetReservation, "findFirst", async () =>
    reservation && ["RESERVED", "UNCERTAIN"].includes(String(reservation.status)) ? reservation : null);
  stub(t, prisma.aISettings, "upsert", async () => ({
    monthlyBudgetCents: 500,
    automationBudgetCents: 150,
    maxAnalysesPerSync: 5,
    modelOverride: null
  }));

  const tx = {
    aIBudgetLedger: {
      upsert: async () => ({ id: "ledger-1" }),
      updateMany: async () => ({ count: 1 })
    },
    aIBudgetReservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        reservation = { id: "reservation-1", ledgerId: "ledger-1", status: "RESERVED", ...data };
        reservations.push(data);
        return reservation;
      },
      findUniqueOrThrow: async () => reservation,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.status === "SUCCEEDED" && failSucceededReconciliation) {
          failSucceededReconciliation = false;
          throw new Error("synthetic durable cache failure");
        }
        reconciliations.push(data);
        reservation = { ...reservation, ...data };
        return reservation;
      }
    },
    aIUsageEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    aIResponseCache: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        cacheWrites.push(create);
        return create;
      }
    },
    $executeRaw: async () => 1
  };
  stub(t, prisma, "$transaction", async (callback: (transaction: typeof tx) => unknown) => callback(tx));

  return { reservations, reconciliations, cacheWrites };
}

test("Gemini resume parsing requires combined data and maximum-cost confirmation before any paid call", async (t) => {
  environment(t);
  installLedger(t);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => { providerCalls += 1; throw new Error("must not call"); });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1"),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 428 &&
      error.details?.code === "AI_COST_CONFIRMATION_REQUIRED" &&
      error.details.maximumCostMicros === 38_250 &&
      error.details.provider === "gemini" &&
      error.details.dataType === "resume_text"
  );
  assert.equal(providerCalls, 0);
});

test("confirmed Gemini parsing uses the configured model, typed response schema, reservation, and source-backed v3 output", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const requests: Array<Record<string, unknown>> = [];
  stub(t, globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return providerResponse(parsedOutput);
  });

  const result = await parseResumeTextWithMeta(resumeText, "user-1", {
    highCostConfirmed: true,
    dataSharingConfirmed: true
  });

  assert.equal(result.meta.provider, "gemini");
  assert.equal(result.meta.model, "gemini-3.8-flash");
  assert.equal(result.meta.promptVersion, "3");
  assert.equal(result.meta.outputTokens, 100);
  assert.deepEqual(result.data.workHistory, parsedOutput.workHistory);
  assert.deepEqual(result.data.education, parsedOutput.education);
  const generationConfig = requests[0]?.generationConfig as Record<string, unknown>;
  const responseSchema = generationConfig.responseJsonSchema as Record<string, unknown>;
  assert.equal(responseSchema.additionalProperties, false);
  assert.equal(ledger.reservations[0]?.provider, "gemini");
  assert.equal(ledger.reservations[0]?.feature, "RESUME_PARSE");
  assert.equal(ledger.reservations[0]?.maximumCostMicros, 38_250);
  assert.equal(ledger.reconciliations[0]?.status, "SUCCEEDED");
  assert.equal(ledger.cacheWrites.length, 1);
});

test("unsupported parsed facts fail validation, consume only known usage, and are never cached", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const unsupported = structuredClone(parsedOutput);
  unsupported.workHistory[0].bullets[0] = "Invented unsupported accomplishment.";
  stub(t, globalThis, "fetch", async () => providerResponse(unsupported));

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    /not supported by the submitted resume source/i
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});

test("a source section heading cannot be silently replaced with an empty structured section", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  const incomplete = structuredClone(parsedOutput);
  incomplete.workHistory = [];
  incomplete.sectionStatus.workHistory = "absent";
  stub(t, globalThis, "fetch", async () => providerResponse(incomplete));

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    /incomplete.*work history/i
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});

test("summary and skills headings cannot be silently discarded", () => {
  const incomplete = structuredClone(parsedOutput);
  incomplete.summary = "";
  incomplete.skills = [];
  incomplete.sectionStatus.summary = "absent";
  incomplete.sectionStatus.skills = "absent";

  assert.throws(
    () => validateParsedResumeOutput(resumeText, incomplete),
    /incomplete.*summary/i
  );
});

test("adjacent source lines cannot be combined into one factual field", () => {
  const combined = structuredClone(parsedOutput);
  combined.workHistory[0].company = "Customer Success Manager Example Co";

  assert.throws(
    () => validateParsedResumeOutput(resumeText, combined),
    /not supported by the submitted resume source/i
  );
});

test("every factual line in a recognized section must be represented", () => {
  const twoRoleSource = resumeText.replace(
    "\nSKILLS\n",
    "\nAccount Manager\nSecond Example Co\n2020 - 2022\nSupported enterprise renewals.\n\nSKILLS\n"
  );

  assert.throws(
    () => validateParsedResumeOutput(twoRoleSource, parsedOutput),
    /incomplete.*work history.*not represented/i
  );
});

test("contact facts detected in the source cannot be silently omitted", () => {
  const missingContact = structuredClone(parsedOutput);
  missingContact.contactInfo.email = null;

  assert.throws(
    () => validateParsedResumeOutput(resumeText, missingContact),
    /omitted or changed contactInfo.email/i
  );
});

test("the complete contact header is preserved as source evidence", () => {
  const incompleteContact = structuredClone(parsedOutput);
  incompleteContact.contactInfo.sourceText = "jordan@example.test";

  assert.throws(
    () => validateParsedResumeOutput(resumeText, incompleteContact),
    /complete contact\/header source block/i
  );
});

test("phone, location, headline, and LinkedIn facts cannot remain only in raw contact evidence", () => {
  const contactHeader = [
    "Jordan Example",
    "Customer Success Leader",
    "jordan@example.test",
    "+1 (555) 010-1000",
    "Location: New York, NY",
    "linkedin.com/in/jordan-example"
  ].join("\n");
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const incomplete = structuredClone(parsedOutput);
  incomplete.contactInfo.sourceText = contactHeader;

  assert.throws(
    () => validateParsedResumeOutput(source, incomplete),
    /omitted or changed contactInfo.phone/i
  );

  incomplete.contactInfo.headline = "Customer Success Leader";
  incomplete.contactInfo.phone = "+1 (555) 010-1000";
  incomplete.contactInfo.location = "New York, NY";
  incomplete.contactInfo.linkedin = "linkedin.com/in/jordan-example";
  assert.doesNotThrow(() => validateParsedResumeOutput(source, incomplete));
});

test("an explicitly labelled international city-country line is a location", () => {
  const contactHeader = "Jordan Example\nLocation: Berlin, Germany\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const correct = structuredClone(parsedOutput);
  correct.contactInfo.sourceText = contactHeader;
  correct.contactInfo.location = "Berlin, Germany";
  assert.doesNotThrow(() => validateParsedResumeOutput(source, correct));

  const wrong = structuredClone(correct);
  wrong.contactInfo.location = null;
  wrong.contactInfo.headline = "Berlin, Germany";
  assert.throws(
    () => validateParsedResumeOutput(source, wrong),
    /omitted or changed contactInfo.location/i
  );
});

test("an explicitly labelled international city-region line is a location", () => {
  const contactHeader = "Jordan Example\nLocation: Sydney, NSW\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const correct = structuredClone(parsedOutput);
  correct.contactInfo.sourceText = contactHeader;
  correct.contactInfo.location = "Sydney, NSW";
  assert.doesNotThrow(() => validateParsedResumeOutput(source, correct));

  const wrong = structuredClone(correct);
  wrong.contactInfo.location = null;
  wrong.contactInfo.headline = "Sydney, NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, wrong),
    /omitted or changed contactInfo.location/i
  );
});

test("a professional headline ending in an acronym is not a location", () => {
  const contactHeader = "Jordan Example\nEngineering Leader, AI\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const correct = structuredClone(parsedOutput);
  correct.contactInfo.sourceText = contactHeader;
  correct.contactInfo.headline = "Engineering Leader, AI";
  assert.doesNotThrow(() => validateParsedResumeOutput(source, correct));

  const wrong = structuredClone(correct);
  wrong.contactInfo.headline = null;
  wrong.contactInfo.location = "Engineering Leader, AI";
  assert.throws(
    () => validateParsedResumeOutput(source, wrong),
    /professional headline/i
  );
});

test("a credential headline ending in a region code is not a location", () => {
  const contactHeader = "Jordan Example\nCPA, CA\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const correct = structuredClone(parsedOutput);
  correct.contactInfo.sourceText = contactHeader;
  correct.contactInfo.headline = "CPA, CA";
  assert.doesNotThrow(() => validateParsedResumeOutput(source, correct));

  const wrong = structuredClone(correct);
  wrong.contactInfo.headline = null;
  wrong.contactInfo.location = "CPA, CA";
  assert.throws(
    () => validateParsedResumeOutput(source, wrong),
    /professional headline/i
  );
});

test("a professional headline ending in a country code fails closed as ambiguous", () => {
  const contactHeader = "Jordan Example\nEngineering Leader, UK\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const headline = structuredClone(parsedOutput);
  headline.contactInfo.sourceText = contactHeader;
  headline.contactInfo.headline = "Engineering Leader, UK";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );

  const location = structuredClone(headline);
  location.contactInfo.headline = null;
  location.contactInfo.location = "Engineering Leader, UK";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );
});

test("an unlisted professional headline ending in a country code fails ambiguous", () => {
  const contactHeader = "Jordan Example\nProduct Lead, UK\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const headline = structuredClone(parsedOutput);
  headline.contactInfo.sourceText = contactHeader;
  headline.contactInfo.headline = "Product Lead, UK";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );

  const location = structuredClone(headline);
  location.contactInfo.headline = null;
  location.contactInfo.location = "Product Lead, UK";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );
});

test("a place-shaped professional word fails closed instead of forcing a contact type", () => {
  const contactHeader = "Jordan Example\nLeader, SK\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const location = structuredClone(parsedOutput);
  location.contactInfo.sourceText = contactHeader;
  location.contactInfo.location = "Leader, SK";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );

  const headline = structuredClone(location);
  headline.contactInfo.location = null;
  headline.contactInfo.headline = "Leader, SK";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );
});

test("an unpunctuated region-shaped contact line fails closed as ambiguous", () => {
  const contactHeader = "Jordan Example\nSydney NSW\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const location = structuredClone(parsedOutput);
  location.contactInfo.sourceText = contactHeader;
  location.contactInfo.location = "Sydney NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );

  const headline = structuredClone(location);
  headline.contactInfo.location = null;
  headline.contactInfo.headline = "Sydney NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );
});

test("an unlabeled city-region contact line fails closed as ambiguous", () => {
  const contactHeader = "Jordan Example\nSydney, NSW\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const location = structuredClone(parsedOutput);
  location.contactInfo.sourceText = contactHeader;
  location.contactInfo.location = "Sydney, NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );

  const headline = structuredClone(location);
  headline.contactInfo.location = null;
  headline.contactInfo.headline = "Sydney, NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );
});

test("a standalone region code fails closed as an ambiguous contact line", () => {
  const contactHeader = "Jordan Example\nNSW\njordan@example.test";
  const source = resumeText.replace("Jordan Example\njordan@example.test", contactHeader);
  const location = structuredClone(parsedOutput);
  location.contactInfo.sourceText = contactHeader;
  location.contactInfo.location = "NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, location),
    /ambiguous contact/i
  );

  const headline = structuredClone(location);
  headline.contactInfo.location = null;
  headline.contactInfo.headline = "NSW";
  assert.throws(
    () => validateParsedResumeOutput(source, headline),
    /ambiguous contact/i
  );
});

test("an explicit contact section can supply the complete contact source block", () => {
  const contactSectionSource = resumeText.replace(
    "Jordan Example\njordan@example.test",
    "CONTACT\nJordan Example\njordan@example.test"
  );

  assert.doesNotThrow(() => validateParsedResumeOutput(contactSectionSource, parsedOutput));
});

test("unheaded source structure fails closed instead of silently dropping work history", () => {
  const unheadedSource = `Jordan Example\njordan@example.test\nEngineer\nExample Co\n2022 - Present`;
  const empty = structuredClone(parsedOutput);
  empty.summary = "";
  empty.skills = [];
  empty.workHistory = [];
  empty.education = [];
  empty.achievements = [];
  for (const section of Object.keys(empty.sectionStatus) as Array<keyof typeof empty.sectionStatus>) {
    empty.sectionStatus[section] = "absent";
  }

  assert.throws(
    () => validateParsedResumeOutput(unheadedSource, empty),
    /no supported section headings/i
  );
});

test("contiguous record evidence accepts ordinary connector text", () => {
  const connectorSource = resumeText.replace(
    "Customer Success Manager\nExample Co\nRemote",
    "Engineer at Example Co\nRemote"
  );
  const connector = structuredClone(parsedOutput);
  connector.workHistory[0].sourceText = connector.workHistory[0].sourceText.replace(
    "Customer Success Manager\nExample Co\nRemote",
    "Engineer at Example Co\nRemote"
  );
  connector.workHistory[0].title = "Engineer";

  assert.doesNotThrow(() => validateParsedResumeOutput(connectorSource, connector));
});

test("one evidence block cannot merge two dated work-history records", () => {
  const secondRole = "Account Manager\nSecond Example Co\n2020 - 2022\nSupported enterprise renewals.";
  const mergedSource = resumeText.replace("\nSKILLS\n", `\n${secondRole}\n\nSKILLS\n`);
  const merged = structuredClone(parsedOutput);
  merged.workHistory[0].sourceText = `${merged.workHistory[0].sourceText}\n\n${secondRole}`;
  merged.workHistory[0].bullets.push(
    "Account Manager",
    "Second Example Co",
    "2020 - 2022",
    "Supported enterprise renewals."
  );

  assert.throws(
    () => validateParsedResumeOutput(mergedSource, merged),
    /ambiguous workHistory detail.*merged record boundary/i
  );
});

test("adjacent dateless roles cannot be disguised as work-history bullets", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co\nLed beta.",
    company: "Alpha Co",
    title: "Engineer",
    location: null,
    startDate: null,
    endDate: null,
    bullets: ["Built alpha.", "Manager", "Beta Co", "Led beta."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /ambiguous workHistory detail.*merged record boundary/i
  );
});

test("adjacent work records cannot be reassigned to location and date fields", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co",
    company: "Alpha Co",
    title: "Engineer",
    location: "Manager",
    startDate: "Beta Co",
    endDate: null,
    bullets: ["Built alpha."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("a region-shaped second title cannot become the first record location", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nBuilt alpha.\nRegional Manager, NSW\n2020\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nBuilt alpha.\nRegional Manager, NSW\n2020\nLed beta.",
    company: "Alpha Co",
    title: "Engineer",
    location: "Regional Manager, NSW",
    startDate: "2020",
    endDate: null,
    bullets: ["Built alpha.", "Led beta."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("a country-shaped second title after dates cannot become a work location", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\n2020\nChief of Staff, UK\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\n2020\nChief of Staff, UK\nLed beta.",
    company: "Alpha Co",
    title: "Engineer",
    location: "Chief of Staff, UK",
    startDate: "2020",
    endDate: null,
    bullets: ["Led beta."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("a country-shaped second title before dates cannot become a work location", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nProduct Lead, UK\n2020\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nProduct Lead, UK\n2020\nLed beta.",
    company: "Alpha Co",
    title: "Engineer",
    location: "Product Lead, UK",
    startDate: "2020",
    endDate: null,
    bullets: ["Led beta."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("numeric month-year work dates remain valid", () => {
  const source = resumeText.replace("2022 - Present", "05/2020 - 06/2023");
  const output = structuredClone(parsedOutput);
  output.workHistory[0].sourceText = output.workHistory[0].sourceText.replace(
    "2022 - Present",
    "05/2020 - 06/2023"
  );
  output.workHistory[0].startDate = "05/2020";
  output.workHistory[0].endDate = "06/2023";

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output));
});

test("an unlabelled work location after dates fails closed as ambiguous", () => {
  const source = resumeText.replace("Remote\n2022 - Present", "2022 - Present\nSydney, NSW");
  const output = structuredClone(parsedOutput);
  output.workHistory[0].sourceText = output.workHistory[0].sourceText.replace(
    "Remote\n2022 - Present",
    "2022 - Present\nSydney, NSW"
  );
  output.workHistory[0].location = "Sydney, NSW";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("an explicitly labelled work location may follow dates", () => {
  const source = resumeText.replace("Remote\n2022 - Present", "2022 - Present\nLocation: Sydney, NSW");
  const output = structuredClone(parsedOutput);
  output.workHistory[0].sourceText = output.workHistory[0].sourceText.replace(
    "Remote\n2022 - Present",
    "2022 - Present\nLocation: Sydney, NSW"
  );
  output.workHistory[0].location = "Sydney, NSW";

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output));
});

test("a Location Manager title is not an explicit work-location label", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nLocation Manager\n2020\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nLocation Manager\n2020\nLed beta.",
    company: "Alpha Co",
    title: "Engineer",
    location: "Location Manager",
    startDate: "2020",
    endDate: null,
    bullets: ["Led beta."]
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid workHistory date or location/i
  );
});

test("an explicit based-in work location remains fully represented", () => {
  const source = resumeText.replace("Remote", "Based in Sydney, NSW");
  const output = structuredClone(parsedOutput);
  output.workHistory[0].sourceText = output.workHistory[0].sourceText.replace(
    "Remote",
    "Based in Sydney, NSW"
  );
  output.workHistory[0].location = "Sydney, NSW";

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output));
});

test("atomic record fields cannot absorb multiline records", () => {
  const source = `Jordan Example\njordan@example.test\n\nEXPERIENCE\nEngineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co\nLed beta.`;
  const output = emptyParsedResume();
  output.workHistory = [{
    sourceText: "Engineer\nAlpha Co\nBuilt alpha.\nManager\nBeta Co\nLed beta.",
    company: "Alpha Co\nBuilt alpha.\nManager\nBeta Co\nLed beta.",
    title: "Engineer",
    location: null,
    startDate: null,
    endDate: null,
    bullets: []
  }];
  output.sectionStatus.workHistory = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid structured result/i
  );
});

test("adjacent projects cannot be disguised as project bullets", () => {
  const source = `Jordan Example\njordan@example.test\n\nPROJECTS\nProject Alpha\nBuilt alpha.\nProject Beta\nBuilt beta.`;
  const output = emptyParsedResume();
  output.projects = [{
    sourceText: "Project Alpha\nBuilt alpha.\nProject Beta\nBuilt beta.",
    name: "Project Alpha",
    description: "Built alpha.",
    technologies: [],
    bullets: ["Project Beta", "Built beta."]
  }];
  output.sectionStatus.projects = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /ambiguous projects detail.*merged record boundary/i
  );
});

test("adjacent education records cannot be disguised as details", () => {
  const source = `Jordan Example\njordan@example.test\n\nEDUCATION\nAlpha University\nB.S. Math\nBeta University\nM.S. Science`;
  const output = emptyParsedResume();
  output.education = [{
    sourceText: "Alpha University\nB.S. Math\nBeta University\nM.S. Science",
    institution: "Alpha University",
    credential: "B.S.",
    fieldOfStudy: "Math",
    startDate: null,
    endDate: null,
    details: ["Beta University", "M.S. Science"]
  }];
  output.sectionStatus.education = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /ambiguous education detail.*merged record boundary/i
  );
});

test("adjacent education records cannot be reassigned to date fields", () => {
  const source = `Jordan Example\njordan@example.test\n\nEDUCATION\nAlpha University\nB.S. Math\nBeta University\nM.S. Science`;
  const output = emptyParsedResume();
  output.education = [{
    sourceText: "Alpha University\nB.S. Math\nBeta University\nM.S. Science",
    institution: "Alpha University",
    credential: "B.S.",
    fieldOfStudy: "Math",
    startDate: "Beta University",
    endDate: "M.S. Science",
    details: []
  }];
  output.sectionStatus.education = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid education date/i
  );
});

test("adjacent certifications must each have typed record fields", () => {
  const source = `Jordan Example\njordan@example.test\n\nCERTIFICATIONS\nAWS Certified\nAmazon\nScrum Master\nScrum Alliance`;
  const output = emptyParsedResume();
  output.certifications = [{
    sourceText: "AWS Certified\nAmazon\nScrum Master\nScrum Alliance",
    name: "AWS Certified",
    issuer: "Amazon",
    date: null,
    expirationDate: null
  }];
  output.sectionStatus.certifications = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /did not represent every factual line in certifications/i
  );
});

test("adjacent certifications cannot be reassigned to date fields", () => {
  const source = `Jordan Example\njordan@example.test\n\nCERTIFICATIONS\nAWS Certified\nAmazon\nScrum Master\nScrum Alliance`;
  const output = emptyParsedResume();
  output.certifications = [{
    sourceText: "AWS Certified\nAmazon\nScrum Master\nScrum Alliance",
    name: "AWS Certified",
    issuer: "Amazon",
    date: "Scrum Master",
    expirationDate: "Scrum Alliance"
  }];
  output.sectionStatus.certifications = "present";

  assert.throws(
    () => validateParsedResumeOutput(source, output),
    /invalid certification date/i
  );
});

test("a legitimate dated role may retain a later year inside a narrative bullet", () => {
  const source = resumeText.replace(
    "Improved retention by 10%.",
    "Improved retention by 10%.\nWon a 2024 service award."
  );
  const output = structuredClone(parsedOutput);
  output.workHistory[0].sourceText = output.workHistory[0].sourceText.replace(
    "Improved retention by 10%.",
    "Improved retention by 10%.\nWon a 2024 service award."
  );
  output.workHistory[0].bullets.push("Won a 2024 service award.");

  assert.doesNotThrow(() => validateParsedResumeOutput(source, output));
});

test("a validated cache replay avoids confirmation, reservation, and a duplicate provider call", async (t) => {
  environment(t);
  const ledger = installLedger(t, parsedOutput);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => { providerCalls += 1; throw new Error("must not call"); });

  const result = await parseResumeTextWithMeta(resumeText, "user-1");

  assert.equal(result.meta.estimatedCostMicros, 0);
  assert.equal(result.data.workHistory.length, 1);
  assert.equal(providerCalls, 0);
  assert.equal(ledger.reservations.length, 0);
});

test("an uncertain provider outcome durably blocks an identical second paid call", async (t) => {
  environment(t);
  const ledger = installLedger(t);
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    throw new TypeError("synthetic connection loss");
  });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 503 &&
      error.details?.code === "RESUME_PARSE_PROVIDER_UNCERTAIN" &&
      error.details.retryable === false
  );
  assert.equal(ledger.reconciliations[0]?.status, "UNCERTAIN");

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 409 &&
      error.details?.code === "RESUME_PARSE_PRIOR_OUTCOME_UNCERTAIN" &&
      error.details.retryable === false
  );
  assert.equal(providerCalls, 1);
  assert.equal(ledger.reservations.length, 1);
});

test("a durable-cache failure becomes uncertain and cannot trigger a second paid call", async (t) => {
  environment(t);
  const ledger = installLedger(t, undefined, { failSucceededReconciliation: true });
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    return providerResponse(parsedOutput);
  });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_PROVIDER_UNCERTAIN"
  );
  assert.equal(ledger.reconciliations[0]?.status, "UNCERTAIN");

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_PRIOR_OUTCOME_UNCERTAIN"
  );
  assert.equal(providerCalls, 1);
});

test("an abandoned reserved request becomes uncertain before transport and remains blocked", async (t) => {
  environment(t);
  const ledger = installLedger(t, undefined, { priorStatus: "RESERVED" });
  let providerCalls = 0;
  stub(t, globalThis, "fetch", async () => {
    providerCalls += 1;
    throw new Error("must not call");
  });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_PRIOR_OUTCOME_UNCERTAIN" &&
      error.details.retryable === false
  );
  assert.equal(providerCalls, 0);
  assert.equal(ledger.reservations.length, 0);
  assert.equal(ledger.reconciliations[0]?.status, "UNCERTAIN");
});

test("OpenAI configuration retains the same confirmation, validation, and reservation contract", async (t) => {
  environment(t);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "synthetic-never-log";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  delete process.env.GEMINI_API_KEY;
  const ledger = installLedger(t);
  const client = getOpenAIClient();
  assert.ok(client);
  stub(t, client.chat.completions, "create", async () => ({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(parsedOutput) } }],
    usage: {
      prompt_tokens: 160,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 0 }
    }
  }));
  stub(t, globalThis, "fetch", async () => { throw new Error("Gemini transport must not be used"); });

  const result = await parseResumeTextWithMeta(resumeText, "user-1", {
    highCostConfirmed: true,
    dataSharingConfirmed: true
  });

  assert.equal(result.meta.provider, "openai");
  assert.equal(result.meta.model, "gpt-4o-mini");
  assert.equal(ledger.reservations[0]?.provider, "openai");
  assert.equal(ledger.reservations[0]?.maximumCostMicros, 7_050);
  assert.equal(ledger.reconciliations[0]?.status, "SUCCEEDED");
});

test("OpenAI must report a complete stop before structured output can be accepted", async (t) => {
  environment(t);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "synthetic-never-log";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  delete process.env.GEMINI_API_KEY;
  const ledger = installLedger(t);
  const client = getOpenAIClient();
  assert.ok(client);
  stub(t, client.chat.completions, "create", async () => ({
    choices: [{ finish_reason: "length", message: { content: JSON.stringify(parsedOutput) } }],
    usage: { prompt_tokens: 160, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } }
  }));

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_PROVIDER_INVALID"
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.cacheWrites.length, 0);
});

test("a definite OpenAI client rejection is recorded as not charged and remains retryable", async (t) => {
  environment(t);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "synthetic-never-log";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  delete process.env.GEMINI_API_KEY;
  const ledger = installLedger(t);
  const client = getOpenAIClient();
  assert.ok(client);
  const rejection = Object.assign(Object.create(OpenAI.BadRequestError.prototype), {
    name: "BadRequestError",
    message: "synthetic invalid request",
    status: 400
  });
  stub(t, client.chat.completions, "create", async () => { throw rejection; });

  await assert.rejects(
    parseResumeTextWithMeta(resumeText, "user-1", {
      highCostConfirmed: true,
      dataSharingConfirmed: true
    }),
    (error: unknown) => error instanceof PublicApiError &&
      error.details?.code === "RESUME_PARSE_PROVIDER_REJECTED" &&
      error.details.retryable === true
  );
  assert.equal(ledger.reconciliations[0]?.status, "FAILED");
  assert.equal(ledger.reconciliations[0]?.actualCostMicros, 0);
});
