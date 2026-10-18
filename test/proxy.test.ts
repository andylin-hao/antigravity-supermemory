import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../src/install.js";
import { api, temp } from "./helpers.js";

async function proxy(t: TestContext, target: string) {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    requests.push(request.url!);
    if (request.url !== "supermemory.invalid:80") {
      // HTTPS route tests stop at CONNECT; no external DNS or TLS bypass.
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = connect(Number(new URL(target).port), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    track(upstream);
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function run(runtime: string, root: string, environment: NodeJS.ProcessEnv, args = ["status", "--workspace", root], input = "") {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/proxy/i.test(key) || key.startsWith("SUPERMEMORY_") || key === "NODE_OPTIONS") delete env[key];
  Object.assign(env, {
    SUPERMEMORY_CONFIG: join(root, "missing.json"), SUPERMEMORY_API_KEY: "test-key",
    SUPERMEMORY_API_URL: "http://supermemory.invalid", SUPERMEMORY_STATE_DIR: join(root, "state"),
    ...environment,
  });
  // Deliberately omit --use-env-proxy; even older Node 22 must route correctly.
  const child = spawn(process.execPath, [runtime, ...args], { env, windowsHide: true, stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 10000);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

test("standalone CLI and hooks inherit lowercase/uppercase proxies and honor NO_PROXY", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  const tunnel = await proxy(t, mock.url);
  const runtime = join(await install({ workspace: root }), "runtime", "runtime.mjs");
  // Windows environment names are case-insensitive; distinct case variants can
  // only coexist (and have their precedence tested) on POSIX.
  const conflictingCase = process.platform === "win32" ? {} : { HTTP_PROXY: "http://127.0.0.1:1" };
  for (const env of [{ http_proxy: tunnel.url, ...conflictingCase }, { HTTP_PROXY: tunnel.url }]) {
    const result = await run(runtime, root, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).connected, true);
  }
  assert.equal(tunnel.requests.length, 2);
  const transcript = join(root, "transcript.jsonl");
  await writeFile(transcript, '{"role":"user","content":"Use npm"}\n{"role":"assistant","content":"Configured npm"}\n');
  const captured = await run(runtime, root, { http_proxy: tunnel.url }, ["hook", "Stop"], JSON.stringify({ conversationId: "proxy", workspacePaths: [root], transcriptPath: transcript, fullyIdle: true }));
  assert.deepEqual(JSON.parse(captured.stdout), { decision: "" });
  assert.ok(mock.requests.some((request) => request.path.endsWith("/document")));
  const connections = tunnel.requests.length;
  const bypassed = await run(runtime, root, { HTTP_PROXY: tunnel.url, NO_PROXY: "127.0.0.1", SUPERMEMORY_API_URL: mock.url });
  assert.equal(bypassed.code, 0, bypassed.stderr);
  assert.equal(tunnel.requests.length, connections);
});

test("HTTPS chooses https_proxy or falls back to HTTP_PROXY, with no direct fallback", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  const tunnel = await proxy(t, mock.url);
  const runtime = join(await install({ workspace: root }), "runtime", "runtime.mjs");
  const conflictingCase = process.platform === "win32" ? {} : { HTTPS_PROXY: "http://127.0.0.1:1" };
  for (const env of [
    { https_proxy: tunnel.url, ...conflictingCase, http_proxy: "http://127.0.0.1:1" },
    { HTTPS_PROXY: tunnel.url },
    { http_proxy: tunnel.url },
  ]) {
    const result = await run(runtime, root, { ...env, SUPERMEMORY_API_URL: "https://supermemory.invalid" });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /test-key/);
  }
  assert.deepEqual(tunnel.requests, Array(3).fill("supermemory.invalid:443"));
  assert.equal(mock.requests.length, 0);
});
