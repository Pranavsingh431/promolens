import type { ReactNode } from "react";

/** A calm, non-error message: something an editor should know, and what to do next. */
export function Notice({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-line-strong bg-sunken px-5 py-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-1 text-sm text-ink-muted">{children}</div>
      {action ? <div className="mt-3 flex flex-wrap items-center gap-3">{action}</div> : null}
    </div>
  );
}
