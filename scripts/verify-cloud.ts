import { randomBytes } from "node:crypto";

import { head } from "@vercel/blob";

import { vercelBlobStore } from "../src/server/storage.ts";

/**
 * Checks a real private Blob store, using a small made-up object. Run this once
 * after connecting a store. It needs BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID
 * with Vercel credentials, and it deletes its object afterward.
 */

if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
  console.error("No Blob store is configured, so nothing was checked.");
  process.exit(2);
}

const store = vercelBlobStore();
const key = `verify/${randomBytes(12).toString("hex")}.txt`;
const content = "PromoLens storage check. Not a screenplay.";
let failed = false;

function report(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}

try {
  await store.put(key, content, "text/plain");
  const back = await store.get(key);
  report("reads back with credentials", new TextDecoder().decode(back ?? undefined) === content);
  const { url } = await head(key);
  const anonymous = await fetch(url, { cache: "no-store", redirect: "manual" });
  await anonymous.body?.cancel();
  report(`anonymous read is refused (status ${anonymous.status})`, !anonymous.ok);
  report("the store's own privacy check agrees", !(await store.isPubliclyReadable?.(key)));
} finally {
  await store.delete([key]);
}
const gone = await store.get(key);
report("deletes cleanly", gone === null);
process.exit(failed ? 1 : 0);
