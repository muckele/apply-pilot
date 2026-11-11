import assert from "node:assert/strict";
import test from "node:test";

import { APPLICATION_RUN_STATES_FOR_PLAIN_LANGUAGE } from "@/lib/assisted-apply/plain-language";
import {
  answerStatusLabel,
  companionStateLabel,
  companionStatusSentence,
  connectionLabel,
  dispositionLabel,
  fieldTypeLabel,
  manualCategoryLabel,
  RAW_CONTROL_PAGE_CODES,
  runStateLabel,
  safeStopLabel
} from "@/lib/assisted-apply/plain-language";
import { APPLICATION_ANSWER_DISPOSITIONS } from "@/lib/application-runs/question-classification";
import { APPLICATION_FORM_FIELD_TYPES } from "@/lib/application-runs/form-inspection";
import { B1_WORKFLOW_STATES } from "@/lib/application-browser/types";

function assertPlain(label: string, context: string) {
  assert.ok(label.trim().length > 0, `${context}: empty label`);
  assert.equal(/[A-Z]{2,}_[A-Z_]+/.test(label), false, `${context}: label looks like a code: ${label}`);
}

test("every run state has a plain label", () => {
  for (const state of APPLICATION_RUN_STATES_FOR_PLAIN_LANGUAGE) {
    assertPlain(runStateLabel(state), state);
  }
  assert.equal(runStateLabel("COMPLETED_BY_USER"), "Done: you applied");
  assert.equal(runStateLabel("REVIEW_REQUIRED"), "Prepared, with things for you to check");
});

test("every companion state and connection has a plain label", () => {
  for (const state of B1_WORKFLOW_STATES) assertPlain(companionStateLabel(state), state);
  for (const connection of ["UNKNOWN", "CONNECTED", "UNAVAILABLE"] as const) {
    assertPlain(connectionLabel(connection), connection);
  }
  assert.equal(companionStateLabel("TARGET_OPEN"), "Employer's form is open");
  assert.equal(connectionLabel("UNAVAILABLE"), "Not connected");
});

test("every answer status, disposition, field type and manual category has a plain label", () => {
  for (const status of ["PENDING", "APPROVED", "REJECTED"] as const) assertPlain(answerStatusLabel(status), status);
  for (const disposition of APPLICATION_ANSWER_DISPOSITIONS) assertPlain(dispositionLabel(disposition), disposition);
  for (const fieldType of APPLICATION_FORM_FIELD_TYPES) assertPlain(fieldTypeLabel(fieldType), fieldType);
  for (const category of [
    "MANUAL_CONTROL_FAMILY", "MANUAL_ONLY", "UNSUPPORTED", "INTENTIONALLY_EXCLUDED", "USER_REJECTED"
  ] as const) {
    assertPlain(manualCategoryLabel(category), category);
  }
  assert.equal(dispositionLabel("PROPOSABLE"), "Apply Pilot can fill this");
  assert.equal(dispositionLabel("EXCLUDED"), "Apply Pilot never fills this kind of question");
});

test("safe-stop codes become plain sentences and unknown codes never leak", () => {
  assert.equal(
    safeStopLabel("CONTROL_NAVIGATION_TRUST_LOST"),
    "This page left its exact address, so Apply Pilot stopped safely."
  );
  const unknown = safeStopLabel("SOMETHING_NEW_AND_UNEXPECTED");
  assertPlain(unknown, "unknown code");
  assert.equal(unknown.includes("SOMETHING_NEW_AND_UNEXPECTED"), false);
});

test("the companion status sentence uses plain words for every state", () => {
  for (const state of B1_WORKFLOW_STATES) {
    for (const connection of ["UNKNOWN", "CONNECTED", "UNAVAILABLE"] as const) {
      const sentence = companionStatusSentence({ state, errorCode: state === "ERROR" ? "PAGE_CLOSED" : undefined }, connection, true);
      assertPlain(sentence, `${state}/${connection}`);
    }
  }
  assert.equal(
    companionStatusSentence({ state: "ERROR", errorCode: "PAGE_CLOSED" }, "CONNECTED", true),
    "Stopped safely: a browser page was closed."
  );
  assert.equal(
    companionStatusSentence({ state: "STARTING" }, "UNKNOWN", false),
    "Connecting to the Apply Pilot browser…"
  );
});

test("the raw-code list covers every enum the control page could show", () => {
  for (const code of [
    ...APPLICATION_RUN_STATES_FOR_PLAIN_LANGUAGE,
    ...B1_WORKFLOW_STATES,
    ...APPLICATION_ANSWER_DISPOSITIONS,
    "UNKNOWN",
    "UNAVAILABLE",
    "PREPARE_ONLY",
    "FILL_AND_REVIEW",
    "TEXTAREA",
    "SELECT_ONE",
    "MANUAL_CONTROL_FAMILY",
    "UNCONFIRMED_APPLICANT_CONTACT"
  ]) {
    assert.equal(RAW_CONTROL_PAGE_CODES.includes(code), true, `missing ${code}`);
  }
});
