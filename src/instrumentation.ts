/**
 * Runs once when the server starts. Off Vercel, the workflow engine has to be
 * told to pick up runs that were interrupted by a restart. On Vercel the
 * platform's queue redelivers them, so there is nothing to do.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL || !process.env.DATABASE_URL) {
    return;
  }
  const { getWorld } = await import("workflow/runtime");
  const world = await getWorld();
  await world.start?.();
}
