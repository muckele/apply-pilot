import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPLICATION_DETAIL_FIELDS,
  applicationDetailsInputSchema,
  buildApplicationDetailsView,
  planApplicationDetailsSave,
  type ApplicationDetailRow
} from "@/lib/application-details";
import { classifyApplicationQuestion } from "@/lib/application-runs/question-classification";

const UPDATED = new Date("2026-11-10T10:00:00.000Z");

function row(id: string, category: string, question: string, answer: string, overrides: Partial<ApplicationDetailRow> = {}): ApplicationDetailRow {
  return {
    id,
    category,
    question,
    normalizedQuestion: question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    answer,
    sensitive: false,
    isActive: true,
    updatedAt: UPDATED,
    ...overrides
  };
}

function emptyInput() {
  return Object.fromEntries(APPLICATION_DETAIL_FIELDS.map((field) => [field.key, ""]));
}

const RESUME_CONTACT = {
  name: "Alex Rivera",
  email: "alex@example.test",
  phone: "+1 555 0100",
  linkedin: "linkedin.com/in/alex-example",
  github: "https://github.com/alex-example",
  portfolio: null,
  location: "Example City"
};

test("every detail's saved question is recognized by Fill as exactly that detail", () => {
  for (const field of APPLICATION_DETAIL_FIELDS) {
    const result = classifyApplicationQuestion({
      question: field.question,
      sectionHeading: null,
      helpText: null,
      autocomplete: null,
      fieldType: field.fieldType
    });
    assert.equal(result.permittedDisposition, "PROPOSABLE", field.key);
    assert.equal(result.semanticFieldKey, field.semanticFieldKey, field.key);
    assert.equal(result.classification === "CONTACT" ? "CONTACT" : "LINKS", field.category, field.key);
  }
});

test("details are prefilled from the parsed résumé and flagged until confirmed", () => {
  const view = buildApplicationDetailsView({ contactInfo: RESUME_CONTACT, rows: [] });
  const byKey = new Map(view.fields.map((field) => [field.key, field]));

  assert.equal(byKey.get("firstName")?.value, "Alex");
  assert.equal(byKey.get("lastName")?.value, "Rivera");
  assert.equal(byKey.get("fullName")?.value, "Alex Rivera");
  assert.equal(byKey.get("email")?.value, "alex@example.test");
  assert.equal(byKey.get("linkedin")?.value, "https://linkedin.com/in/alex-example");
  assert.equal(byKey.get("email")?.status, "FROM_RESUME");
  assert.equal(byKey.get("portfolio")?.status, "MISSING");
  assert.equal(view.confirmedCount, 0);
  assert.deepEqual(view.missingRequired, []);
});

test("missing required details are named so the user can add them", () => {
  const view = buildApplicationDetailsView({ contactInfo: { name: "Alex Rivera" }, rows: [] });
  assert.deepEqual(view.missingRequired, ["Email address", "Phone number"]);
});

test("saved, usable entries show as confirmed and win over the résumé", () => {
  const view = buildApplicationDetailsView({
    contactInfo: RESUME_CONTACT,
    rows: [
      row("r-email", "CONTACT", "Email address", "alex.saved@example.test"),
      row("r-link", "LINKS", "LinkedIn", "https://www.linkedin.com/in/alex-saved")
    ]
  });
  const byKey = new Map(view.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get("email")?.value, "alex.saved@example.test");
  assert.equal(byKey.get("email")?.status, "CONFIRMED");
  assert.equal(byKey.get("linkedin")?.status, "CONFIRMED");
  assert.equal(view.confirmedCount, 2);
});

test("a masked or turned-off entry is shown as not used by Fill", () => {
  const view = buildApplicationDetailsView({
    contactInfo: null,
    rows: [row("r-gh", "LINKS", "GitHub", "https://github.com/alex-saved", { sensitive: true })]
  });
  const github = view.fields.find((field) => field.key === "github");
  assert.equal(github?.status, "NOT_USED");
  assert.equal(github?.value, "https://github.com/alex-saved");
});

