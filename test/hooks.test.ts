import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema } from "../src/config.js";
import { runHook } from "../src/hooks.js";
import { renderStatusline } from "../src/statusline.js";
import { readActivity } from "../src/activity.js";
import { api, temp } from "./helpers.js";

test("hooks recall once per prompt and capture once per completed turn across invocations", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state") });
  const transcriptPath = join(root, "transcript.jsonl");
  const input = { conversationId: "session", workspacePaths: [root], transcriptPath, fullyIdle: true };
  await writeFile(transcriptPath, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Remember that we use npm <private>secret</private>" }) + "\n");
  const recalled = await runHook("PreInvocation", input, config);
  assert.match(JSON.stringify(recalled), /Prefers concise answers/);
  assert.match(JSON.stringify(recalled), /Use npm test/);
  assert.match(JSON.stringify(recalled), /mode=add/);
  assert.match(JSON.stringify(recalled), /supermemory recalled 2 memories/);
  assert.match(await renderStatusline(config, { conversation_id: "session" }), /recalled 2 memories/);
  assert.doesNotMatch(JSON.stringify(mock.requests), /secret/);
  assert.deepEqual(await runHook("PreInvocation", input, config), {});
  assert.equal(mock.requests.length, 3);
  await appendFile(transcriptPath, JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Done. <private>secret</private>" }) + "\n");
  assert.deepEqual(await runHook("Stop", { ...input, fullyIdle: false }, config), { decision: "" });
  assert.equal(mock.requests.length, 3);
  await runHook("Stop", input, config);
  await runHook("Stop", input, config);
  const uploads = mock.requests.filter((r) => r.path.endsWith("/document"));
  assert.equal(uploads.length, 1);
  assert.match(await renderStatusline(config, { session_id: "session" }), /saved 1 document \(queued\)/);
  const activity = JSON.stringify(await readActivity(config, "session", "recall"));
  assert.doesNotMatch(activity, /Remember|secret|Use npm|Prefers/);
  assert.match(String(uploads[0]!.body.content), /Done/);
  assert.doesNotMatch(String(uploads[0]!.body.content), /secret/);
  const state = await readFile(join(config.stateDir, (await readdir(config.stateDir)).find((name) => name.endsWith(".json"))!), "utf8");
  assert.doesNotMatch(state, /Remember|secret|Done/);
  await appendFile(transcriptPath, JSON.stringify({ step_index: 3, type: "USER_INPUT", content: "How should I run the tests?" }) + "\n");
  await runHook("PreInvocation", input, config);
  assert.equal(mock.requests.filter((r) => r.path.endsWith("/search")).length, 2);
});

test("failed capture is retried with the same document ID; parallel Stop hooks do not duplicate", async (t) => {
  const root = await temp(t);
  let fail = true;
  const mock = await api(t, async (request, response) => {
    if (request.path.endsWith("/document")) {
      await delay(50);
      if (fail) { response.statusCode = 500; response.end('{}'); return true; }
    }
    return false;
  });
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state") });
  const transcriptPath = join(root, "transcript.jsonl");
  await writeFile(transcriptPath, [ { role: "user", content: "Use npm" }, { role: "assistant", content: "Configured npm" } ].map((row) => JSON.stringify(row)).join("\n"));
  const input = { conversationId: "session", workspacePaths: [root], transcriptPath, fullyIdle: true };
  await assert.rejects(runHook("Stop", input, config));
  assert.match(await renderStatusline(config, { conversation_id: "session" }), /save unavailable/);
  fail = false;
  await Promise.all([runHook("Stop", input, config), runHook("Stop", input, config)]);
  await runHook("Stop", input, config);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0]!.body.id, mock.requests[1]!.body.id);
  assert.match(await renderStatusline(config, { conversation_id: "session" }), /saved 1 document/);
});

test("recall timeout is bounded and repeated tool-loop invocations do not retry the same prompt", async (t) => {
  const root = await temp(t);
  const mock = await api(t, () => true);
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state"), recallTimeoutMs: 100 });
  const transcriptPath = join(root, "transcript.jsonl");
  await writeFile(transcriptPath, JSON.stringify({ role: "user", content: "How do we run tests here?" }));
  const input = { conversationId: "session", workspacePaths: [root], transcriptPath };
  const start = Date.now();
  assert.deepEqual(await runHook("PreInvocation", input, config), {});
  const display = await renderStatusline(config, { conversation_id: "session" });
  assert.match(display, /recall unavailable/);
  assert.doesNotMatch(display, /recalled 0/);
  assert.ok(Date.now() - start < 2000);
  const count = mock.requests.length;
  await runHook("PreInvocation", input, config);
  assert.equal(mock.requests.length, count);
});

test("partial recall shows only successfully returned memories", async (t) => {
  const root = await temp(t);
  const mock = await api(t, (request, response) => {
    if (!request.path.endsWith("/profile")) return false;
    response.statusCode = 503;
    response.end('{}');
    return true;
  });
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state") });
  const result = await runHook("PreInvocation", { conversationId: "partial", workspacePaths: [root] }, config);
  assert.match(JSON.stringify(result), /supermemory recalled 1 memory \(partial\)/);
  assert.match(await renderStatusline(config, { conversation_id: "partial" }), /recalled 1 memory \(partial\)/);
});

test("disabled capture and ambiguous workspaces never upload", async (t) => {
  const root = await temp(t);
  const config = configSchema.parse({ apiKey: "test", captureEnabled: false, stateDir: join(root, "state") });
  assert.deepEqual(await runHook("Stop", { conversationId: "a", fullyIdle: true, workspacePaths: [root] }, config), { decision: "" });
  assert.deepEqual(await runHook("PreInvocation", { conversationId: "a", workspacePaths: [root, "/another"] }, config), {});
  assert.deepEqual(await runHook("PreInvocation", { conversationId: "a", workspacePaths: ["/another"] }, config, root), {});
});

test("large Unicode turns resume from acknowledged chunks without private content", async (t) => {
  const root = await temp(t);
  let failSecond = true;
  const mock = await api(t, (request, response) => {
    if (failSecond && String(request.body.id).endsWith("_1")) {
      response.statusCode = 500;
      response.end('{}');
      return true;
    }
    return false;
  });
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state") });
  const transcriptPath = join(root, "transcript.jsonl");
  await writeFile(transcriptPath, [
    { role: "user", content: "Summarize this task" },
    { role: "assistant", content: "🧠".repeat(60000) + "<private>secret</private>" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const input = { conversationId: "session", workspacePaths: [root], transcriptPath, fullyIdle: true };
  await assert.rejects(runHook("Stop", input, config));
  failSecond = false;
  await runHook("Stop", input, config);
  assert.equal(mock.requests.length, 3);
  assert.notEqual(mock.requests[0]!.body.id, mock.requests[1]!.body.id);
  assert.equal(mock.requests[1]!.body.id, mock.requests[2]!.body.id);
  for (const request of mock.requests) {
    const text = String(request.body.content);
    assert.ok(text.length <= 90000);
    assert.doesNotMatch(text, /\p{Surrogate}/u);
    assert.doesNotMatch(text, /secret/);
  }
});
