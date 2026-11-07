import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ApplicationStatus } from "@prisma/client";

import {
  applicationBoardColumns,
  applyBoardMove,
  boardMoveTargets,
  canMoveOnBoard,
  describeBoardDocuments,
  groupApplicationBoard,
  readBoardMoveResult,
  toApplicationBoardCard,
  type ApplicationBoardCard
} from "@/lib/applications/board";
import {
  applicationsViewHref,
  parseApplicationFilters,
  parseApplicationsView
} from "@/lib/applications/list-view";
import { applicationStatusOptions } from "@/lib/applications/pipeline";

function card(id: string, status: ApplicationStatus, overrides: Partial<ApplicationBoardCard> = {}): ApplicationBoardCard {
  return {
    id,
    company: `Company ${id}`,
    title: `Role ${id}`,
    status,
    fitScore: null,
    followUpDueAt: null,
    hasResume: false,
    hasCoverLetter: false,
    ...overrides
  };
}

test("board columns cover every application status exactly once and collapse terminal statuses together", () => {
  const seen = applicationBoardColumns.flatMap((column) => column.statuses);
  assert.deepEqual([...seen].sort(), applicationStatusOptions.map((option) => option.value).sort());
  assert.equal(new Set(seen).size, seen.length);

  const terminalColumns = applicationBoardColumns.filter((column) => column.terminal);
  assert.equal(terminalColumns.length, 1);
  assert.deepEqual(terminalColumns[0].statuses, ["REJECTED", "GHOSTED", "ARCHIVED"]);
  for (const column of applicationBoardColumns.filter((item) => !item.terminal)) {
    assert.equal(column.statuses.length, 1, `${column.key} must map to one droppable status`);
  }
  assert.deepEqual(
    applicationBoardColumns.filter((column) => !column.terminal).map((column) => column.statuses[0]),
    ["SAVED", "INTERESTED", "APPLIED", "RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW", "OFFER"]
  );
});

test("board grouping keeps input order inside each status and counts every terminal record in Closed", () => {
  const cards = [
    card("a", "APPLIED"),
    card("b", "SAVED"),
    card("c", "REJECTED"),
    card("d", "APPLIED"),
    card("e", "ARCHIVED"),
    card("f", "GHOSTED")
  ];
  const board = groupApplicationBoard(cards);

  assert.deepEqual(board.map((column) => column.column.key), applicationBoardColumns.map((column) => column.key));
  const applied = board.find((column) => column.column.key === "APPLIED");
  assert.deepEqual(applied?.groups.map((group) => group.cards.map((item) => item.id)), [["a", "d"]]);
  assert.equal(applied?.count, 2);

  const closed = board.find((column) => column.column.terminal);
  assert.equal(closed?.count, 3);
  assert.deepEqual(closed?.groups.map((group) => [group.status, group.label, group.cards.map((item) => item.id)]), [
    ["REJECTED", "Rejected", ["c"]],
    ["GHOSTED", "Ghosted", ["f"]],
    ["ARCHIVED", "Archived", ["e"]]
  ]);
  assert.equal(board.find((column) => column.column.key === "OFFER")?.count, 0);
});

test("board moves mirror the server passive-status guard instead of silently no-oping", () => {
  assert.equal(canMoveOnBoard("SAVED", "APPLIED"), true);
  assert.equal(canMoveOnBoard("INTERESTED", "SAVED"), true);
  assert.equal(canMoveOnBoard("APPLIED", "REJECTED"), true);
  assert.equal(canMoveOnBoard("REJECTED", "RECRUITER_SCREEN"), true);
  assert.equal(canMoveOnBoard("APPLIED", "APPLIED"), false, "same status is a no-op");
  assert.equal(canMoveOnBoard("APPLIED", "SAVED"), false);
  assert.equal(canMoveOnBoard("OFFER", "INTERESTED"), false);
  assert.equal(canMoveOnBoard("ARCHIVED", "SAVED"), false);

  assert.deepEqual(
    boardMoveTargets("APPLIED").map((target) => target.status),
    ["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW", "OFFER", "REJECTED", "GHOSTED", "ARCHIVED"]
  );
  assert.deepEqual(boardMoveTargets("SAVED")[0], { status: "INTERESTED", label: "Interested" });
});

