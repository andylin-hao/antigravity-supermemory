import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { install } from "../src/install.js";
import { api, temp } from "./helpers.js";

test("standalone installed runtime: MCP handshake, validation, recall, save, and scoped forget", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  const plugin = await install({ workspace: root });
  const { mcpServers } = JSON.parse(await readFile(join(plugin, "mcp_config.json"), "utf8")) as {
    mcpServers: { supermemory: { command: string; args: string[] } };
  };
  const transport = new StdioClientTransport({
    ...mcpServers.supermemory,
    cwd: root,
    env: { PATH: process.env.PATH!, SUPERMEMORY_API_KEY: "test-key", SUPERMEMORY_API_URL: mock.url, SUPERMEMORY_CONFIG: join(root, "missing.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    try { await client.connect(transport); }
    catch (error) { throw new Error(`Installed runtime failed to connect: ${stderr}`, { cause: error }); }
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["supermemory", "supermemory_context", "supermemory_recall"]);
    assert.equal(tools.tools.find((tool) => tool.name === "supermemory_recall")!.annotations!.readOnlyHint, true);
    const recall = await client.callTool({ name: "supermemory_recall", arguments: { query: "How do I run tests?" } });
    assert.notEqual(recall.isError, true);
    assert.match(JSON.stringify(recall), /Use npm test/);
    assert.match(JSON.stringify(recall), /supermemory recalled 1 memory/);
    const added = await client.callTool({ name: "supermemory", arguments: { mode: "add", content: "Use npm <private>secret</private>" } });
    assert.notEqual(added.isError, true);
    assert.match(JSON.stringify(added), /supermemory saved 1 document \(queued\)/);
    const forgotten = await client.callTool({ name: "supermemory", arguments: { mode: "forget", memoryId: "mem_1" } });
    assert.notEqual(forgotten.isError, true);
    const invalid = await client.callTool({ name: "supermemory", arguments: { mode: "add" } });
    assert.equal(invalid.isError, true);
    const context = await client.callTool({ name: "supermemory_context", arguments: {} });
    assert.match(JSON.stringify(context), /Prefers concise answers/);
    assert.match(JSON.stringify(context), /supermemory recalled 2 memories/);
    assert.doesNotMatch(JSON.stringify(mock.requests), /secret/);
  } finally {
    // Windows locks a running process's cwd. Close it before temp(t)'s earlier
    // after hook removes that directory, including when an assertion fails.
    await client.close();
  }
});

test("hook entry point fails open with valid JSON for malformed input", async (t) => {
  const root = await temp(t);
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "hook", "Stop"], {
    env: { ...process.env, SUPERMEMORY_CONFIG: join(root, "missing.json"), SUPERMEMORY_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((done, reject) => { child.on("close", done); child.on("error", reject); });
  child.stdin.end("{invalid secret-value");
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(stdout), { decision: "" });
  assert.doesNotMatch(stderr, /secret-value/);
});
