import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { ApplicationBoard } from "@/components/application-board";
import type { ApplicationBoardCard } from "@/lib/applications/board";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CARDS: ApplicationBoardCard[] = [
  {
    id: "app-saved",
    company: "Acme",
    title: "Solutions Engineer",
    status: "SAVED",
    fitScore: 84,
    followUpDueAt: "2026-11-08T00:00:00.000Z",
    hasResume: true,
    hasCoverLetter: true
  },
  {
    id: "app-applied",
    company: "Globex",
    title: "Support Engineer",
    status: "APPLIED",
    fitScore: null,
    followUpDueAt: null,
    hasResume: false,
    hasCoverLetter: false
  },
  {
    id: "app-rejected",
    company: "Initech",
    title: "Implementation Lead",
    status: "REJECTED",
    fitScore: 55,
    followUpDueAt: null,
    hasResume: true,
    hasCoverLetter: false
  }
];

async function mountBoard(handler: FetchHandler, cards: ApplicationBoardCard[] = CARDS) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://app.example.com/applications?view=board"
  });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return handler(input, init);
    }
  });
  let refreshes = 0;
  const router = { back() {}, forward() {}, push() {}, replace() {}, prefetch() {}, refresh() { refreshes += 1; } };
  const root = createRoot(container);
  const render = async (nextCards: ApplicationBoardCard[]) => {
    await act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router as never },
        createElement(ApplicationBoard, { cards: nextCards })));
    });
  };
  await render(cards);

  const zone = (status: string) => {
    const element = container.querySelector<HTMLElement>(`[data-drop-status='${status}']`);
    assert.ok(element, `drop zone ${status} must render`);
    return element;
  };
  const cardElement = (id: string) => container.querySelector<HTMLElement>(`[data-card-id='${id}']`);
  const columnOf = (id: string) => cardElement(id)?.closest<HTMLElement>("[data-drop-status]")?.dataset.dropStatus ?? null;

  function dragEvent(type: string, dataTransfer: { data: Map<string, string>; dropEffect: string; effectAllowed: string }) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        get dropEffect() { return dataTransfer.dropEffect; },
        set dropEffect(value: string) { dataTransfer.dropEffect = value; },
        get effectAllowed() { return dataTransfer.effectAllowed; },
        set effectAllowed(value: string) { dataTransfer.effectAllowed = value; },
        setData(format: string, value: string) { dataTransfer.data.set(format, value); },
        getData(format: string) { return dataTransfer.data.get(format) ?? ""; },
        types: ["text/plain"]
      }
    });
    return event;
  }

  return {
    container,
    fetchCalls,
    get refreshes() { return refreshes; },
    render,
    zone,
    cardElement,
    columnOf,
    text: () => container.textContent ?? "",
    status: () => container.querySelector("[role='status']")?.textContent ?? "",
    async drag(id: string, status: string) {
      const source = cardElement(id);
      assert.ok(source, `card ${id} must render`);
      const target = zone(status);
      const transfer = { data: new Map<string, string>(), dropEffect: "none", effectAllowed: "all" };
      let overAccepted = false;
      await act(async () => {
        source.dispatchEvent(dragEvent("dragstart", transfer));
      });
      await act(async () => {
        const over = dragEvent("dragover", transfer);
        target.dispatchEvent(over);
        overAccepted = over.defaultPrevented;
      });
      await act(async () => {
        target.dispatchEvent(dragEvent("drop", transfer));
        source.dispatchEvent(dragEvent("dragend", transfer));
      });
      return { overAccepted, transfer };
    },
    async openMenu(id: string) {
      const button = container.querySelector<HTMLButtonElement>(`#board-move-${id}`);
      assert.ok(button, `move button for ${id} must render`);
      await act(async () => { button.click(); });
      return button;
    },
    async chooseMenuTarget(id: string, status: string) {
      const option = container.querySelector<HTMLButtonElement>(`#board-move-menu-${id} button[data-status='${status}']`);
      assert.ok(option, `menu option ${status} for ${id} must render`);
      await act(async () => { option.click(); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      if (priorFetch) Object.defineProperty(globalThis, "fetch", priorFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  };
}

test("board renders status columns with company, title, fit badge, follow-up date, and document indicator", async () => {
  const board = await mountBoard(async () => { throw new Error("render must not call an API"); });
  try {
    for (const status of ["SAVED", "INTERESTED", "APPLIED", "RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW", "OFFER", "REJECTED", "GHOSTED", "ARCHIVED"]) {
      board.zone(status);
    }
    const acme = board.cardElement("app-saved");
    assert.ok(acme);
    assert.equal(board.columnOf("app-saved"), "SAVED");
    assert.match(acme.textContent ?? "", /Acme/);
    assert.match(acme.textContent ?? "", /Solutions Engineer/);
    assert.match(acme.textContent ?? "", /84% fit/);
    assert.match(acme.textContent ?? "", /Follow-up 2026-11-08/);
    assert.match(acme.textContent ?? "", /Resume and cover letter attached/);
    assert.equal(acme.getAttribute("draggable"), "true");
    assert.equal(acme.querySelector("a")?.getAttribute("href"), "/applications/app-saved");

    const globex = board.cardElement("app-applied");
    assert.match(globex?.textContent ?? "", /Unscored/);
    assert.match(globex?.textContent ?? "", /No follow-up set/);
    assert.match(globex?.textContent ?? "", /No documents attached/);

    assert.equal(board.cardElement("app-rejected"), null, "closed cards are collapsed by default");
    assert.match(board.zone("REJECTED").textContent ?? "", /Rejected/);
    assert.match(board.zone("REJECTED").textContent ?? "", /1/);
    const toggle = board.container.querySelector<HTMLButtonElement>("#board-closed-toggle");
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    await act(async () => { toggle?.click(); });
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    assert.equal(board.columnOf("app-rejected"), "REJECTED");
    assert.equal(board.fetchCalls.length, 0);
  } finally { await board.cleanup(); }
});

test("dragging a card moves it optimistically and saves through the existing PATCH route", async () => {
  const response = deferred<Response>();
  const board = await mountBoard(() => response.promise);
  try {
    const { overAccepted, transfer } = await board.drag("app-saved", "APPLIED");
    assert.equal(overAccepted, true, "a valid column accepts the drag");
    assert.equal(transfer.data.get("text/plain"), "app-saved");
    assert.equal(transfer.effectAllowed, "move");

    assert.equal(board.fetchCalls.length, 1);
    assert.equal(String(board.fetchCalls[0].input), "/api/applications/app-saved");
    assert.equal(board.fetchCalls[0].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(board.fetchCalls[0].init?.body)), { status: "APPLIED" });
    assert.equal(board.columnOf("app-saved"), "APPLIED", "card moves before the server answers");
    assert.match(board.status(), /Moving Acme to Applied/);

    await act(async () => {
      response.resolve(json({ application: { id: "app-saved", status: "APPLIED", followUpDueAt: "2026-11-12T09:00:00.000Z" } }));
      await response.promise;
    });
    assert.equal(board.columnOf("app-saved"), "APPLIED");
    assert.match(board.cardElement("app-saved")?.textContent ?? "", /Follow-up 2026-11-12/, "server follow-up rule wins");
    assert.match(board.status(), /Moved Acme to Applied/);
    assert.equal(board.refreshes, 1);
  } finally { await board.cleanup(); }
});

test("a failed save rolls the card back and announces the server error", async () => {
  const board = await mountBoard(async () => json({
    error: "Regenerate documents from the current reviewed evidence before saving this packet."
  }, 409));
  try {
    await board.drag("app-saved", "INTERESTED");
    assert.equal(board.fetchCalls.length, 1);
    assert.equal(board.columnOf("app-saved"), "SAVED");
    assert.match(board.cardElement("app-saved")?.textContent ?? "", /Follow-up 2026-11-08/, "previous follow-up restored");
    assert.match(board.status(), /Could not move Acme/);
    assert.match(board.status(), /Regenerate documents/);
    assert.match(board.status(), /back in Saved/);
    assert.equal(board.refreshes, 0);
  } finally { await board.cleanup(); }
});

test("a network failure also rolls back", async () => {
  const board = await mountBoard(async () => { throw new TypeError("Failed to fetch"); });
  try {
    await board.drag("app-applied", "OFFER");
    assert.equal(board.columnOf("app-applied"), "APPLIED");
    assert.equal(board.status(), "Could not move Globex: Failed to fetch. It is back in Applied.");
  } finally { await board.cleanup(); }
});

test("invalid or same-column drops never call the API", async () => {
  const board = await mountBoard(async () => { throw new Error("must not save"); });
  try {
    const backwards = await board.drag("app-applied", "SAVED");
    assert.equal(backwards.overAccepted, false, "a passive column refuses an applied card");
    assert.equal(board.columnOf("app-applied"), "APPLIED");
    assert.match(board.status(), /can't move back to Saved/i);

    const same = await board.drag("app-saved", "SAVED");
    assert.equal(same.overAccepted, false);
    assert.equal(board.columnOf("app-saved"), "SAVED");
    assert.equal(board.fetchCalls.length, 0);
  } finally { await board.cleanup(); }
});

test("the Move menu is a keyboard alternative that offers only valid targets and restores focus", async () => {
  const response = deferred<Response>();
  const board = await mountBoard(() => response.promise);
  try {
    const button = await board.openMenu("app-applied");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(button.getAttribute("aria-controls"), "board-move-menu-app-applied");
    const options = [...board.container.querySelectorAll<HTMLButtonElement>("#board-move-menu-app-applied button[data-status]")]
      .map((option) => option.dataset.status);
    assert.deepEqual(options, ["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW", "OFFER", "REJECTED", "GHOSTED", "ARCHIVED"]);

    await board.chooseMenuTarget("app-applied", "RECRUITER_SCREEN");
    assert.equal(board.columnOf("app-applied"), "RECRUITER_SCREEN");
    assert.equal(board.container.querySelector("#board-move-menu-app-applied"), null, "menu closes after choosing");
    assert.equal(board.container.ownerDocument.activeElement?.id, "board-move-app-applied", "focus follows the moved card");
    assert.deepEqual(JSON.parse(String(board.fetchCalls[0].init?.body)), { status: "RECRUITER_SCREEN" });

    await act(async () => {
      response.resolve(json({ application: { status: "RECRUITER_SCREEN", followUpDueAt: null } }));
      await response.promise;
    });
    assert.equal(board.columnOf("app-applied"), "RECRUITER_SCREEN");
  } finally { await board.cleanup(); }
});

test("Escape closes the Move menu and returns focus to its button", async () => {
  const board = await mountBoard(async () => { throw new Error("must not save"); });
  try {
    await board.openMenu("app-saved");
    const menu = board.container.querySelector<HTMLElement>("#board-move-menu-app-saved");
    assert.ok(menu);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(board.container.querySelector("#board-move-menu-app-saved"), null);
    assert.equal(board.container.ownerDocument.activeElement?.id, "board-move-app-saved");
    assert.equal(board.fetchCalls.length, 0);
  } finally { await board.cleanup(); }
});

test("a card cannot be moved twice while its first save is in flight", async () => {
  const response = deferred<Response>();
  const board = await mountBoard(() => response.promise);
  try {
    await board.drag("app-saved", "INTERESTED");
    await board.drag("app-saved", "APPLIED");
    assert.equal(board.fetchCalls.length, 1);
    assert.equal(board.columnOf("app-saved"), "INTERESTED");
    assert.equal(board.cardElement("app-saved")?.getAttribute("aria-busy"), "true");
    await act(async () => {
      response.resolve(json({ application: { status: "INTERESTED", followUpDueAt: null } }));
      await response.promise;
    });
    assert.equal(board.cardElement("app-saved")?.getAttribute("aria-busy"), "false");
  } finally { await board.cleanup(); }
});

test("fresh server cards replace local state after a refresh", async () => {
  const board = await mountBoard(async () => { throw new Error("must not save"); });
  try {
    await board.render([{ ...CARDS[0], status: "OFFER" }, CARDS[1]]);
    assert.equal(board.columnOf("app-saved"), "OFFER");
    assert.equal(board.cardElement("app-rejected"), null);
  } finally { await board.cleanup(); }
});
