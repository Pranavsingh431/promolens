import { cookies } from "next/headers";

import { LiveWorkspace, type LiveAccess } from "@/components/workspace/live-workspace";
import { resolveAccess } from "@/server/access";

type HomeProps = { searchParams: Promise<{ job?: string | string[] }> };

const JOB_ID = /^[0-9a-f-]{36}$/i;

/** Decides on the server what this visitor may do, so a closed door is closed from the first byte. */
export default async function HomePage({ searchParams }: HomeProps) {
  const [store, { job }] = await Promise.all([cookies(), searchParams]);
  const access = await resolveAccess((name) => store.get(name)?.value);
  const live: LiveAccess =
    access.kind === "editor" ? { kind: "editor", name: access.editor.name } : access;
  const initialJobId = typeof job === "string" && JOB_ID.test(job) ? job : undefined;
  return <LiveWorkspace access={live} {...(initialJobId ? { initialJobId } : {})} />;
}
