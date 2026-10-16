import { test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../src/config.js";
import { MemoryService, executeMemory } from "../src/memory.js";
import { safeError } from "../src/privacy.js";
import { api, temp } from "./helpers.js";

test("official SDK uses v5 routes, scope filters, and private-safe uploads/searches", async (t) => {
  const mock = await api(t);
  const service = new MemoryService(configSchema.parse({ apiKey: "test-key", baseUrl: mock.url }), await temp(t));
  const added = await executeMemory(service, { mode: "add", content: "Use npm <private>password</private>", scope: "user", type: "preference" });
  assert.equal((added as { status: string }).status, "queued");
  await service.search("npm <private>password</private>", "user");
  await service.list("project");
  const profile = await service.profile();
  assert.deepEqual(profile.profile.static, ["Prefers concise answers"]);
  assert.equal(mock.requests[0]!.path, `/ns/${service.identity.tag}/document`);
  assert.equal(mock.requests[0]!.headers.authorization, "Bearer test-key");
  assert.equal(mock.requests[0]!.body.content, "Use npm");
  assert.deepEqual(mock.requests[0]!.body.metadata, { sm_scope: "personal", type: "preference", source: "antigravity" });
  assert.equal(mock.requests[1]!.body.query, "npm");
  assert.deepEqual(mock.requests[1]!.body.filter, { field: "sm_scope", operator: "eq", value: "personal" });
  assert.deepEqual(mock.requests[2]!.body.filter, { field: "sm_scope", operator: "eq", value: "project" });
  await assert.rejects(service.add("<private>secret</private>"), /Nothing to save/);
  await assert.rejects(executeMemory(service, { mode: "search" }), /requires query/);
  assert.equal(mock.requests.length, 4);
});

test("forget checks exact namespace and scope before changing memory", async (t) => {
  const mock = await api(t);
  const service = new MemoryService(configSchema.parse({ apiKey: "test-key", baseUrl: mock.url }), await temp(t));
  await assert.rejects(service.forget("mem_1", "user"), /does not belong/);
  assert.equal(mock.requests.some((r) => r.method === "DELETE"), false);
  assert.equal((await service.forget("mem_1", "project")).forgotten, true);
  assert.deepEqual(mock.requests.at(-1)!.body, { ids: ["mem_1"] });
});

test("failed API operations do not fall back to another endpoint or expose response secrets", async (t) => {
  const mock = await api(t, (_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ message: "request contained secret-value" }));
    return true;
  });
  const service = new MemoryService(configSchema.parse({ apiKey: "test-key", baseUrl: mock.url }), await temp(t));
  await assert.rejects(service.search("query"), (error: unknown) => {
    assert.match(safeError(error), /authentication/);
    assert.doesNotMatch(safeError(error), /secret-value/);
    return true;
  });
  assert.equal(mock.requests.length, 1);
});
