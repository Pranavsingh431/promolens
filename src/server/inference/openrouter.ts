import {
  InferenceError,
  ZERO_USAGE,
  addUsage,
  classifyError,
  type Spend,
  type Usage,
} from "./errors.ts";
import type { SpendGuard } from "./limits.ts";

/**
 * Minimal client for an OpenAI-compatible Chat Completions API (OpenRouter by
 * default) that returns one validated JSON object.
 *
 * - Structured output through response_format json_schema, strict.
 * - Every response is parsed and validated locally, whatever the provider claims.
 * - Timeouts, cancellation, retries with exponential backoff and jitter, and
 *   Retry-After are handled here. Errors that a retry cannot fix are not retried.
 * - No tools, plugins, or web search are ever sent. Nothing here logs prompts
 *   or completions.
 */

export type Effort = "low" | "medium" | "high";
export type Pricing = { inputPerToken: number; outputPerToken: number };

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Shared by reasoning and visible output on reasoning models. */
  maxTokens: number;
  reasoningEffort: Effort | null;
  timeoutMs: number;
  maxAttempts: number;
  /** Provider routing preferences, sent unchanged. */
  provider: Record<string, unknown>;
  /** Used for worst-case reservations and for estimates when no billed cost is returned. */
  pricing: Pricing;
  /**
   * Name of the output limit parameter the routed endpoints accept. Some
   * endpoints list max_completion_tokens instead of max_tokens, and with
   * require_parameters an unsupported name would exclude them.
   */
  tokenLimitParam?: TokenLimitParam;
};

export type TokenLimitParam = "max_tokens" | "max_completion_tokens";

export type JsonRequest<T> = {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  parse: (value: unknown) => T;
};

export type JsonCompletion<T> = {
  value: T;
  spend: Spend;
  generationId: string | null;
  provider: string | null;
  servedModel: string | null;
  latencyMs: number;
};

export type CallOptions = {
  signal?: AbortSignal;
  guard?: SpendGuard;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Told about every failed attempt, including ones a later retry recovers from. */
  onAttemptError?: (error: InferenceError, attempt: number) => void;
};

const MAX_RETRY_WAIT_MS = 120_000;

/**
 * Characters per token used for the prompt-token upper bound. Measured on
 * 2026-11-10 with Claude Haiku 5.5: timestamped screenplay prompts ran at
 * about 2.2 characters per token, counting the system prompt, the user
 * message, and the JSON schema, which the provider adds to the prompt.
 * 1.5 leaves a wide margin.
 */
export const CHARS_PER_TOKEN_BOUND = 1.5;

/** Upper bound on the prompt tokens of a text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_BOUND);
}

/** Most a call can cost: every prompt token, including the schema, plus the full output limit. */
export function worstCaseUsd(
  request: { system: string; user: string; jsonSchema?: object },
  config: Pick<ModelConfig, "pricing" | "maxTokens">,
): number {
  const schema = request.jsonSchema ? JSON.stringify(request.jsonSchema) : "";
  return (
    estimateTokens(request.system + request.user + schema) * config.pricing.inputPerToken +
    config.maxTokens * config.pricing.outputPerToken
  );
}

export function buildRequestBody(request: JsonRequest<unknown>, config: ModelConfig) {
  if (/:online\b/.test(config.model)) {
    throw new InferenceError(
      "config",
      "Web-search model variants are not allowed for screenplay inference.",
    );
  }
  return {
    model: config.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema },
    },
    [config.tokenLimitParam ?? "max_tokens"]: config.maxTokens,
    ...(config.reasoningEffort
      ? { reasoning: { effort: config.reasoningEffort, exclude: true } }
      : {}),
    provider: config.provider,
    stream: false,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new InferenceError("aborted", "Cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new InferenceError("aborted", "Cancelled."));
      },
      { once: true },
    );
  });
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function readUsage(body: unknown): { usage: Usage; billedUsd: number | null } {
  const raw = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!raw) return { usage: ZERO_USAGE, billedUsd: null };
  const completionDetails = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    usage: {
      inputTokens: number(raw.prompt_tokens),
      outputTokens: number(raw.completion_tokens),
      reasoningTokens: number(completionDetails?.reasoning_tokens),
      cachedTokens: number(promptDetails?.cached_tokens),
    },
    billedUsd: typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null,
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * A description of broken output that never includes its text: length, the
 * kind of character it starts and ends with, whether one JSON object can be
 * cut out of it, and the finish reason. Enough to tell truncation, stray text
 * around the JSON, or two objects in a row apart.
 */
