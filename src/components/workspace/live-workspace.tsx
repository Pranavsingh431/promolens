"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { AnalysisService } from "@/client/service";
import { unavailableService } from "@/client/unavailable-service";
import { Button, buttonClass } from "@/components/ui/button";

import { RecentAnalyses } from "./recent-analyses";
import { SignIn } from "./sign-in";
import { Workspace } from "./workspace";

export type LiveAccess =
  | { kind: "unconfigured" }
  | { kind: "unavailable" }
  | { kind: "signed-out" }
  | { kind: "editor"; name: string };

const demoLink = (
  <Link href="/demo" className="font-medium text-accent-ink underline underline-offset-4">
    See how it works with a made-up show
  </Link>
);

const loadService = () => import("@/client/http-service");

/** Loads the real service on first use, so its validators stay out of the first page load. */
function lazyHttpService(): AnalysisService {
  let real: Promise<AnalysisService> | null = null;
  const service = () => (real ??= loadService().then((m) => m.createHttpService()));
  return {
    startAnalysis: async (file, options) => (await service()).startAnalysis(file, options),
    getJob: async (id, options) => (await service()).getJob(id, options),
    cancelJob: async (id) => (await service()).cancelJob(id),
    getResults: async (id, options) => (await service()).getResults(id, options),
    getEpisode: async (id, n, options) => (await service()).getEpisode(id, n, options),
    exportResults: async (id, format) => (await service()).exportResults(id, format),
    retryJob: async (id) => (await (await service()).retryJob?.(id)) as never,
    listJobs: async (options) => (await (await service()).listJobs?.(options)) ?? [],
    deleteShow: async (id) => (await service()).deleteShow?.(id),
  };
}

const whenVisible = async (signal: AbortSignal) =>
  (await loadService()).whenDocumentVisible(signal);

function ConnectedWorkspace({ name, initialJobId }: { name: string; initialJobId?: string }) {
  const [service] = useState(lazyHttpService);
  const router = useRouter();
  const onJobChange = useCallback((jobId: string | null) => {
    window.history.replaceState(null, "", jobId ? `/?job=${jobId}` : "/");
  }, []);

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    router.replace("/");
    router.refresh();
  }

  return (
    <Workspace
      service={service}
      onJobChange={onJobChange}
      whenVisible={whenVisible}
      onSignInAgain={() => router.refresh()}
      {...(initialJobId ? { initialJobId } : {})}
      progressNote="This can take a few minutes. You can close this page: the analysis keeps running, and it will be waiting under Earlier analyses."
      note={
        <p className="flex flex-wrap items-center gap-x-3">
          <span>Signed in as {name}.</span>
          <Button variant="quiet" onClick={() => void signOut()}>
            Sign out
          </Button>
        </p>
      }
      renderIdle={(open) => <RecentAnalyses service={service} onOpen={open} />}
    />
  );
}

/** The real workspace. It shows analysis only to a signed-in editor on a configured deployment. */
export function LiveWorkspace({
  access,
  initialJobId,
}: {
  access: LiveAccess;
  initialJobId?: string;
}) {
  if (access.kind === "signed-out") return <SignIn />;
  if (access.kind === "editor") {
    return <ConnectedWorkspace name={access.name} {...(initialJobId ? { initialJobId } : {})} />;
  }
  return (
    <Workspace
      service={unavailableService}
      unavailableAction={
        <Link href="/demo" className={buttonClass("secondary")}>
          See the demo with a made-up show
        </Link>
      }
      note={
        <p>
          {access.kind === "unavailable"
            ? "Analysis is temporarily unavailable. Try again in a few minutes."
            : "This preview cannot analyze screenplays yet."}{" "}
          {demoLink}.
        </p>
      }
    />
  );
}
