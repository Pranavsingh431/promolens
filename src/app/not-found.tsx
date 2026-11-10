import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <EmptyState title="Page not found" headingLevel="h1">
        This page does not exist.{" "}
        <Link href="/" className="font-medium text-accent-ink underline underline-offset-4">
          Go to PromoLens
        </Link>
      </EmptyState>
    </main>
  );
}
