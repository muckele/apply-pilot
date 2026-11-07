"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { ApplicationStatus } from "@prisma/client";
import { CalendarDays, ChevronDown, ChevronRight, GripVertical, Loader2, Paperclip } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ScoreBadge, StatusBadge } from "@/components/ui";
import {
  applyBoardMove,
  boardMoveTargets,
  canMoveOnBoard,
  describeBoardDocuments,
  groupApplicationBoard,
  readBoardMoveResult,
  type ApplicationBoardCard
} from "@/lib/applications/board";
import { defaultFollowUpDueAt, formatApplicationStatus } from "@/lib/applications/pipeline";

type ApplicationBoardProps = {
  cards: ApplicationBoardCard[];
};

type Announcement = { tone: "info" | "error"; text: string };

const CLOSED_TOGGLE_ID = "board-closed-toggle";

function moveButtonId(cardId: string) {
  return `board-move-${cardId}`;
}

function moveMenuId(cardId: string) {
  return `board-move-menu-${cardId}`;
}

function formatFollowUp(value: string | null) {
  return value ? `Follow-up ${value.slice(0, 10)}` : "No follow-up set";
}

function requestErrorMessage(error: unknown) {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : "Could not update application status.";
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export function ApplicationBoard({ cards: serverCards }: ApplicationBoardProps) {
  const router = useRouter();
  const [cards, setCards] = useState(serverCards);
  const [syncedCards, setSyncedCards] = useState(serverCards);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<ApplicationStatus | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(false);
  const inFlight = useRef(new Set<string>());
  const focusAfterRender = useRef<string | null>(null);

  // Fresh server data (after router.refresh) replaces local state, except for saves still in flight.
  if (serverCards !== syncedCards) {
    setSyncedCards(serverCards);
    setCards(serverCards.map((card) => (pendingIds.has(card.id) ? (cards.find((item) => item.id === card.id) ?? card) : card)));
  }

  useEffect(() => {
    const target = focusAfterRender.current;
    if (!target) return;
    focusAfterRender.current = null;
    (document.getElementById(target) ?? document.getElementById(CLOSED_TOGGLE_ID))?.focus();
  });

  const draggingCard = draggingId ? cards.find((card) => card.id === draggingId) ?? null : null;
  const columns = groupApplicationBoard(cards);
  const closedCount = columns.find((view) => view.column.terminal)?.count ?? 0;

  function setPending(id: string, pending: boolean) {
    if (pending) inFlight.current.add(id);
    else inFlight.current.delete(id);
    setPendingIds(new Set(inFlight.current));
  }

  async function moveCard(id: string, target: ApplicationStatus) {
    const card = cards.find((item) => item.id === id);
    if (!card || inFlight.current.has(id) || card.status === target) return;

    if (!canMoveOnBoard(card.status, target)) {
      setAnnouncement({
        tone: "error",
        text: `${card.company} is already at ${formatApplicationStatus(card.status)}, so it can't move back to ${formatApplicationStatus(target)}.`
      });
      return;
    }

    const previous = { status: card.status, followUpDueAt: card.followUpDueAt };
    const predictedFollowUp = defaultFollowUpDueAt(target);
    setPending(id, true);
    setCards((current) => applyBoardMove(current, id, {
      status: target,
      followUpDueAt: predictedFollowUp ? predictedFollowUp.toISOString() : null
    }));
    setAnnouncement({ tone: "info", text: `Moving ${card.company} to ${formatApplicationStatus(target)}…` });

    try {
      const response = await fetch(`/api/applications/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: target })
      });
      const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof json?.error === "string" ? json.error : "Could not update application status.");
      }
      const saved = readBoardMoveResult(json, target);
      setCards((current) => applyBoardMove(current, id, saved));
      setAnnouncement({ tone: "info", text: `Moved ${card.company} to ${formatApplicationStatus(saved.status)}.` });
      router.refresh();
    } catch (error) {
      setCards((current) => applyBoardMove(current, id, previous));
      setAnnouncement({
        tone: "error",
        text: `Could not move ${card.company}: ${requestErrorMessage(error)} It is back in ${formatApplicationStatus(previous.status)}.`
      });
    } finally {
      setPending(id, false);
    }
  }

  function handleDragStart(event: DragEvent<HTMLElement>, card: ApplicationBoardCard) {
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
    setOpenMenuId(null);
    setDraggingId(card.id);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDropStatus(null);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, status: ApplicationStatus) {
    if (!draggingCard || inFlight.current.has(draggingCard.id) || !canMoveOnBoard(draggingCard.status, status)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropStatus !== status) setDropStatus(status);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>, status: ApplicationStatus) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (dropStatus === status) setDropStatus(null);
  }

  function handleDrop(event: DragEvent<HTMLElement>, status: ApplicationStatus) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(null);
    setDropStatus(null);
    if (id) void moveCard(id, status);
  }

  function chooseTarget(card: ApplicationBoardCard, status: ApplicationStatus) {
    setOpenMenuId(null);
    focusAfterRender.current = moveButtonId(card.id);
    void moveCard(card.id, status);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>, card: ApplicationBoardCard) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setOpenMenuId(null);
    focusAfterRender.current = moveButtonId(card.id);
  }

  function renderCard(card: ApplicationBoardCard) {
    const pending = pendingIds.has(card.id);
    const menuOpen = openMenuId === card.id;
    const targets = boardMoveTargets(card.status);

    return (
      <li key={card.id}>
        <article
          data-card-id={card.id}
          draggable={!pending}
          aria-busy={pending}
          onDragStart={(event) => handleDragStart(event, card)}
          onDragEnd={handleDragEnd}
          className={`rounded-lg border border-slate-200 bg-white p-3 shadow-sm ${pending ? "opacity-70" : "cursor-grab active:cursor-grabbing"} ${draggingId === card.id ? "ring-2 ring-brand-200" : ""}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-1.5">
              <GripVertical size={15} className="mt-0.5 shrink-0 text-slate-300" aria-hidden="true" />
              <div className="min-w-0">
                <Link
                  href={`/applications/${card.id}`}
                  draggable={false}
                  className="block truncate text-sm font-semibold text-slate-950 hover:text-brand-700"
                >
                  {card.company}
                </Link>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">{card.title}</p>
              </div>
            </div>
            <div className="shrink-0">
              <ScoreBadge score={card.fitScore} />
            </div>
          </div>

          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <CalendarDays size={14} aria-hidden="true" />
            {formatFollowUp(card.followUpDueAt)}
          </p>
          <p className={`mt-1 flex items-center gap-2 text-xs ${card.hasResume || card.hasCoverLetter ? "text-slate-700" : "text-slate-400"}`}>
            <Paperclip size={14} aria-hidden="true" />
            {describeBoardDocuments(card)}
          </p>

          <div className="relative mt-3">
            <button
              type="button"
              id={moveButtonId(card.id)}
              aria-expanded={menuOpen}
              aria-controls={moveMenuId(card.id)}
              aria-label={`Move ${card.company}, ${card.title}`}
              aria-disabled={pending || !targets.length}
              onClick={() => {
                // aria-disabled (not disabled) keeps keyboard focus on the button while its save is in flight.
                if (pending || !targets.length) return;
                setOpenMenuId(menuOpen ? null : card.id);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            >
              {pending ? <Loader2 className="animate-spin" size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              {pending ? "Saving…" : "Move"}
            </button>
            {menuOpen ? (
              <ul
                id={moveMenuId(card.id)}
                aria-label={`Move ${card.company} to`}
                onKeyDown={(event) => handleMenuKeyDown(event, card)}
                className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-1"
              >
                {targets.map((target) => (
                  <li key={target.status}>
                    <button
                      type="button"
                      data-status={target.status}
                      onClick={() => chooseTarget(card, target.status)}
                      className="w-full rounded-md px-2 py-1 text-left text-xs font-medium text-slate-700 hover:bg-white focus:bg-white"
                    >
                      {target.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </article>
      </li>
    );
  }

  function dropZoneClass(status: ApplicationStatus) {
    if (!draggingCard) return "border-transparent";
    if (dropStatus === status) return "border-brand-400 bg-brand-50";
    return canMoveOnBoard(draggingCard.status, status) ? "border-dashed border-slate-300" : "border-transparent opacity-50";
  }

  return (
    <div>
      <p className="sr-only" id="board-instructions">
        Drag a card to another column to change its status, or use the card&apos;s Move button.
      </p>
      <p
        role="status"
        aria-live="polite"
        className={announcement
          ? `mx-4 mt-4 rounded-lg px-3 py-2 text-xs ${announcement.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-700"}`
          : "sr-only"}
      >
        {announcement?.text ?? ""}
      </p>
      <div className="flex gap-4 overflow-x-auto p-4" aria-describedby="board-instructions">
        {columns.map(({ column, count, groups }) => {
          const collapsed = column.terminal && !closedExpanded;

          return (
            <section
              key={column.key}
              aria-label={`${column.label}, ${count} ${count === 1 ? "record" : "records"}`}
              className="flex w-72 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-50"
            >
              <div className="border-b border-slate-200 p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">{column.label}</h3>
                  <StatusBadge status={String(count)} />
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-500">{column.description}</p>
                {column.terminal ? (
                  <button
                    type="button"
                    id={CLOSED_TOGGLE_ID}
                    aria-expanded={closedExpanded}
                    onClick={() => setClosedExpanded((value) => !value)}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800"
                  >
                    {closedExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    {closedExpanded ? "Hide closed records" : `Show ${closedCount} closed ${closedCount === 1 ? "record" : "records"}`}
                  </button>
                ) : null}
              </div>
              <div className="flex-1 space-y-3 p-3">
                {groups.map((group) => (
                  <div
                    key={group.status}
                    data-drop-status={group.status}
                    onDragOver={(event) => handleDragOver(event, group.status)}
                    onDragLeave={(event) => handleDragLeave(event, group.status)}
                    onDrop={(event) => handleDrop(event, group.status)}
                    className={`${collapsed ? "py-2" : "min-h-16"} rounded-lg border-2 p-1 transition-colors ${dropZoneClass(group.status)}`}
                  >
                    {column.terminal ? (
                      <div className="flex items-center justify-between px-1 pb-1 text-xs font-semibold text-slate-600">
                        <span>{group.label}</span>
                        <span>{group.cards.length}</span>
                      </div>
                    ) : null}
                    {collapsed ? null : group.cards.length ? (
                      <ul className="space-y-3">{group.cards.map(renderCard)}</ul>
                    ) : (
                      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-center text-xs text-slate-500">
                        {draggingCard && !canMoveOnBoard(draggingCard.status, group.status) && draggingCard.status !== group.status
                          ? "Can't move back here"
                          : "No records"}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