export function describeShape(content: string, finishReason: unknown): string {
  const kind = (ch: string | undefined) =>
    ch === undefined
      ? "nothing"
      : /[{}[\]`"]/.test(ch)
        ? `"${ch}"`
        : /[A-Za-z]/.test(ch)
          ? "a letter"
          : /\d/.test(ch)
            ? "a digit"
            : "a symbol";
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  let inner = "no object inside";
  if (first >= 0 && last > first) {
    try {
      JSON.parse(content.slice(first, last + 1));
      inner = "one object can be cut out";
    } catch {
      inner = "no single object can be cut out";
    }
  }
  const reason = typeof finishReason === "string" ? finishReason.slice(0, 20) : "unknown";
  return `${content.length} characters, starts with ${kind(content[0])}, ends with ${kind(content.at(-1))}, ${inner}, finish ${reason}`;
}

type AttemptResult<T> = {
  value?: T;
  error?: InferenceError;
  usage: Usage;
  billedUsd: number | null;
  meta: { generationId: string | null; provider: string | null; servedModel: string | null };
};

async function attempt<T>(
  request: JsonRequest<T>,
  config: ModelConfig,
  options: CallOptions,
): Promise<AttemptResult<T>> {
  const empty = {
    usage: ZERO_USAGE,
    billedUsd: null,
    meta: { generationId: null, provider: null, servedModel: null },
  };
  const fetchImpl = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const failure = (): InferenceError =>
    options.signal?.aborted
      ? new InferenceError("aborted", "Cancelled.")
      : timeout.aborted
        ? new InferenceError("timeout", `No response within ${config.timeoutMs} ms.`, {
            retryable: true,
          })
        : new InferenceError("network", "Could not reach the model API.", { retryable: true });

  let status = 0;
  let text: string;
  let retryAfter: string | null = null;
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(buildRequestBody(request, config)),
      signal,
    });
    status = response.status;
    retryAfter = response.headers.get("retry-after");
    text = await response.text();
  } catch {
    return { ...empty, error: failure() };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const error =
      status >= 200 && status < 300
        ? new InferenceError("malformed-response", "Response body was not JSON.", {
            retryable: true,
            status,
          })
        : classifyError(status, null, retryAfter);
    return { ...empty, error };
  }
  if (status < 200 || status >= 300)
    return { ...empty, error: classifyError(status, body, retryAfter) };

  const { usage, billedUsd } = readUsage(body);
  const record = body as {
    id?: unknown;
    provider?: unknown;
    model?: unknown;
    error?: { code?: unknown };
    choices?: Array<{
      finish_reason?: unknown;
      message?: { content?: unknown; refusal?: unknown };
      error?: unknown;
    }>;
  };
  const meta = {
    generationId: typeof record.id === "string" ? record.id : null,
    provider: typeof record.provider === "string" ? record.provider : null,
    servedModel: typeof record.model === "string" ? record.model : null,
  };
  const done = (error: InferenceError): AttemptResult<T> => ({ usage, billedUsd, meta, error });

  if (record.error) {
    const code = typeof record.error.code === "number" ? record.error.code : 502;
    return done(classifyError(code, body, retryAfter));
  }
  const choice = record.choices?.[0];
  if (!choice)
    return done(
      new InferenceError("malformed-response", "Response had no choices.", { retryable: true }),
    );
  if (choice.finish_reason === "error" || choice.error) {
    return done(
      new InferenceError("provider", "Provider stopped with an error.", { retryable: true }),
    );
  }
  if (choice.message?.refusal)
    return done(new InferenceError("refusal", "The model refused the request."));
  if (choice.finish_reason === "content_filter") {
    // The provider's own filter withheld the answer. Retrying the same input does not help.
    return done(
      new InferenceError("content-policy", "The provider's content filter withheld the answer."),
    );
  }
  if (choice.finish_reason === "length") {
    return done(
      new InferenceError(
        "truncated",
        `Output hit the ${config.maxTokens}-token limit before finishing.`,
      ),
    );
  }
  const content = textContent(choice.message?.content).trim();
  if (!content)
    return done(
      new InferenceError("empty-completion", "The model returned no content.", { retryable: true }),
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return done(
      new InferenceError(
        "malformed-json",
        `Completion was not valid JSON (${describeShape(content, choice.finish_reason)}).`,
        { retryable: true },
      ),
    );
  }
  try {
    return { usage, billedUsd, meta, value: request.parse(parsed) };
  } catch (error) {
    // Only the path and the issue code are reported, never the offending value.
    const issue = (error as { issues?: Array<{ path?: unknown[]; code?: unknown }> }).issues?.[0];
    const where = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    const code = typeof issue?.code === "string" ? ` (${issue.code})` : "";
    return done(
      new InferenceError("schema-invalid", `Completion did not match the schema${where}${code}.`, {
        retryable: true,
      }),
    );
  }
}

/** Calls the model until it returns valid JSON, a limit is hit, or an error cannot be retried. */
export async function completeJson<T>(
  request: JsonRequest<T>,
  config: ModelConfig,
  options: CallOptions = {},
): Promise<JsonCompletion<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const reservation = worstCaseUsd(request, config);
  let spend: Spend = { usage: ZERO_USAGE, billedUsd: null, estimatedUsd: 0, attempts: 0 };
  const started = Date.now();
  const fail = (error: InferenceError): never => {
    error.spend = spend;
    throw error;
  };

  for (let n = 1; n <= config.maxAttempts; n++) {
    if (options.signal?.aborted) fail(new InferenceError("aborted", "Cancelled."));
    let ticket: { amount: number } | undefined;
    try {
      ticket = options.guard?.reserve(reservation);
    } catch (error) {
      fail(error as InferenceError);
    }

    const result = await attempt(request, config, options);
    const estimatedUsd =
      result.usage.inputTokens * config.pricing.inputPerToken +
      result.usage.outputTokens * config.pricing.outputPerToken;
    spend = {
      usage: addUsage(spend.usage, result.usage),
      billedUsd:
        result.billedUsd === null ? spend.billedUsd : (spend.billedUsd ?? 0) + result.billedUsd,
      estimatedUsd: spend.estimatedUsd + estimatedUsd,
      attempts: n,
    };
    if (ticket) options.guard?.settle(ticket, result.billedUsd ?? estimatedUsd);

    if (result.value !== undefined && !result.error) {
      return { value: result.value, spend, ...result.meta, latencyMs: Date.now() - started };
    }
    const error = result.error ?? new InferenceError("malformed-response", "Unknown failure.");
    options.onAttemptError?.(error, n);
    if (!error.retryable || n === config.maxAttempts) {
      if (error.retryable) error.message = `Gave up after ${n} attempts. ${error.message}`;
      fail(error);
    }
    const backoff = Math.min(30_000, 1_000 * 2 ** (n - 1)) * (0.5 + 0.5 * random());
    const wait = error.retryAfterMs ?? backoff;
    if (wait > MAX_RETRY_WAIT_MS) fail(error);
    await sleep(wait, options.signal).catch((cancel: unknown) => fail(cancel as InferenceError));
  }
  return fail(new InferenceError("config", "maxAttempts must be at least 1."));
}
