"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The full-screen detail view on small screens. A native modal dialog provides
 * the focus trap, Escape handling, and the inert page behind it.
 */
export function DetailShell({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  // A layout effect, so close() runs while the dialog is still in the page. That is
  // what makes the browser return focus to the card that opened it.
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
      className="fixed inset-0 m-0 size-full max-h-none max-w-none overflow-y-auto bg-surface text-ink"
    >
      {children}
    </dialog>
  );
}
