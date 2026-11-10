import { readSession, type Editor } from "./auth.ts";
import { getBackend } from "./backend.ts";
import { sessionCookieName } from "./session-cookie.ts";

/** What the home page should offer. Anything uncertain lands on a closed door. */
export type Access =
  | { kind: "unconfigured" }
  | { kind: "unavailable" }
  | { kind: "signed-out" }
  | { kind: "editor"; editor: Editor };

export async function resolveAccess(cookie: (name: string) => string | undefined): Promise<Access> {
  try {
    const backend = await getBackend();
    if (!backend) return { kind: "unconfigured" };
    const token = cookie(sessionCookieName(backend.config));
    const editor = token ? await readSession(backend.db, token) : null;
    return editor ? { kind: "editor", editor } : { kind: "signed-out" };
  } catch {
    return { kind: "unavailable" };
  }
}
