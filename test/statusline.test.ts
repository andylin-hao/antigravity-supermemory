import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { configSchema, parseJsonc } from "../src/config.js";
import { recordActivity } from "../src/activity.js";
import { renderStatusline, upstreamStatusline } from "../src/statusline.js";
import { install, shellQuote, uninstall } from "../src/install.js";
import { temp } from "./helpers.js";

test("activity is isolated by session and account, with stale and disabled states", async (t) => {
  const root = await temp(t);
  const config = configSchema.parse({ apiKey: "test", stateDir: root });
  await recordActivity(config, "one", "recall", "done", 3);
  assert.match(await renderStatusline(config, { conversation_id: "one" }), /recalled 3 memories/);
  assert.match(await renderStatusline(config, { conversation_id: "two" }), /waiting for recall/);
  assert.match(await renderStatusline({ ...config, apiKey: "other" }, { conversation_id: "one" }), /waiting for recall/);
  assert.match(await renderStatusline({ ...config, apiKey: undefined }, {}), /API key not configured/);
  await recordActivity(config, "one", "recall", "running");
  assert.match(await renderStatusline(config, { session_id: "one" }), /recalling/);
  assert.match(await renderStatusline(config, { session_id: "one" }, Date.now() + 60000), /recall interrupted/);
  assert.match(await renderStatusline({ ...config, recallMode: "off", captureEnabled: false }, {}), /recall off · capture off/);
  // A corrupt or unwritable display store must not break hooks or the terminal.
  const file = join(root, "not-a-directory");
  await writeFile(file, "");
  await recordActivity({ ...config, stateDir: file }, "one", "recall", "done", 1);
  assert.match(await renderStatusline({ ...config, stateDir: file }, {}), /waiting for recall/);
});

test("global install chains the previous status line, updates once, and restores settings", async (t) => {
  const home = await temp(t);
  const path = join(home, ".gemini", "antigravity-cli", "settings.json");
  const script = join(home, "upstream.mjs");
  await writeFile(script, `let input = ''; for await (const chunk of process.stdin) input += chunk; console.log('original ' + JSON.parse(input).conversation_id);`);
  const original = { type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(script)}`, padding: 1, stack_with_default: false };
  await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  await writeFile(path, `// user preferences\n${JSON.stringify({ statusLine: original, unrelated: true })}\n`);
  const plugin = await install({ global: true, home });
  const first = await readFile(path, "utf8");
  await install({ global: true, home });
  assert.equal(await readFile(path, "utf8"), first);
  const settings = parseJsonc(first) as { statusLine: typeof original & { enabled: boolean }; unrelated: boolean };
  assert.equal(settings.statusLine.enabled, true);
  assert.equal(settings.statusLine.stack_with_default, false);
  assert.equal(settings.statusLine.padding, 1);
  assert.match(first, /user preferences/);
  const upstream = join(plugin, "runtime", "statusline-upstream.json");
  assert.equal(await upstreamStatusline(upstream, '{"conversation_id":"demo"}'), "original demo");
  const input = join(home, "input.json");
  await writeFile(input, '{"conversation_id":"demo"}');
  const { stdout } = await promisify(exec)(`${settings.statusLine.command} < ${shellQuote(input)}`, {
    env: { ...process.env, SUPERMEMORY_API_KEY: "test", SUPERMEMORY_CONFIG: join(home, "missing.json"), SUPERMEMORY_STATE_DIR: join(home, "state") },
    timeout: 10000,
  });
  assert.match(stdout, /original demo\r?\n◪ supermemory · ready/);
  await uninstall({ global: true, home });
  assert.deepEqual(parseJsonc(await readFile(path, "utf8")), { statusLine: original, unrelated: true });
});

test("status line opt-out restores absence; later user edits are preserved", async (t) => {
  const home = await temp(t);
  const path = join(home, ".gemini", "antigravity-cli", "settings.json");
  await install({ global: true, home, noStatusline: true });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await install({ global: true, home });
  await install({ global: true, home, noStatusline: true });
  assert.deepEqual(parseJsonc(await readFile(path, "utf8")), {});
  await install({ global: true, home });
  const changed = '{"statusLine":{"type":"command","command":"my-custom-status"}}';
  await writeFile(path, changed);
  await assert.rejects(install({ global: true, home }), /Preserving modified/);
  await assert.rejects(uninstall({ global: true, home }), /Preserving modified/);
  assert.equal(await readFile(path, "utf8"), changed);
});
