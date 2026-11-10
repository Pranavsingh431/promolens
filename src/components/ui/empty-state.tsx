import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand/brand-mark";

type EmptyStateProps = {
  title: string;
  /** Heading level that fits the surrounding outline. */
  headingLevel?: "h1" | "h2" | "h3";
  children: ReactNode;
};

export function EmptyState({ title, headingLevel = "h3", children }: EmptyStateProps) {
  const Heading = headingLevel;

  return (
    <div className="flex flex-col items-center rounded-md border border-dashed border-line bg-sunken px-6 py-12 text-center">
      <BrandMark size={44} />
      <Heading className="mt-4 font-display text-2xl">{title}</Heading>
      <div className="mt-2 max-w-sm text-sm text-ink-muted">{children}</div>
    </div>
  );
}
