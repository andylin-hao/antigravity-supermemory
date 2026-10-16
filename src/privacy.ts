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

export function safeError(error: unknown): string {
  const status = (error as { statusCode?: number; status?: number } | null)?.statusCode
    ?? (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return "Supermemory authentication failed. Check SUPERMEMORY_API_KEY and namespace access.";
  if (status === 429) return "Supermemory rate limit reached. Try again later.";
  if (status === 404) return "Supermemory resource not found. Check the namespace and API v5 endpoint.";
  if (status) return `Supermemory request failed (HTTP ${status}).`;
  // SDK errors can contain request bodies and credentials; never echo them.
  return "Supermemory operation failed. Check configuration, connectivity, and API v5 support.";
}
