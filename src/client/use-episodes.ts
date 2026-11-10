"use client";

import { useEffect, useState } from "react";

import type { Episode } from "@/domain/screenplay/schema";

import type { AnalysisService } from "./service";

/**
 * Loads source episodes only when a clip from them is inspected, and keeps
 * them for the session, so moving between clips never fetches one twice.
 */
export type EpisodeCache = { get: (episode: number) => Promise<Episode> };

export function createEpisodeCache(service: AnalysisService, jobId: string): EpisodeCache {
  const loaded = new Map<number, Promise<Episode>>();
  return {
    get(episode) {
      let request = loaded.get(episode);
      if (!request) {
        request = service.getEpisode(jobId, episode);
        loaded.set(episode, request);
        // A failed load must not stay cached, or "Try again" could never succeed.
        request.catch(() => loaded.delete(episode));
      }
      return request;
    },
  };
}

type EpisodesState =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "ready"; episodes: Episode[] };

export function useEpisodes(cache: EpisodeCache, numbers: readonly number[]): EpisodesState {
  const key = [...new Set(numbers)].join(",");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    token: string;
    episodes: Episode[] | null;
  } | null>(null);
  const token = `${key}#${attempt}`;

  useEffect(() => {
    let live = true;
    Promise.all(key.split(",").map((n) => cache.get(Number(n)))).then(
      (episodes) => {
        if (live) setResult({ token, episodes });
      },
      () => {
        if (live) setResult({ token, episodes: null });
      },
    );
    return () => {
      live = false;
    };
  }, [cache, key, token]);

  if (result?.token !== token) return { status: "loading" };
  if (result.episodes) return { status: "ready", episodes: result.episodes };
  return { status: "error", retry: () => setAttempt((n) => n + 1) };
}
