import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { and, eq, gt, lt } from "drizzle-orm";

import type { EditorCredential } from "./config.ts";
import type { Database } from "./db/client.ts";
import { editors, sessions } from "./db/schema.ts";

/**
 * Sign-in for a small team. Each editor has a name and an access code whose
 * scrypt hash is in the environment. A session is a random token held in an
 * HttpOnly cookie; only its hash is stored.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 32_768, r: 8, p: 1 };
const KEY_LENGTH = 32;
export const SESSION_HOURS = 12;

export async function hashAccessCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(code, salt, KEY_LENGTH, { ...SCRYPT, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyAccessCode(code: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(code, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

// Compared against when the name is unknown, so timing does not reveal which names exist.
const DECOY = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Returns the editor's name only if both the name and the code are right. */
export async function checkCredentials(
  allowed: readonly EditorCredential[],
  name: string,
  code: string,
): Promise<string | null> {
  const entry = allowed.find((candidate) => candidate.name === name);
  const matches = await verifyAccessCode(code, entry?.codeHash ?? DECOY);
  return entry && matches ? entry.name : null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Database, editorName: string, previousToken?: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.transaction(async (tx) => {
    // A fresh token on every sign-in, and the old one is revoked, which rules out session fixation.
    if (previousToken) {
      await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(previousToken)));
    }
    await tx.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    const [editor] = await tx
      .insert(editors)
      .values({ name: editorName })
      .onConflictDoUpdate({ target: editors.name, set: { name: editorName } })
      .returning();
    if (!editor) throw new Error("Could not record the editor.");
    await tx
      .insert(sessions)
      .values({ tokenHash: hashToken(token), editorId: editor.id, expiresAt });
  });
  return { token, expiresAt };
}

export type Editor = { id: string; name: string };

export async function readSession(db: Database, token: string): Promise<Editor | null> {
  const [row] = await db
    .select({ id: editors.id, name: editors.name })
    .from(sessions)
    .innerJoin(editors, eq(editors.id, sessions.editorId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
