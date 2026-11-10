/**
 * Loaded before every test file. Any fetch to a host other than this machine
 * fails the test, so no test can reach OpenRouter or any other service.
 */
const realFetch = globalThis.fetch;
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (!LOCAL.has(url.hostname)) {
    throw new Error(`Unexpected network request to ${url.host} during tests`);
  }
  return realFetch(input, init);
}) as typeof fetch;
