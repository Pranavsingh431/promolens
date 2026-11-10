/**
 * Every way an inference call can fail, with whether a retry can help.
 * Messages are short and never include prompt or completion text.
 */

export const INFERENCE_ERROR_KINDS = [
  "auth",
  "payment",
  "invalid-request",
  "content-policy",
  "not-found",
  "rate-limit",
  "timeout",
  "aborted",
  "network",
  "provider",
  "no-provider",
  "malformed-response",
  "empty-completion",
  "truncated",
  "refusal",
  "malformed-json",
  "schema-invalid",
  "budget",
  "request-limit",
  "config",
] as const;
export type InferenceErrorKind = (typeof INFERENCE_ERROR_KINDS)[number];

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

export type Spend = {
  usage: Usage;
  billedUsd: number | null;
  estimatedUsd: number;
  attempts: number;
};

export class InferenceError extends Error {
  kind: InferenceErrorKind;
  retryable: boolean;
  status: number | undefined;
  errorType: string | undefined;
  retryAfterMs: number | undefined;
  /** Tokens and cost spent on failed attempts, so callers can still account for them. */
  spend: Spend | undefined;

  constructor(
    kind: InferenceErrorKind,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      errorType?: string;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.errorType = options.errorType;
    this.retryAfterMs = options.retryAfterMs;
    this.spend = undefined;
  }
}

/** Retry-After as seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

type ErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    metadata?: { error_type?: unknown; limit_source?: unknown };
  };
};

function shortMessage(body: unknown, fallback: string): string {
  const message = (body as ErrorBody | null)?.error?.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 160) : fallback;
}

/** Maps an OpenRouter error (HTTP status plus body) to an InferenceError. */
export function classifyError(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): InferenceError {
  const error = (body as ErrorBody | null)?.error;
  const errorType =
    typeof error?.metadata?.error_type === "string" ? error.metadata.error_type : undefined;
  const limitSource = error?.metadata?.limit_source;
  const retryAfterMs = parseRetryAfter(retryAfter);
  const common = {
    status,
    ...(errorType ? { errorType } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  const message = (fallback: string) => `HTTP ${status}: ${shortMessage(body, fallback)}`;

  if (status === 401)
    return new InferenceError("auth", message("API key is missing, invalid, or revoked."), common);
  if (status === 402) {
    const transient = limitSource === "openrouter_in_flight_budget";
    return new InferenceError("payment", message("Insufficient credits."), {
      ...common,
      retryable: transient,
    });
  }
  if (status === 403)
    return new InferenceError("content-policy", message("Request was blocked or refused."), common);
  if (status === 404)
    return new InferenceError("not-found", message("Model or resource not found."), common);
  if (status === 408)
    return new InferenceError("timeout", message("Request timed out upstream."), {
      ...common,
      retryable: true,
    });
  if (status === 429)
    return new InferenceError("rate-limit", message("Rate limited."), {
      ...common,
      retryable: true,
    });
  if (status === 503 && errorType !== "provider_overloaded") {
    return new InferenceError(
      "no-provider",
      message(
        "No provider meets the routing requirements (strict data retention and structured outputs).",
      ),
      { ...common, retryable: true },
    );
  }
  if (status >= 500)
    return new InferenceError("provider", message("Provider error."), {
      ...common,
      retryable: true,
    });
  return new InferenceError("invalid-request", message("Invalid request."), common);
}
