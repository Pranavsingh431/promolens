import { InferenceError } from "./errors.ts";
import type { Pricing, TokenLimitParam } from "./openrouter.ts";

/**
 * Privacy-first provider routing for confidential screenplays.
 *
 * "strict-zdr" (default): only endpoints on OpenRouter's zero-data-retention
 * list whose safety_retention flag is false. Endpoints that may keep flagged
 * prompts for abuse review (Google Safety Retention) are excluded, whatever
 * the account settings say.
 *
 * "allow-safety-retention": also allows those endpoints. It must be chosen
 * explicitly and is recorded in every run manifest.
 *
 * In both modes: data_collection is "deny", every request parameter must be
 * supported (require_parameters), and routing is limited to the listed
 * endpoints with structured-output support. If none exist the run stops with
 * a clear error instead of loosening the rules.
 */

export const PRIVACY_MODES = ["strict-zdr", "allow-safety-retention"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export type RoutingPlan = {
  model: string;
  privacy: PrivacyMode;
  endpoints: Array<{ tag: string; provider: string; safetyRetention: boolean }>;
  provider: Record<string, unknown>;
  pricing: Pricing;
  /** The output limit parameter every allowed endpoint lists. */
  tokenLimitParam: TokenLimitParam;
  checkedAt: string;
};

type ZdrEndpoint = {
  model_id?: unknown;
  tag?: unknown;
  provider_name?: unknown;
  status?: unknown;
  safety_retention?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; internal_reasoning?: unknown };
};

const price = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export async function planRouting(
  model: string,
  privacy: PrivacyMode,
  options: { baseUrl: string; fetch?: typeof fetch; now?: () => Date },
): Promise<RoutingPlan> {
  const fetchImpl = options.fetch ?? fetch;
  let listing: { data?: ZdrEndpoint[] };
  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/endpoints/zdr`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    listing = (await response.json()) as { data?: ZdrEndpoint[] };
  } catch {
    throw new InferenceError("network", "Could not load the zero-data-retention endpoint list.", {
      retryable: true,
    });
  }

  const forModel = (listing.data ?? []).filter((e) => {
    const params = Array.isArray(e.supported_parameters) ? e.supported_parameters : [];
    return (
      e.model_id === model &&
      typeof e.tag === "string" &&
      params.includes("structured_outputs") &&
      params.includes("response_format") &&
      (typeof e.status !== "number" || e.status >= 0)
    );
  });
  const allowed = forModel.filter(
    (e) => privacy === "allow-safety-retention" || e.safety_retention === false,
  );

  if (allowed.length === 0) {
    const onlySafety = forModel.length > 0 && privacy === "strict-zdr";
    throw new InferenceError(
      "no-provider",
      onlySafety
        ? `${model} is only available on endpoints with safety retention, which is not strict zero data retention. Choose another model, or pass --allow-safety-retention to accept safety retention explicitly.`
        : `No zero-data-retention endpoint with structured outputs serves ${model}.`,
    );
  }

  const tags = [...new Set(allowed.map((e) => String(e.tag)))].sort();
  const lists = (name: string) =>
    allowed.every(
      (e) => Array.isArray(e.supported_parameters) && e.supported_parameters.includes(name),
    );
  const tokenLimitParam: TokenLimitParam =
    !lists("max_tokens") && lists("max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
  return {
    model,
    privacy,
    endpoints: allowed
      .map((e) => ({
        tag: String(e.tag),
        provider: String(e.provider_name ?? ""),
        safetyRetention: e.safety_retention === true,
      }))
      .sort((a, b) => (a.tag < b.tag ? -1 : 1)),
    provider: {
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      only: tags,
      allow_fallbacks: true,
    },
    pricing: {
      inputPerToken: Math.max(...allowed.map((e) => price(e.pricing?.prompt))),
      outputPerToken: Math.max(
        ...allowed.map((e) =>
          Math.max(price(e.pricing?.completion), price(e.pricing?.internal_reasoning)),
        ),
      ),
    },
    tokenLimitParam,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}
