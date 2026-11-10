import type { ReactNode } from "react";

import { joinClasses } from "@/client/format";

const TONES = {
  accent: "border-transparent bg-accent text-on-accent",
  neutral: "border-line-strong text-ink-muted",
  caution: "border-accent-ink text-accent-ink",
  danger: "border-danger/50 bg-danger-surface text-danger",
} as const;

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={joinClasses(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
