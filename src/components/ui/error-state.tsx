import type { ReactNode } from "react";

type ErrorStateProps = {
  title: string;
  message: string;
  /** Optional recovery control, such as a retry button. */
  action?: ReactNode;
};

export function ErrorState({ title, message, action }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/40 bg-danger-surface px-5 py-6 text-left sm:px-6"
    >
      <h2 className="font-semibold text-danger">{title}</h2>
      <p className="mt-1 text-sm text-ink">{message}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