test("board card DTO carries only display fields, a validated fit score, ISO follow-up, and document flags", () => {
  const dto = toApplicationBoardCard({
    id: "app-1",
    status: "APPLIED",
    followUpDueAt: new Date("2026-11-10T08:00:00.000Z"),
    resumeVersionId: "resume-v1",
    coverLetterVersionId: null,
    notes: "private note that must not reach the client",
    jobPosting: { company: "Acme", title: "Solutions Engineer", description: "long text" }
  }, 81);

  assert.deepEqual(dto, {
    id: "app-1",
    company: "Acme",
    title: "Solutions Engineer",
    status: "APPLIED",
    fitScore: 81,
    followUpDueAt: "2026-11-10T08:00:00.000Z",
    hasResume: true,
    hasCoverLetter: false
  });

  for (const invalid of [Number.NaN, 101, -1, undefined, null]) {
    const unscored = toApplicationBoardCard({
      id: "app-2", status: "SAVED", followUpDueAt: null, resumeVersionId: null, coverLetterVersionId: null,
      jobPosting: { company: "B", title: "T" }
    }, invalid);
    assert.equal(unscored.fitScore, null);
    assert.equal(unscored.followUpDueAt, null);
  }
});

test("document indicator copy names what is attached", () => {
  assert.equal(describeBoardDocuments(card("a", "SAVED", { hasResume: true, hasCoverLetter: true })), "Resume and cover letter attached");
  assert.equal(describeBoardDocuments(card("a", "SAVED", { hasResume: true })), "Resume attached");
  assert.equal(describeBoardDocuments(card("a", "SAVED", { hasCoverLetter: true })), "Cover letter attached");
  assert.equal(describeBoardDocuments(card("a", "SAVED")), "No documents attached");
});

test("board move helper updates one card immutably", () => {
  const before = [card("a", "SAVED"), card("b", "APPLIED")];
  const after = applyBoardMove(before, "a", { status: "INTERESTED", followUpDueAt: "2026-11-06T00:00:00.000Z" });
  assert.notEqual(after, before);
  assert.equal(before[0].status, "SAVED");
  assert.equal(after[0].status, "INTERESTED");
  assert.equal(after[0].followUpDueAt, "2026-11-06T00:00:00.000Z");
  assert.equal(after[1], before[1]);
  assert.deepEqual(applyBoardMove(before, "missing", { status: "OFFER" }), before);
});

test("board move result trusts only a valid server status and follow-up date", () => {
  assert.deepEqual(
    readBoardMoveResult({ application: { status: "APPLIED", followUpDueAt: "2026-11-10T00:00:00.000Z", notes: "x" } }, "APPLIED"),
    { status: "APPLIED", followUpDueAt: "2026-11-10T00:00:00.000Z" }
  );
  assert.deepEqual(
    readBoardMoveResult({ application: { status: "REJECTED", followUpDueAt: null } }, "REJECTED"),
    { status: "REJECTED", followUpDueAt: null }
  );
  assert.deepEqual(
    readBoardMoveResult({ application: { status: "NOT_A_STATUS", followUpDueAt: "not a date" } }, "OFFER"),
    { status: "OFFER", followUpDueAt: null }
  );
  assert.deepEqual(readBoardMoveResult(null, "OFFER"), { status: "OFFER" });
});

test("list/board toggle preserves the current filters and drops unknown values", () => {
  const filters = parseApplicationFilters({
    q: "  acme  ",
    status: ["APPLIED", "OFFER"],
    attention: "needs_attention",
    view: "board"
  });
  assert.deepEqual(filters, { q: "acme", status: "APPLIED", attention: true });
  assert.equal(applicationsViewHref(filters, "board"), "/applications?q=acme&status=APPLIED&attention=needs_attention&view=board");
  assert.equal(applicationsViewHref(filters, "list"), "/applications?q=acme&status=APPLIED&attention=needs_attention");
  assert.equal(applicationsViewHref({ q: "", status: "", attention: false }, "list"), "/applications");
  assert.equal(applicationsViewHref({ q: "R&D / ops", status: "", attention: false }, "board"), "/applications?q=R%26D+%2F+ops&view=board");

  assert.deepEqual(parseApplicationFilters({ status: "DROP TABLE", attention: "yes" }), { q: "", status: "", attention: false });
  assert.equal(parseApplicationsView({ view: "board" }), "board");
  assert.equal(parseApplicationsView({ view: ["board"] }), "board");
  assert.equal(parseApplicationsView({ view: "kanban" }), "list");
  assert.equal(parseApplicationsView({}), "list");
});

test("applications page wires the board, the view toggle, filter preservation, and the CSV download", () => {
  const source = readFileSync("app/(product)/applications/page.tsx", "utf8");
  assert.match(source, /<ApplicationBoard\b/);
  assert.match(source, /applicationsViewHref\(filters, "board"\)/);
  assert.match(source, /applicationsViewHref\(filters, "list"\)/);
  assert.match(source, /name="view"/, "filter form must keep the board view when filters are applied");
  assert.match(source, /href="\/api\/applications\/export"/);
  assert.doesNotMatch(source, /<Link[^>]+\/api\/applications\/export/, "the CSV download must not be a prefetching Next link");
});
