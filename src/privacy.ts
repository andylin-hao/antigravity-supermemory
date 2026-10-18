/** Redact nested, mixed-case, and unterminated private regions before any upload. */
export function redactPrivate(text: string): string {
  const tags = /<\s*(\/?)\s*private\b[^>]*>/gi;
  let depth = 0;
  let cursor = 0;
  let result = "";
  for (const match of text.matchAll(tags)) {
    const start = match.index;
    if (depth === 0) result += text.slice(cursor, start);
    if (match[1]) depth = Math.max(0, depth - 1);
    else depth++;
    cursor = start + match[0].length;
  }
  if (depth === 0) result += text.slice(cursor);
  // A partially typed opening tag also hides everything after it.
  return result.replace(/<\s*private\b[^>]*$/i, "").trim();
}

export const failureReasons = ["timeout", "network", "authentication", "rate limit", "API error", "unknown"] as const;
export type FailureReason = typeof failureReasons[number];

/** Classify only known codes/names; never persist SDK messages or response bodies. */
export function failureReason(error: unknown): FailureReason {
  const pending: unknown[] = [error];
  let reason: FailureReason = "unknown";
  for (let inspected = 0; pending.length && inspected < 12; inspected++) {
    const value = pending.shift();
    if (!value || typeof value !== "object") continue;
    const item = value as { statusCode?: number; status?: number; name?: string; code?: string; cause?: unknown; errors?: unknown[] };
    const status = item.statusCode ?? item.status;
    if (status === 401 || status === 403 || status === 407) return "authentication";
    if (status === 429) return "rate limit";
    if (status === 408 || status === 504 || ["AbortError", "TimeoutError", "SupermemoryTimeoutError"].includes(item.name ?? "") || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(item.code ?? "")) return "timeout";
    if (status) reason = "API error";
    else if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(item.code ?? "")) reason = "network";
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 12));
  }
  return reason;
}

export function safeError(error: unknown): string {
  const status = (error as { statusCode?: number; status?: number } | null)?.statusCode
    ?? (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return "Supermemory authentication failed. Check SUPERMEMORY_API_KEY and namespace access.";
  if (status === 429) return "Supermemory rate limit reached. Try again later.";
  if (status === 404) return "Supermemory resource not found. Check the namespace and API v5 endpoint.";
  if (status) return `Supermemory request failed (HTTP ${status}).`;
  const reason = failureReason(error);
  if (reason === "timeout") return "Supermemory request timed out. Check proxy connectivity or increase recallTimeoutMs/requestTimeoutMs.";
  if (reason === "network") return "Supermemory connection failed. Check the HTTP_PROXY/HTTPS_PROXY and NO_PROXY environment inherited from agy.";
  // SDK errors can contain request bodies and credentials; never echo them.
  return "Supermemory operation failed. Check configuration, connectivity, and API v5 support.";
}
