import type { ButtonHTMLAttributes } from "react";

import { joinClasses } from "@/client/format";

type Variant = "primary" | "secondary" | "quiet";

const VARIANTS: Record<Variant, string> = {
  primary: "rounded-sm bg-accent px-4 py-2 text-on-accent hover:brightness-95",
  secondary: "rounded-sm border border-line-strong bg-surface px-4 py-2 text-ink hover:bg-sunken",
  quiet: "rounded-sm text-accent-ink underline underline-offset-4 hover:no-underline",
};

export function buttonClass(variant: Variant = "primary"): string {
  return joinClasses(
    "inline-flex cursor-pointer items-center justify-center text-sm font-medium",
    "disabled:cursor-not-allowed disabled:opacity-60",
    VARIANTS[variant],
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return (
    <button type="button" {...props} className={joinClasses(buttonClass(variant), className)} />
  );
}
