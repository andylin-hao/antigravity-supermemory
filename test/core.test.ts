import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema, loadConfig } from "../src/config.js";
import { hash, normalizeRemote, projectIdentity } from "../src/identity.js";
import { failureReason, redactPrivate, safeError } from "../src/privacy.js";
import { completedTurns, parseTranscript } from "../src/transcript.js";
import { temp } from "./helpers.js";

test("private regions are removed, including nesting and incomplete tags", () => {
  assert.equal(redactPrivate("public <PRIVATE>secret <private>x</private> secret</PRIVATE> public"), "public  public");
  assert.equal(redactPrivate("public <private>secret"), "public");
  assert.equal(redactPrivate("public <private token='x'"), "public");
  assert.equal(redactPrivate("<private>only private</private>"), "");
});

test("failure diagnostics classify nested timeouts without exposing request data", () => {
  const error = new Error("api-key-and-private-content", { cause: new AggregateError([
    Object.assign(new Error("proxy-password"), { code: "ETIMEDOUT" }),
  ]) });
  assert.equal(failureReason(error), "timeout");
  assert.match(safeError(error), /timed out/);
  assert.doesNotMatch(safeError(error), /api-key|private-content|proxy-password/);
  assert.equal(failureReason({ cause: { code: "ECONNREFUSED" } }), "network");
  assert.equal(failureReason({ statusCode: 407 }), "authentication");
});

test("Git identities share across transport, checkout names, and worktrees", async (t) => {
  const path = await temp(t);
  const a = join(path, "first");
  const b = join(path, "second");
  for (const dir of [a, b]) { await mkdir(dir); execFileSync("git", ["init", "-q", dir]); }
  execFileSync("git", ["-C", a, "remote", "add", "origin", "git@github.com:Team/Repo.git"]);
  execFileSync("git", ["-C", b, "remote", "add", "origin", "https://github.com/team/repo.git"]);
  const config = configSchema.parse({});
  const identity = projectIdentity(a, config);
  assert.equal(identity.tag, `repo_repo__${hash("github.com/team/repo").slice(0, 16)}`);
  assert.equal(identity.tag, projectIdentity(b, config).tag);
  assert.equal(normalizeRemote("ssh://git@github.com/Team/Repo.git"), "github.com/team/repo");
  execFileSync("git", ["-C", a, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
  const worktree = join(path, "worktree");
  execFileSync("git", ["-C", a, "worktree", "add", "-q", "-b", "feature", worktree]);
  assert.equal(identity.tag, projectIdentity(worktree, config).tag);
  assert.notEqual(projectIdentity(a, { ...config, isolateWorktrees: true }).tag, projectIdentity(worktree, { ...config, isolateWorktrees: true }).tag);
  execFileSync("git", ["-C", b, "remote", "set-url", "origin", "https://github.com/other/repo.git"]);
  assert.notEqual(identity.tag, projectIdentity(b, config).tag);
});

test("JSONC config accepts comments; environment overrides and invalid fields are checked", async (t) => {
  const path = join(await temp(t), "config.jsonc");
  await writeFile(path, '{ // local config\n "apiKey": "file-key", "recallMode": "off", }');
  const config = await loadConfig({ SUPERMEMORY_CONFIG: path, SUPERMEMORY_API_KEY: "env-key" });
  assert.equal(config.apiKey, "env-key");
  assert.equal(config.recallMode, "off");
  await writeFile(path, '{ "apiKey": "secret-value", "maxMemories": -1 }');
  await assert.rejects(loadConfig({ SUPERMEMORY_CONFIG: path }), (error: Error) => error.message.includes("maxMemories") && !error.message.includes("secret-value"));
  await writeFile(path, '{ "baseUrl": "https://user:secret@example.com" }');
  await assert.rejects(loadConfig({ SUPERMEMORY_CONFIG: path }), /without credentials/);
});

test("transcript parsing excludes tools, reasoning, synthetic context, and malformed rows", () => {
  const rows = [
    { step_index: 1, type: "USER_INPUT", source: "USER_EXPLICIT", content: "Use TypeScript <private>hidden" },
    { type: "EPHEMERAL_MESSAGE", content: "injected memory" },
    { type: "VIEW_FILE", content: "file secret" },
    { type: "PLANNER_RESPONSE", thinking: "private reasoning", content: "still hidden</private> Done" },
    { role: "user", synthetic: true, content: "injected" },
    { type: "USER_INPUT", source: "SYSTEM", content: "injected by hook" },
    { message: { role: "user", synthetic: true, content: "nested injected" } },
    { role: "user", content: "next request" },
  ].map((row) => JSON.stringify(row)).join("\n") + '\n{"unfinished":';
  const messages = parseTranscript(rows);
  assert.equal(messages.length, 3);
  const turns = completedTurns(messages);
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.content, /TypeScript/);
  assert.match(turns[0]!.content, /Done/);
  assert.doesNotMatch(turns[0]!.content, /hidden|reasoning|injected|file secret|next request/);
});
