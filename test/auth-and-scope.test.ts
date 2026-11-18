import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { clearCredentials, getAccessToken, getOAuthConfig, isLoggedOut, loadCredentials, resolveAuth, startAuthFlow } from "../src/auth.js";
import { configSchema, resolveWorkspaceConfig } from "../src/config.js";
import { cachedRecall, cacheRecall, hasOpeningPrompt, rememberOpeningPrompt } from "../src/dedupe.js";
import { dispatchStopHook, runCaptureWorkerJob, runHook } from "../src/hooks.js";
import { install } from "../src/install.js";
import { redactSecrets } from "../src/privacy.js";
import { getSessionSkipReason, isPrintArgv } from "../src/session-scope.js";
import { renderStatusline } from "../src/statusline.js";
import { saveLastSession, writeCaptureNotice } from "../src/state.js";
import { completedTurns, parseTranscript } from "../src/transcript.js";
import { api, temp } from "./helpers.js";

test("OAuth 2.1 DCR + PKCE login, refresh, and logout revoke and clear dedupe caches", async (t) => {
  const root = await temp(t);
  const authDir = join(root, "auth");
  const stateDir = join(root, "state");
  let revoked = false;
  let refreshCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks).toString("utf8");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const issuer = `http://127.0.0.1:${port}/api/auth`;
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        revocation_endpoint: `${issuer}/revoke`,
      }));
      return;
    }
    if (req.url === "/api/auth/register") {
      res.end(JSON.stringify({ client_id: "client_123", token_endpoint_auth_method: "none" }));
      return;
    }
    if (req.url === "/api/auth/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        refreshCount++;
        res.end(JSON.stringify({ access_token: "oauth_refreshed_tok", refresh_token: "refresh_2", token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      assert.ok(params.get("code_verifier"));
      res.end(JSON.stringify({ access_token: "oauth_access_tok", refresh_token: "refresh_1", token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (req.url === "/api/auth/revoke") {
      revoked = true;
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing OAuth server port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const oauthConfig = getOAuthConfig(baseUrl);

  const token = await startAuthFlow(authDir, oauthConfig, {
    port: 0,
    noBrowser: true,
    onAuthorizeUrl: (href) => {
      const authUrl = new URL(href);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;
      void fetch(`${redirectUri}?code=code_ok&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(oauthConfig.issuer)}`);
    },
  });
  assert.equal(token, "oauth_access_tok");
  assert.equal(isLoggedOut(authDir), false);

  const config = configSchema.parse({ baseUrl, authDir, stateDir });
  const resolved = await resolveAuth(config);
  assert.deepEqual(resolved, { token: "oauth_access_tok", source: "oauth" });

  // Force expiry and verify singleflight refresh.
  const stored = loadCredentials(authDir);
  assert.ok(stored && stored.type === "oauth");
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(join(authDir, "credentials.json"), JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }));
  const refreshed = await getAccessToken(authDir, oauthConfig);
  assert.equal(refreshed, "oauth_refreshed_tok");
  assert.equal(refreshCount, 1);

  await rememberOpeningPrompt("scope", "x".repeat(220), stateDir);
  assert.equal(await hasOpeningPrompt("scope", "x".repeat(220), stateDir), true);
  await clearCredentials(authDir, stateDir);
  assert.equal(revoked, true);
  assert.equal(isLoggedOut(authDir), true);
  assert.equal(await hasOpeningPrompt("scope", "x".repeat(220), stateDir), false);
  assert.match(await renderStatusline(config, {}), /signed out/);
});

test("SessionStart and PreInvocation deduplicate facts across turns and never emit systemMessage.metadata", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  const stateDir = join(root, "state");
  const config = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir });
  const service = new (await import("../src/memory.js")).MemoryService(config, root);
  await saveLastSession(stateDir, service.identity.tag, "doc_prev", Date.now() - 8 * 3600 * 1000);
  await writeCaptureNotice(stateDir, service.identity.tag, "Supermemory request timed out.");

  const startOut = await runHook("SessionStart", { conversationId: "s1", workspacePaths: [pathToFileURL(root).href] }, config, undefined, undefined, { platform: "win32" });
  assert.ok("injectSteps" in startOut && startOut.injectSteps?.length === 1);
  for (const step of startOut.injectSteps!) {
    assert.deepEqual(Object.keys(step.systemMessage), ["systemMessage"]);
  }
  const startText = startOut.injectSteps![0]!.systemMessage.systemMessage;
  assert.match(startText, /welcome back/);
  assert.match(startText, /last session save failed/);
  assert.match(startText, /Prefers concise answers/);
  assert.match(startText, /Use npm test/);

  // Subsequent PreInvocation with same memory returned by search skips duplicate facts already seen in SessionStart.
  const preOut = await runHook("PreInvocation", {
    conversationId: "s1",
    workspacePaths: [root],
    lastUserInput: "How should we run tests in this repository?",
    initialNumSteps: 1,
  }, config, undefined, undefined, { platform: "win32" });
  assert.deepEqual(preOut, {});
});

test("session scoping skips subagents, headless print runs, and disabled orchestrators", async (t) => {
  const root = await temp(t);
  const config = configSchema.parse({ apiKey: "test", stateDir: join(root, "state"), captureOrchestrated: false });
  assert.equal(isPrintArgv(["--model", "flash", "-p", "hello"]), true);
  assert.equal(isPrintArgv(["-p", "-i", "hello"]), false);
  assert.equal(getSessionSkipReason({ conversationId: "c1", parentConversationId: "parent" }, config), "subagent");
  assert.equal(getSessionSkipReason({ conversationId: "c2", lastUserInput: "<task-notification>done" }, config), "subagent");
  assert.equal(getSessionSkipReason({ conversationId: "c3" }, config, { env: { CONDUCTOR_SESSION_ID: "1" } }), "orchestrated");
  assert.equal(
    getSessionSkipReason({ conversationId: "c4", lastUserInput: "hi" }, { ...config, captureOrchestrated: true }, {
      env: {},
      platform: "linux",
      inspect: () => ({ ppid: 1, argv: ["/usr/bin/agy", "-p", "check"] }),
    }),
    "headless",
  );
});

test("secret redaction, signal extraction, recall cache, project config, and capture-worker", async (t) => {
  const root = await temp(t);
  const mock = await api(t);
  await mkdir(join(root, ".claude", ".supermemory-claude"), { recursive: true });
  await writeFile(join(root, ".claude", ".supermemory-claude", "config.json"), JSON.stringify({ namespace: "shared_ns" }));
  const base = configSchema.parse({ apiKey: "test", baseUrl: mock.url, stateDir: join(root, "state"), signalExtraction: true });
  const effective = resolveWorkspaceConfig(base, root, {});
  assert.equal(effective.projectContainerTag, "shared_ns");

  const redacted = redactSecrets("OPENAI_API_KEY=sk-proj-1234567890abcdefghij https://user:realpass123@example.com Bearer abcdefghijklmnop1234");
  assert.doesNotMatch(redacted, /sk-proj-|realpass123|abcdefghijklmnop1234/);

  const messages = parseTranscript([
    JSON.stringify({ role: "user", content: "hello" }),
    JSON.stringify({ role: "assistant", content: "hi" }),
    JSON.stringify({ role: "user", content: "architecture decision: use SQLite" }),
    JSON.stringify({ role: "assistant", content: "recorded" }),
  ].join("\n"));
  const turns = completedTurns(messages, { signalExtraction: true, signalKeywords: ["architecture"], signalTurnsBefore: 0, redactSecrets: true });
  assert.equal(turns[0]!.selected, false);
  assert.equal(turns[1]!.selected, true);

  await cacheRecall("scope", "test query", "conv_a", [{ id: "m1", memory: "cached fact" }], base.stateDir);
  assert.equal(await cachedRecall("scope", "test query", "conv_a", base.stateDir), undefined);
  assert.deepEqual(await cachedRecall("scope", "test query", "conv_b", base.stateDir), [{ id: "m1", memory: "cached fact" }]);

  // Verify capture-worker job file execution and cleanup.
  const transcriptPath = join(root, "transcript.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({ role: "user", content: "remember architecture" })}\n${JSON.stringify({ role: "assistant", content: "saved" })}\n`);
  const jobFile = join(root, "job.json");
  await writeFile(jobFile, JSON.stringify({ input: { conversationId: "worker", workspacePaths: [root], transcriptPath, fullyIdle: true }, workspace: root }));
  await runCaptureWorkerJob(jobFile, base, {});
  assert.ok(mock.requests.some((r) => r.path === "/ns/shared_ns/document"));
  await assert.rejects((await import("node:fs/promises")).stat(jobFile), { code: "ENOENT" });
  assert.deepEqual(await dispatchStopHook({ conversationId: "worker", workspacePaths: [root], transcriptPath, fullyIdle: false }, base, root, []), { decision: "" });
});

test("MCP server auto-detects workspace via client roots/list in global mode", async (t) => {
  const root = await temp(t);
  const home = await temp(t);
  const mock = await api(t);
  const plugin = await install({ global: true, home, noStatusline: true });
  const { mcpServers } = JSON.parse(await (await import("node:fs/promises")).readFile(join(plugin, "mcp_config.json"), "utf8")) as {
    mcpServers: { supermemory: { command: string; args: string[] } };
  };
  const transport = new StdioClientTransport({
    ...mcpServers.supermemory,
    cwd: home,
    env: { PATH: process.env.PATH!, SUPERMEMORY_API_KEY: "test-key", SUPERMEMORY_API_URL: mock.url, SUPERMEMORY_CONFIG: join(home, "missing.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "roots-client", version: "1" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(root).href, name: "workspace" }],
  }));
  try {
    await client.connect(transport);
    const recall = await client.callTool({ name: "supermemory_recall", arguments: { query: "npm test" } });
    assert.notEqual(recall.isError, true);
    assert.match(JSON.stringify(recall), /Use npm test/);
  } finally {
    await client.close();
  }
});
