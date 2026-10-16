import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function temp(t: TestContext) {
  const base = join(tmpdir(), "opencode");
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "agy-supermemory-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export interface Request { method: string; path: string; body: Record<string, unknown>; headers: IncomingMessage["headers"] }
export const memory = { id: "mem_1", memory: "Use npm test", metadata: { sm_scope: "project" }, similarity: 0.9, isLatest: true, isInference: false, isForgotten: false, version: 1, system: {} };
export async function api(t: TestContext, custom?: (request: Request, response: ServerResponse) => boolean | Promise<boolean>) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const raw = Buffer.concat(chunks).toString();
    const request: Request = { method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) as Record<string, unknown> : {}, headers: req.headers };
    requests.push(request);
    res.setHeader("content-type", "application/json");
    if (await custom?.(request, res)) return;
    let result: unknown;
    if (request.path.endsWith("/document")) result = { id: request.body.id ?? "doc_1", status: "queued" };
    else if (request.path.endsWith("/profile")) result = { profile: { static: [{ memory: "Prefers concise answers" }], dynamic: [] } };
    else if (request.path.includes("/list/memories")) result = { memories: [memory], documents: [], chunks: [], pagination: { currentPage: 1, totalItems: 1, totalPages: 1 } };
    else if (request.path.endsWith("/search")) result = { results: [memory], searchTime: 1 };
    else if (request.method === "GET") result = memory;
    else if (request.method === "DELETE") result = { count: 1, matches: [{ id: "mem_1" }], errors: [] };
    else { res.statusCode = 404; result = { error: "Unknown route" }; }
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return { requests, url: `http://127.0.0.1:${address.port}` };
}
