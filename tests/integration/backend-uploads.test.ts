import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_ARCHIVE_BYTES } from "../../src/domain/screenplay/limits";
import { rateLimits, shows, uploads } from "../../src/server/db/schema";
import { memoryStore, localFileStore, assertSafeKey } from "../../src/server/storage";
import { call, createHarness, type Harness } from "../support/backend-harness";
import { createUpload, routes, signIn, uploadShow, uploadZip } from "../support/backend-api";
import { NIGHT_FERRY } from "../support/fixtures";
import { buildUnseenShowZip, unseenShowEntries } from "../support/unseen-show";
import { buildZip } from "../support/zip-builder";

let h: Harness;
let cookie: string;
beforeAll(async () => {
  h = await createHarness();
  cookie = await signIn("alice");
});
afterAll(() => h.close());
// Each test here makes several uploads, and the limits are tested on their own elsewhere.
beforeEach(async () => {
  await h.db.delete(rateLimits);
});

const objects = () => [...(h.storage as ReturnType<typeof memoryStore>).objects.keys()];
const ferry = () => buildZip(NIGHT_FERRY.map(({ name, text }) => ({ name, data: text })));

describe("starting an upload", () => {
  it("makes a private key from server ids, whatever the file is called", async () => {
    const response = await createUpload(cookie, "../../public/evil name.zip", 100);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.transport).toBe("server");
    expect(body.pathname).toMatch(/^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/source\.zip$/);
    expect(body.pathname).not.toContain("evil");
    expect(JSON.stringify(body)).not.toMatch(/https?:/);
  });

  it("keeps a safe display name", async () => {
    const response = await createUpload(cookie, "a\\b/../My Show (Final).zip", 100);
    const { uploadId } = await response.json();
    const rows = await h.db.select().from(uploads);
    expect(rows.find((row) => row.id === uploadId)?.fileName).toBe("My Show (Final).zip");
  });

  it("refuses a file that is not a ZIP by name", async () => {
    const response = await createUpload(cookie, "show.exe", 100);
    expect(response.status).toBe(415);
  });

  it("refuses a declared size over the limit, and bad input", async () => {
    expect((await createUpload(cookie, "show.zip", MAX_ARCHIVE_BYTES + 1)).status).toBe(413);
    expect((await createUpload(cookie, "show.zip", 0)).status).toBe(400);
    expect((await createUpload(cookie, "", 10)).status).toBe(400);
  });

  it("refuses an oversized JSON body before parsing it", async () => {
    const response = await call(routes.postUploads, "/api/uploads", {
      method: "POST",
      cookie,
      json: { fileName: "a".repeat(20_000), sizeBytes: 1 },
    });
    expect(response.status).toBe(413);
  });
});

