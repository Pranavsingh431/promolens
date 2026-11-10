import type { MockReply } from "../support/mock-openrouter";
import { startMockOpenRouter, type ChatHandler } from "../support/mock-openrouter";
import { answerEveryStage } from "../support/backend-model";
import { MODEL_PORT } from "./env";

/**
 * Stands in for OpenRouter while the real app runs. A spec can switch it into a
 * failing or slow mode, and read how many paid calls the app would have made.
 */

type Mode = "healthy" | "auth-failure" | "hold-evaluation";
let mode: Mode = "healthy";

const unauthorized: MockReply = { status: 401, body: { error: { code: 401, message: "No key" } } };

const chat: ChatHandler = async (body) => {
  if (mode === "auth-failure") return unauthorized;
  // Holds evaluation open, so a test can see the job at a known point.
  const stage = (body.response_format as { json_schema?: { name?: string } } | undefined)
    ?.json_schema?.name;
  while (mode === "hold-evaluation" && stage === "promo_screen") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return answerEveryStage(body);
};

export default async function globalSetup() {
  const mock = await startMockOpenRouter(chat, {
    port: MODEL_PORT,
    control(path, body) {
      if (path === "/__control/mode") {
        mode = (body as { mode: Mode }).mode;
        return { status: 200, body: { mode } };
      }
      if (path === "/__control/stats") {
        const chats = mock.chats();
        return {
          status: 200,
          body: {
            chats: chats.length,
            discovery: chats.filter(
              (r) =>
                (r.body as { response_format?: { json_schema?: { name?: string } } })
                  .response_format?.json_schema?.name === "promo_proposals",
            ).length,
            // Every request must keep the strict privacy routing.
            weakerRouting: chats.filter((r) => {
              const provider = (r.body as { provider?: Record<string, unknown> }).provider;
              return !(provider?.zdr === true && provider.data_collection === "deny");
            }).length,
          },
        };
      }
      return null;
    },
  });
  return () => mock.close();
}
