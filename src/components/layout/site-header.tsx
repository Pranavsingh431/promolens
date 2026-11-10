import Link from "next/link";

import { Logo } from "@/components/brand/logo";

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-workspace items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" aria-label="PromoLens home" className="rounded-sm">
          <Logo />
        </Link>
        <span className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-muted">
          Early preview
        </span>
      </div>
    </header>
  );
}
