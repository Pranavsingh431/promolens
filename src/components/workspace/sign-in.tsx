"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";

const FIELD =
  "mt-1 block w-full rounded-sm border border-line-strong bg-surface px-3 py-2 text-base";

export function SignIn() {
  const router = useRouter();
  const nameId = useId();
  const codeId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), code: form.get("code") }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      if (response.status === 401) setError("That name and access code do not match.");
      else if (response.status === 429) setError("Too many attempts. Wait a few minutes.");
      else setError("Sign-in is not available right now. Try again in a few minutes.");
    } catch {
      setError("We could not reach PromoLens. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main id="main" className="mx-auto max-w-md px-4 pt-12 pb-16 sm:px-6 sm:pt-16">
      <h1 className="font-display text-4xl">Sign in to analyze screenplays</h1>
      <p className="mt-3 text-ink-muted">
        Screenplays are confidential, so analysis is open only to invited editors.
      </p>
      <form className="mt-8 space-y-4" onSubmit={(event) => void submit(event)}>
        <div>
          <label htmlFor={nameId} className="text-sm font-medium">
            Editor name
          </label>
          <input
            id={nameId}
            name="name"
            required
            maxLength={40}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor={codeId} className="text-sm font-medium">
            Access code
          </label>
          <input
            id={codeId}
            name="code"
            type="password"
            required
            maxLength={200}
            autoComplete="current-password"
            className={FIELD}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
      <p className="mt-8 text-sm text-ink-muted">
        No access code?{" "}
        <Link href="/demo" className="font-medium text-accent-ink underline underline-offset-4">
          See how it works with a made-up show
        </Link>
        .
      </p>
    </main>
  );
}