describe("sending the file", () => {
  it("stops reading at the limit, even if the declared size lied", async () => {
    const created = await createUpload(cookie, "show.zip", 10);
    const { uploadId, pathname } = await created.json();
    const tooBig = new Uint8Array(MAX_ARCHIVE_BYTES + 1);
    const response = await call(
      routes.putContent,
      "/x",
      { method: "PUT", cookie, body: tooBig as BodyInit },
      { id: uploadId },
    );
    expect(response.status).toBe(413);
    expect(objects()).not.toContain(pathname);
  });

  it("will not take content for an upload that is someone else's", async () => {
    const created = await createUpload(cookie, "show.zip", 10);
    const { uploadId } = await created.json();
    const bob = await signIn("bob");
    const response = await call(
      routes.putContent,
      "/x",
      { method: "PUT", cookie: bob, body: "x" },
      { id: uploadId },
    );
    expect(response.status).toBe(404);
  });

  it("refuses an expired upload", async () => {
    const created = await createUpload(cookie, "show.zip", 10);
    const { uploadId } = await created.json();
    await h.db.update(uploads).set({ expiresAt: new Date(0) });
    const response = await call(
      routes.putContent,
      "/x",
      { method: "PUT", cookie, body: "x" },
      { id: uploadId },
    );
    expect(response.status).toBe(404);
  });

  it("answers 409 when asked to complete before the file arrived", async () => {
    const created = await createUpload(cookie, "show.zip", 10);
    const { uploadId } = await created.json();
    const response = await call(
      routes.postComplete,
      "/x",
      { method: "POST", cookie },
      { id: uploadId },
    );
    expect(response.status).toBe(409);
  });

  it("accepts a file of exactly 25 MB through the capped server path", async () => {
    const padding = new Uint8Array(MAX_ARCHIVE_BYTES).map((_, i) => (i * 7919 + (i >> 8)) & 255);
    const script = unseenShowEntries(3, "full-size-show");
    let zip = buildZip([...script, { name: "extras/padding.bin", data: padding, method: "store" }]);
    if (zip.length > MAX_ARCHIVE_BYTES) {
      const excess = zip.length - MAX_ARCHIVE_BYTES;
      zip = buildZip([
        ...script,
        { name: "extras/padding.bin", data: padding.subarray(excess), method: "store" },
      ]);
    }
    expect(zip.length).toBe(MAX_ARCHIVE_BYTES);
    const started = performance.now();
    const { complete } = await uploadZip(cookie, zip, "full-size.zip");
    expect(complete?.status).toBe(200);
    const body = await complete?.json();
    expect(body.episodes).toBe(3);
    // The measurement is reported in the Phase 6 verification notes.
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("completing an upload runs every archive check on the server", () => {
  const rejected = async (zip: Uint8Array) => {
    const before = objects().length;
    const { complete } = await uploadZip(cookie, zip);
    expect(complete).not.toBeNull();
    const body = await complete?.json();
    // A refused file is deleted right away.
    expect(objects().length).toBe(before);
    return { status: complete?.status, code: body.error.code as string };
  };

  it("refuses bytes that are not a ZIP", async () => {
    expect(await rejected(new TextEncoder().encode("not a zip"))).toEqual({
      status: 422,
      code: "invalid-archive",
    });
  });

  it("refuses path traversal", async () => {
    const zip = buildZip([{ name: "../../evil/episode-1.txt", data: NIGHT_FERRY[0]?.text ?? "" }]);
    expect(await rejected(zip)).toEqual({ status: 422, code: "invalid-archive" });
  });

  it("refuses a symbolic link", async () => {
    const zip = buildZip([{ name: "episode-1.txt", data: "/etc/passwd", symlink: true }]);
    expect(await rejected(zip)).toEqual({ status: 422, code: "invalid-archive" });
  });

  it("refuses a decompression bomb by its declared size", async () => {
    const zip = buildZip([
      { name: "episode-1.txt", data: "x".repeat(1000), declaredSize: 4_000_000_000 },
    ]);
    const outcome = await rejected(zip);
    expect(outcome.status).toBe(422);
    expect(["too-large", "invalid-archive"]).toContain(outcome.code);
  });

  it("refuses a real decompression bomb by what actually comes out", async () => {
    const zip = buildZip([
      { name: "episode-1.txt", data: "a".repeat(40 * 1024 * 1024), method: "deflate" },
    ]);
    expect(zip.length).toBeLessThan(MAX_ARCHIVE_BYTES);
    expect(await rejected(zip)).toEqual({ status: 422, code: "too-large" });
  }, 30_000);

  it("refuses a checksum that does not match", async () => {
    const zip = buildZip([{ name: "a.txt", data: NIGHT_FERRY[0]?.text ?? "", crc: 1234 }]);
    expect(await rejected(zip)).toEqual({ status: 422, code: "invalid-archive" });
  });

  it("refuses a ZIP with nothing that looks like a screenplay", async () => {
    const zip = buildZip([{ name: "notes.md", data: "# Just notes" }]);
    expect(await rejected(zip)).toEqual({ status: 422, code: "no-episodes" });
  });

  it("refuses a text file that is not in the screenplay format", async () => {
    const broken = (NIGHT_FERRY[0]?.text ?? "").replace("Start: (00:00.00)", "Start: (soon)");
    const zip = buildZip([{ name: "episode-1.txt", data: broken }]);
    expect(await rejected(zip)).toEqual({ status: 422, code: "unsupported-format" });
  });

  it("never echoes file contents in an error", async () => {
    const secret = "SECRET-LINE-FROM-THE-SCRIPT";
    const zip = buildZip([{ name: "episode-1.txt", data: `EPISODE NUMBER: 1\n${secret}` }]);
    const { complete } = await uploadZip(cookie, zip);
    expect(await complete?.text()).not.toContain(secret);
  });

  it("records a show with a checksum and no screenplay text", async () => {
    const zip = ferry();
    const { showId, episodes, duplicate } = await uploadShow(cookie, zip, "ferry.zip");
    expect(episodes).toBe(3);
    expect(duplicate).toBe(false);
    const rows = await h.db.select().from(shows);
    const row = rows.find((candidate) => candidate.id === showId);
    expect(row?.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("Mara");
  });

  it("finds the same show again and keeps no second copy", async () => {
    const before = objects().length;
    const again = await uploadShow(cookie, ferry(), "another-name.zip");
    expect(again.duplicate).toBe(true);
    expect(objects().length).toBe(before);
  });

  it("finds the same screenplays even when the ZIP was packed differently", async () => {
    const reordered = buildZip(
      [...NIGHT_FERRY].reverse().map(({ name, text }) => ({
        name: `renamed-folder/${name}`,
        data: text,
        method: "store" as const,
      })),
    );
    const before = objects().length;
    const again = await uploadShow(cookie, reordered, "repacked.zip");
    expect(again.duplicate).toBe(true);
    expect(objects().length).toBe(before);
  });

  it("will not complete the same upload twice", async () => {
    const zip = buildUnseenShowZip(2, "twice");
    const { uploadId } = await uploadZip(cookie, zip);
    const response = await call(
      routes.postComplete,
      "/x",
      { method: "POST", cookie },
      { id: uploadId as string },
    );
    expect(response.status).toBe(404);
  });
});

describe("completing an upload when storage misbehaves or requests repeat", () => {
  async function arrived(zip: Uint8Array) {
    const created = await createUpload(cookie, "show.zip", zip.length);
    const { uploadId, pathname } = await created.json();
    await h.storage.put(pathname, zip, "application/zip");
    const complete = () =>
      call(routes.postComplete, "/x", { method: "POST", cookie }, { id: uploadId });
    return { uploadId, pathname, complete };
  }

  it("two completions at once keep the file and record one show", async () => {
    const { pathname, complete } = await arrived(buildUnseenShowZip(2, "double-complete"));
    const before = (await h.db.select().from(shows)).length;
    const replies = await Promise.all([complete(), complete()]);
    // On a real server the slower request may find the upload already finished.
    const statuses = replies.map((reply) => reply.status).sort();
    expect([
      [200, 200],
      [200, 404],
    ]).toContainEqual(statuses);
    const shown = await Promise.all(replies.filter((r) => r.status === 200).map((r) => r.json()));
    expect(new Set(shown.map((body) => body.showId)).size).toBe(1);
    expect(objects()).toContain(pathname);
    expect((await h.db.select().from(shows)).length).toBe(before + 1);
  });

  it("a failed read keeps the file and the upload, and a retry succeeds", async () => {
    const { pathname, complete } = await arrived(buildUnseenShowZip(2, "read-fails-once"));
    const original = h.storage.get;
    h.storage.get = async () => {
      throw new Error("Storage is having a moment");
    };
    const failed = await complete();
    h.storage.get = original;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: {
        code: "storage-unavailable",
        message: "This file could not be checked. Try again.",
      },
    });
    expect(objects()).toContain(pathname);
    expect((await complete()).status).toBe(200);
  });

  it("does not accept a file whose privacy could not be confirmed", async () => {
    const { pathname, complete } = await arrived(buildUnseenShowZip(2, "privacy-unknown"));
    const store = h.storage as { isPubliclyReadable?: (key: string) => Promise<boolean> };
    store.isPubliclyReadable = async () => {
      throw new Error("Could not confirm privacy: status 503.");
    };
    const before = (await h.db.select().from(shows)).length;
    const response = await complete();
    delete store.isPubliclyReadable;
    expect(response.status).toBe(503);
    expect((await h.db.select().from(shows)).length).toBe(before);
    expect(objects()).toContain(pathname);
  });
});

describe("private storage", () => {
  afterEach(() => {
    delete (h.storage as { isPubliclyReadable?: unknown }).isPubliclyReadable;
  });

  it("refuses and deletes a file if the store would serve it to anyone", async () => {
    (h.storage as { isPubliclyReadable?: (key: string) => Promise<boolean> }).isPubliclyReadable =
      async () => true;
    const before = objects().length;
    const { complete } = await uploadZip(cookie, buildUnseenShowZip(2, "exposed"));
    expect(complete?.status).toBe(503);
    const body = await complete?.json();
    expect(body.error.code).toBe("storage-unavailable");
    expect(objects().length).toBe(before);
  });

  it("accepts a file the store keeps private", async () => {
    (h.storage as { isPubliclyReadable?: (key: string) => Promise<boolean> }).isPubliclyReadable =
      async () => false;
    const { complete } = await uploadZip(cookie, buildUnseenShowZip(2, "kept-private"));
    expect(complete?.status).toBe(200);
  });

  it("rejects unsafe object keys", () => {
    for (const key of ["../x", "a/../../b", "/etc/passwd", "a b", ""]) {
      expect(() => assertSafeKey(key)).toThrow();
    }
    expect(() => assertSafeKey("shows/a/b.json")).not.toThrow();
  });

  it("the local store never leaves its folder", async () => {
    const store = localFileStore("/tmp/promolens-store-test");
    await expect(store.get("../secret")).resolves.toBeNull();
    await expect(store.put("../secret", "x", "text/plain")).rejects.toThrow();
  });
});

describe("direct upload to private Blob storage", () => {
  type Presign = {
    body: unknown;
    getSignedToken: (pathname: string, payload: null, multipart: boolean) => Promise<unknown>;
  };

  afterEach(() => {
    vi.doUnmock("@vercel/blob");
    vi.doUnmock("@vercel/blob/client");
    vi.resetModules();
  });

  async function presignRoute() {
    const issued: unknown[] = [];
    vi.doMock("@vercel/blob", async (original) => ({
      ...(await original<typeof import("@vercel/blob")>()),
      issueSignedToken: async (options: unknown) => {
        issued.push(options);
        return { token: "signed" };
      },
    }));
    vi.doMock("@vercel/blob/client", () => ({
      handleUploadPresigned: async (options: Presign) => {
        const { pathname, multipart, clientPayload } = (
          options.body as {
            payload: { pathname: string; multipart: boolean; clientPayload: null };
          }
        ).payload;
        return {
          type: "blob.generate-presigned-url",
          granted: await options.getSignedToken(pathname, clientPayload, multipart),
        };
      },
    }));
    const { POST } = await import("../../src/app/api/uploads/presign/route");
    return { POST, issued };
  }

  const presignBody = (pathname: string) => ({
    type: "blob.generate-presigned-url",
    payload: { pathname, multipart: false, clientPayload: null },
  });

  const asBlobStore = () => {
    (h.storage as { kind: string }).kind = "vercel-blob";
  };
  const asMemoryStore = () => {
    (h.storage as { kind: string }).kind = "memory";
  };

  it("tells the browser to upload directly when storage is Blob", async () => {
    asBlobStore();
    const response = await createUpload(cookie, "show.zip", 1000);
    expect((await response.json()).transport).toBe("direct");
    asMemoryStore();
  });

  it("signs only the editor's own open upload, for one object, with hard limits", async () => {
    asBlobStore();
    const { POST, issued } = await presignRoute();
    const { pathname } = await (await createUpload(cookie, "show.zip", 1000)).json();
    const response = await call(POST, "/api/uploads/presign", {
      method: "POST",
      cookie,
      json: presignBody(pathname),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      pathname,
      operations: ["put"],
      allowedContentTypes: ["application/zip"],
      maximumSizeInBytes: MAX_ARCHIVE_BYTES,
    });
    expect(body.granted.urlOptions).toMatchObject({
      addRandomSuffix: false,
      allowOverwrite: false,
      maximumSizeInBytes: MAX_ARCHIVE_BYTES,
    });
    const { validUntil } = issued[0] as { validUntil: number };
    expect(validUntil).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
    asMemoryStore();
  });

  it("refuses to sign a path the editor did not open, or another editor's", async () => {
    asBlobStore();
    const { POST, issued } = await presignRoute();
    const { pathname } = await (await createUpload(cookie, "show.zip", 1000)).json();
    const bob = await signIn("bob");
    for (const [who, target] of [
      [cookie, "public/anything.zip"],
      [cookie, "shows/x/y/parsed/show.json"],
      [bob, pathname],
    ]) {
      const response = await call(POST, "/api/uploads/presign", {
        method: "POST",
        cookie: who,
        json: presignBody(target),
      });
      expect(response.status).toBe(404);
    }
    expect(issued).toHaveLength(0);
    asMemoryStore();
  });

  it("refuses a multipart upload, whose size the store does not limit", async () => {
    asBlobStore();
    const { POST, issued } = await presignRoute();
    const { pathname } = await (await createUpload(cookie, "show.zip", 1000)).json();
    const response = await call(POST, "/api/uploads/presign", {
      method: "POST",
      cookie,
      json: {
        type: "blob.generate-presigned-url",
        payload: { pathname, multipart: true, clientPayload: null },
      },
    });
    expect(response.status).toBe(400);
    expect(issued).toHaveLength(0);
    asMemoryStore();
  });

  it("refuses the completion webhook shape, which this app does not use", async () => {
    asBlobStore();
    const { POST } = await presignRoute();
    const response = await call(POST, "/api/uploads/presign", {
      method: "POST",
      cookie,
      json: { type: "blob.upload-completed", payload: {} },
    });
    expect(response.status).toBe(400);
    asMemoryStore();
  });

  it("is not offered at all with local storage", async () => {
    const { POST } = await presignRoute();
    (h.storage as { kind: string }).kind = "local";
    const response = await call(POST, "/api/uploads/presign", {
      method: "POST",
      cookie,
      json: presignBody("x"),
    });
    expect(response.status).toBe(404);
    asMemoryStore();
  });
});
