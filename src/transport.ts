import { EnvHttpProxyAgent } from "undici";

let dispatcher: EnvHttpProxyAgent | undefined;

/** Scope proxy routing to SDK requests; all CLI/MCP/hook entry points use it. */
export const environmentFetch: typeof globalThis.fetch = (input, init) => {
  // Lowercase variables take precedence. HTTPS falls back to HTTP_PROXY, and
  // NO_PROXY bypasses the proxy. Read the environment inherited from agy at runtime.
  dispatcher ??= new EnvHttpProxyAgent();
  const options = { ...init, dispatcher };
  return globalThis.fetch(input, options);
};
