"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ConfirmFn } from "@/lib/ai/browser-request";

export type InPageConfirmRequest = { title: string; body: string; confirmLabel?: string };

type Pending = InPageConfirmRequest & { id: number };

// An inline question that replaces window.confirm. The caller places `dialog` in normal flow.
// One question at a time: asking again cancels the open one; unmounting cancels it too.
export function useInPageConfirm(): {
  confirm: (request: InPageConfirmRequest) => Promise<boolean>;
  confirmFn: ConfirmFn;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const counter = useRef(0);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const settle = useCallback((answer: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(answer);
  }, []);

  const confirm = useCallback((request: InPageConfirmRequest) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      counter.current += 1;
      setPending({ ...request, id: counter.current });
    });
  }, []);

  const confirmFn = useCallback<ConfirmFn>(
    (message) => confirm({ title: "Before this runs", body: message }),
    [confirm]
  );

  useEffect(() => () => {
    resolver.current?.(false);
    resolver.current = null;
  }, []);

  const openId = pending?.id;
  useEffect(() => {
    if (openId !== undefined) confirmButton.current?.focus();
  }, [openId]);

  const dialog = pending ? (
    <div
      key={pending.id}
      role="group"
      aria-labelledby={`in-page-confirm-title-${pending.id}`}
      className="job-card in-page-confirm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          settle(false);
        }
      }}
    >
      <p id={`in-page-confirm-title-${pending.id}`} className="job-card-title">{pending.title}</p>
      <p className="job-card-copy">{pending.body}</p>
      <div className="job-actions">
        <button ref={confirmButton} type="button" className="job-button job-button-primary" onClick={() => settle(true)}>
          {pending.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" className="job-button" onClick={() => settle(false)}>Cancel</button>
      </div>
    </div>
  ) : null;

  return { confirm, confirmFn, dialog };
}
