import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { install, uninstall, shellQuote } from "../src/install.js";
import { configSchema, parseJsonc } from "../src/config.js";
import { temp } from "./helpers.js";

test("native installation is repeatable and uninstall retains unrelated files", async (t) => {
  const root = await temp(t);
  const workspace = join(root, "project with spaces ' quote");
  await mkdir(workspace);
  const target = await install({ workspace });
  const hooks = JSON.parse(await readFile(join(target, "hooks.json"), "utf8")) as { supermemory: { PreInvocation: { command: string; timeout: number }[]; Stop: { timeout: number }[] } };
  assert.ok(hooks.supermemory.PreInvocation[0]!.command.includes(shellQuote(workspace)));
  const longest = configSchema.parse({ recallTimeoutMs: 20000, requestTimeoutMs: 60000 });
  assert.ok(hooks.supermemory.PreInvocation[0]!.timeout * 1000 > longest.recallTimeoutMs);
  assert.ok(hooks.supermemory.Stop[0]!.timeout * 1000 > longest.requestTimeoutMs);
  const mcp = JSON.parse(await readFile(join(target, "mcp_config.json"), "utf8")) as { mcpServers: { supermemory: { args: string[] } } };
  assert.deepEqual(mcp.mcpServers.supermemory.args.slice(-2), ["--workspace", workspace]);
  const runtime = mcp.mcpServers.supermemory.args.find((arg) => arg.endsWith("runtime.mjs"));
  assert.equal(runtime, join(target, "runtime", "runtime.mjs"));
  assert.ok((await readFile(runtime!, "utf8")).length > 0);
  assert.equal(await install({ workspace }), target);
  await writeFile(join(target, "notes.txt"), "user file");
  await uninstall({ workspace });
  assert.equal(await readFile(join(target, "notes.txt"), "utf8"), "user file");
  await assert.rejects(readFile(join(target, "plugin.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(target, "runtime", "runtime.mjs")), { code: "ENOENT" });
});

test("installer and uninstaller preserve locally modified plugin files", async (t) => {
  const workspace = await temp(t);
  const target = await install({ workspace });
  const rule = join(target, "rules", "supermemory.md");
  await writeFile(rule, "user changes");
  await assert.rejects(install({ workspace }), /Preserving modified/);
  await assert.rejects(uninstall({ workspace }), /Preserving modified/);
  assert.equal(await readFile(rule, "utf8"), "user changes");
  assert.ok(await readFile(join(target, "plugin.json")));
});

test("legacy setup merges JSONC and removes only its own server", async (t) => {
  const workspace = await temp(t);
  const mcpConfig = join(workspace, "mcp.jsonc");
  await writeFile(mcpConfig, '{\n // keep my comment\n "mcpServers": {"existing": {"command": "other", "env": {"KEY": "keep"}}},\n "extra": true,\n}\n');
  await install({ workspace, legacy: true, mcpConfig });
  await install({ workspace, legacy: true, mcpConfig });
  const text = await readFile(mcpConfig, "utf8");
  assert.match(text, /keep my comment/);
  assert.equal(Object.keys((parseJsonc(text) as { mcpServers: object }).mcpServers).length, 2);
  await assert.rejects(install({ workspace }), /Uninstall legacy/);
  await uninstall({ workspace, legacy: true });
  const remaining = await readFile(mcpConfig, "utf8");
  assert.match(remaining, /keep my comment/);
  assert.deepEqual(parseJsonc(remaining), { mcpServers: { existing: { command: "other", env: { KEY: "keep" } } }, extra: true });
});

test("global install leaves workspace selection to tools and hook payloads", async (t) => {
  const home = await temp(t);
  const path = await install({ global: true, home });
  assert.equal(path, join(home, ".gemini", "config", "plugins", "supermemory"));
  const mcp = await readFile(join(path, "mcp_config.json"), "utf8");
  assert.doesNotMatch(mcp, /--workspace/);
  await uninstall({ global: true, home });
});
