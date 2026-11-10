import type { ReactNode } from "react";

type PanelProps = {
  /** Used for the heading id so the section is labelled for screen readers. */
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
};

export function Panel({ id, title, description, children }: PanelProps) {
  const headingId = `${id}-heading`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-line bg-surface p-5 shadow-raised sm:p-6"
    >
      <div className="mb-5">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
