"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/ui/error-state";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <ErrorState
        title="Something went wrong"
        message="This page could not be shown. Try again, and reload the page if the problem continues."
        action={
          <button
            type="button"
            onClick={reset}
            className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:brightness-95"
          >
            Try again
          </button>
        }
      />
    </main>
  );
}
