"use client";

import { useEffect, useRef, type ReactNode } from "react";

// The one large window (G-6): a native modal dialog, so focus moves into it, the page behind is
// inert, and Esc closes it. Mounted only while open. On close, focus goes back to where it was.
export function BigWindow({
  labelledBy,
  onClose,
  children,
  dataAttribute
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  // A data-* name for tests and styling hooks, e.g. "data-result-window".
  dataAttribute?: `data-${string}`;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = element.ownerDocument.activeElement as HTMLElement | null;
    if (!element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      if (typeof element.close === "function" && element.open) element.close();
      if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="big-window"
      aria-labelledby={labelledBy}
      aria-modal="true"
      {...(dataAttribute ? { [dataAttribute]: "" } : {})}
      onCancel={(event) => {
        // Esc: the page decides (it unmounts the window), so the dialog never closes on its own.
        event.preventDefault();
        onClose();
      }}
    >
      <div className="big-window-body">{children}</div>
    </dialog>
  );
}
