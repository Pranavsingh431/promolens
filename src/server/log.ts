/**
 * Structured operational logs. The field list is closed on purpose: it can
 * hold ids, counts, and categories, and nothing that could carry screenplay
 * text, prompts, model answers, keys, or session tokens.
 */

export type LogFields = {
  jobId?: string;
  attempt?: number;
  stage?: string;
  state?: string;
  phase?: string;
  outcome?: string;
  errorCategory?: string;
  durationMs?: number;
  episodes?: number;
  moments?: number;
  requests?: number;
  liveJudgments?: number;
  cachedJudgments?: number;
  failedJudgments?: number;
  refusedJudgments?: number;
  retries?: number;
  inputTokens?: number;
  outputTokens?: number;
  billedUsd?: number | null;
  estimatedUsd?: number;
  status?: number;
  route?: string;
};

export function logEvent(event: string, fields: LogFields = {}): void {
  console.info(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}
