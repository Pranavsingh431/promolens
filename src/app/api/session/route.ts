import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { checkCredentials, createSession, revokeSession } from "@/server/auth";
import {
  RATES,
  assertSameOrigin,
  clearedSessionCookie,
  clientAddress,
  enforceRate,
  errorResponse,
  json,
  readCookie,
  readJson,
  requireBackend,
  sessionCookie,
  sessionCookieName,
} from "@/server/http";

export const runtime = "nodejs";

const signInSchema = z.object({
  name: z.string().trim().toLowerCase().min(1).max(40),
  code: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    const backend = await requireBackend();
    assertSameOrigin(request);
    await enforceRate(backend, clientAddress(request), RATES.signInByAddress);
    const { name, code } = await readJson(request, signInSchema);
    await enforceRate(backend, name, RATES.signInByName);
    const editorName = await checkCredentials(backend.config.editors, name, code);
    if (!editorName) {
      throw new ApiError(401, "unauthorized", "That name and access code do not match.");
    }
    const previous = readCookie(request, sessionCookieName(backend.config));
    const { token, expiresAt } = await createSession(backend.db, editorName, previous);
    return json(
      { editor: editorName },
      { headers: { "set-cookie": sessionCookie(backend.config, token, expiresAt) } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const backend = await requireBackend();
    assertSameOrigin(request);
    const token = readCookie(request, sessionCookieName(backend.config));
    if (token) await revokeSession(backend.db, token);
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": clearedSessionCookie(backend.config),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
