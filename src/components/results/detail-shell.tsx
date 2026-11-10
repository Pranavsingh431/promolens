"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The promo detail view. A native modal dialog provides the focus trap, Escape
 * handling, and the inert page behind it. It fills a phone screen and opens as
 * a side panel on a wide one, so the list stays in view.
 */
export function DetailShell({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  // A layout effect, so close() runs while the dialog is still in the page.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label="Promo details"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        // A click on the dimmed area beside the panel closes it.
        if (event.target === event.currentTarget) onDismiss();
      }}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none overflow-y-auto overscroll-contain bg-surface text-ink backdrop:bg-[rgb(18_16_13/0.45)] lg:left-auto lg:w-[min(46rem,100%)] lg:border-l lg:border-line lg:shadow-raised"
    >
      <div className="min-h-full">{children}</div>
    </dialog>
  );
}
