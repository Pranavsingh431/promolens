import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the OpenRouter API, for tests. It serves the
 * zero-data-retention endpoint list, the key status, and chat completions,
 * and records every request it receives.
 */

export type MockReply = { status: number; body: unknown; headers?: Record<string, string> };
export type ChatHandler = (
  body: { messages: Array<{ content: string }> } & Record<string, unknown>,
) => MockReply | Promise<MockReply>;

export const ZDR_LISTING = [
  {
    model_id: "anthropic/claude-haiku-5.5",
    tag: "google-vertex/global",
    provider_name: "Google",
    status: 0,
    safety_retention: false,
    supported_parameters: ["structured_outputs", "response_format", "reasoning", "max_tokens"],
    pricing: { prompt: "0.0000001", completion: "0.0000005" },
  },
  {
    model_id: "openai/gpt-6-luna",
    tag: "azure",
    provider_name: "Azure",
    status: 0,
    safety_retention: false,
    supported_parameters: [
      "structured_outputs",
      "response_format",
      "reasoning",
      "max_completion_tokens",
    ],
    pricing: { prompt: "0.00000011", completion: "0.00000055" },
  },
  {
    model_id: "google/safety-only",
    tag: "google-vertex/global",
    provider_name: "Google",
    status: 0,
    safety_retention: true,
    supported_parameters: ["structured_outputs", "response_format"],
    pricing: { prompt: "0.0000003", completion: "0.0000025" },
  },
];

export async function startMockOpenRouter(
  chat: ChatHandler,
  options: { port?: number; control?: (path: string, body: unknown) => MockReply | null } = {},
) {
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    authorization: string | undefined;
  }> = [];
  let handler = chat;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      body,
      authorization: req.headers.authorization,
    });
    let reply: MockReply;
    if (req.url === "/api/v1/endpoints/zdr") reply = { status: 200, body: { data: ZDR_LISTING } };
    else if (req.url === "/api/v1/key")
      reply = { status: 200, body: { data: { usage: 0.25, limit_remaining: null } } };
    else if (req.url === "/api/v1/chat/completions") reply = await handler(body);
    else {
      reply = options.control?.(req.url ?? "", body) ?? {
        status: 404,
        body: { error: { code: 404, message: "Not found" } },
      };
    }
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
    requests,
    chats: () => requests.filter((r) => r.path === "/api/v1/chat/completions"),
    setChat: (next: ChatHandler) => {
      handler = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Wraps a JSON answer in a Chat Completions response with usage and cost. */
export function chatReply(answer: unknown): MockReply {
  return {
    status: 200,
    body: {
      id: "gen-mock",
      provider: "Google",
      model: "anthropic/claude-haiku-5.5",
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } },
      ],
      usage: {
        prompt_tokens: 1_200,
        completion_tokens: 600,
        completion_tokens_details: { reasoning_tokens: 200 },
        cost: 0.00042,
      },
    },
  };
}