test("two usable entries for one detail are flagged because Fill cannot choose between them", () => {
  const view = buildApplicationDetailsView({
    contactInfo: null,
    rows: [
      row("r-1", "CONTACT", "Email address", "a@example.test"),
      row("r-2", "CONTACT", "Your email", "b@example.test")
    ]
  });
  assert.equal(view.fields.find((field) => field.key === "email")?.status, "DUPLICATE");
});

test("saving creates unmasked entries Fill can use", () => {
  const input = applicationDetailsInputSchema.parse({ ...emptyInput(), firstName: " Alex ", email: "alex@example.test" });
  const plan = planApplicationDetailsSave(input, []);
  assert.deepEqual(plan.creates.map((create) => [create.category, create.question, create.answer, create.sensitive]), [
    ["CONTACT", "First name", "Alex", false],
    ["CONTACT", "Email address", "alex@example.test", false]
  ]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deactivateIds, []);
});

test("saving updates the existing entry in place, unmasks it and turns off duplicates", () => {
  const rows = [
    row("r-1", "LINKS", "LinkedIn", "https://www.linkedin.com/in/old", { sensitive: true }),
    row("r-2", "LINKS", "LinkedIn profile URL", "https://www.linkedin.com/in/older")
  ];
  const input = applicationDetailsInputSchema.parse({ ...emptyInput(), linkedin: "https://www.linkedin.com/in/alex-example" });
  const plan = planApplicationDetailsSave(input, rows);
  assert.deepEqual(plan.creates, []);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].answer, "https://www.linkedin.com/in/alex-example");
  assert.equal(plan.updates[0].sensitive, false);
  assert.equal(plan.updates[0].isActive, true);
  assert.equal(plan.deactivateIds.length, 1);
  assert.notEqual(plan.deactivateIds[0], plan.updates[0].id);
});

test("an unchanged confirmed entry is left alone so approved packets stay current", () => {
  const rows = [row("r-email", "CONTACT", "Email address", "alex@example.test")];
  const input = applicationDetailsInputSchema.parse({ ...emptyInput(), email: "alex@example.test" });
  const plan = planApplicationDetailsSave(input, rows);
  assert.deepEqual(plan, { creates: [], updates: [], deactivateIds: [] });
});

test("clearing a detail turns its entries off instead of deleting them", () => {
  const rows = [row("r-phone", "CONTACT", "Phone number", "+1 555 0100")];
  const plan = planApplicationDetailsSave(applicationDetailsInputSchema.parse(emptyInput()), rows);
  assert.deepEqual(plan, { creates: [], updates: [], deactivateIds: ["r-phone"] });
});

test("a same-question entry in another category is reused rather than duplicated", () => {
  const rows = [row("r-general", "GENERAL", "Email address", "old@example.test")];
  const input = applicationDetailsInputSchema.parse({ ...emptyInput(), email: "alex@example.test" });
  const plan = planApplicationDetailsSave(input, rows);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates.map((update) => [update.id, update.category, update.answer]), [
    ["r-general", "CONTACT", "alex@example.test"]
  ]);
});

test("invalid details are rejected before anything is saved", () => {
  for (const [key, value] of [
    ["email", "not-an-email"],
    ["phone", "call me"],
    ["linkedin", "https://example.test/alex"],
    ["github", "javascript:alert(1)"],
    ["website", "ftp://example.test"],
    ["firstName", "x".repeat(101)]
  ] as const) {
    assert.equal(applicationDetailsInputSchema.safeParse({ ...emptyInput(), [key]: value }).success, false, key);
  }
  assert.equal(
    applicationDetailsInputSchema.safeParse({ ...emptyInput(), linkedin: "linkedin.com/in/alex" }).success,
    true
  );
  assert.equal(
    applicationDetailsInputSchema.parse({ ...emptyInput(), linkedin: "linkedin.com/in/alex" }).linkedin,
    "https://linkedin.com/in/alex"
  );
});
