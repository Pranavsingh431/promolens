import type { BackendConfig } from "./config.ts";

const PLAIN_COOKIE = "promolens-session";
const SECURE_COOKIE = "__Host-promolens-session";

/** Only a local-storage setup, which Vercel refuses, may use a cookie without Secure. */
export const isLocalDeployment = (config: BackendConfig) => config.storage.kind === "local";

export const sessionCookieName = (config: BackendConfig) =>
  isLocalDeployment(config) ? PLAIN_COOKIE : SECURE_COOKIE;
