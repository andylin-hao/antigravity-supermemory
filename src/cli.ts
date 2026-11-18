#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { AUTH_WAIT_MS, clearCredentials, fetchSessionAccount, getOAuthConfig, HOOK_AUTH_WAIT_MS, resolveAuth, settleAuth, startAuthFlow, startBackgroundAuth } from "./auth.js";
import { configPath, hookTimeoutSeconds, loadConfig, PLUGIN_VERSION, resolveAuthDir, resolveWorkspaceConfig } from "./config.js";
import { dispatchStopHook, emptyOutput, runCaptureWorkerJob, runHook, type HookEvent } from "./hooks.js";
import { install, uninstall } from "./install.js";
import { InputError, MemoryService } from "./memory.js";
import { safeError } from "./privacy.js";
import { serve } from "./server.js";
import { renderStatusline, upstreamStatusline } from "./statusline.js";

const help = `antigravity-supermemory v${PLUGIN_VERSION}

  install [--workspace PATH | --global]   Install native hooks, MCP, rule, subagent, and skills
  install --legacy --workspace PATH      Install MCP + rule + workflow for older IDEs
  uninstall [same installation flags]    Remove unmodified managed files
  login [--workspace PATH]               Sign in to Supermemory via browser OAuth (PKCE)
  logout                                 Sign out, revoke OAuth token, and clear local caches
  serve [--workspace PATH]               Start the stdio MCP server
  status [--workspace PATH] [--account]  Check configuration, auth, and API connectivity
  statusline                             Render agy CLI activity from JSON stdin
  config-path                            Print the global JSONC configuration path
  version                                Print the plugin version
  hook SessionStart|PreInvocation|Stop [--workspace PATH]  Handle Antigravity JSON stdin

Legacy mode accepts --mcp-config PATH (use Antigravity's View raw config path).
Global installs enable the CLI status line; pass --no-statusline to opt out.
Sign in with \`antigravity-supermemory login\` (or /supermemory-login), or set SUPERMEMORY_API_KEY.
`;

function selfEntryArgs(): string[] {
  const script = resolve(process.argv[1]!);
  return script.endsWith(".ts") ? ["--import", "tsx", script] : [script];
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Hook input is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      cwd: { type: "string" },
      global: { type: "boolean" },
      legacy: { type: "boolean" },
      "mcp-config": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "no-statusline": { type: "boolean" },
      upstream: { type: "string" },
      "print-url": { type: "boolean" },
      "no-browser": { type: "boolean" },
      background: { type: "boolean" },
      account: { type: "boolean" },
    },
  });
  const [command, arg1, arg2, arg3] = positionals;
  const rawWorkspace = values.workspace ?? values.cwd;
  const workspace = rawWorkspace ? resolve(rawWorkspace) : undefined;
  if (values.version || command === "version") {
    console.log(PLUGIN_VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (command === "statusline") {
    let display = "◪ supermemory · configuration unavailable";
    let previous = "";
    try {
      const input = await stdin();
      previous = await upstreamStatusline(values.upstream, input);
      display = await renderStatusline(await loadConfig(), JSON.parse(input), Date.now(), process.env);
    } catch { /* Keep status-line failures out of the interactive terminal. */ }
    console.log([previous, display].filter(Boolean).join("\n"));
    return;
  }
  if (command === "auth-server") {
    if (!arg1 || !arg2) throw new Error("auth-server requires apiBaseUrl and resource");
    const config = await loadConfig();
    const oauthConfig = getOAuthConfig(arg1, arg2, arg3);
    await startAuthFlow(resolveAuthDir(config), oauthConfig, { force: true, background: true });
    return;
  }
  if (command === "capture-worker") {
    if (!arg1) throw new Error("capture-worker requires jobFile");
    await runCaptureWorkerJob(resolve(arg1), await loadConfig(), process.env);
    return;
  }
  if (command === "login") {
    const baseConfig = await loadConfig();
    const effective = resolveWorkspaceConfig(baseConfig, workspace ?? process.cwd(), process.env);
    const authDir = resolveAuthDir(effective);
    const oauthConfig = getOAuthConfig(effective.baseUrl, effective.mcpUrl, effective.oauthIssuer, process.env);
    if (values["print-url"] || values["no-browser"] || process.env.SUPERMEMORY_NO_BROWSER === "true") {
      await startAuthFlow(authDir, oauthConfig, {
        force: true,
        printUrl: Boolean(values["print-url"]),
        noBrowser: Boolean(values["no-browser"]),
      });
      console.log("Supermemory connected.");
      return;
    }
    if (!process.stdout.isTTY || values.background) {
      try {
        await startBackgroundAuth(authDir, oauthConfig, selfEntryArgs(), HOOK_AUTH_WAIT_MS, process.env);
        console.log("Supermemory connected. Memory is active from the next message.");
      } catch (error) {
        if ((error as Error).message !== "AUTH_PENDING") throw error;
        console.log(`A browser window opened for Supermemory sign-in. Finish it within ${AUTH_WAIT_MS / 60000} minutes; memory turns on from the next message.`);
      }
      return;
    }
    console.log("Opening browser for Supermemory authentication…");
    await startAuthFlow(authDir, oauthConfig, { force: true });
    console.log("Supermemory connected.");
    return;
  }
  if (command === "logout") {
    const config = await loadConfig();
    await clearCredentials(resolveAuthDir(config), config.stateDir);
    console.log("Supermemory signed out. New conversations will not load or save memory until you run /supermemory-login.");
    return;
  }
  if (command === "hook") {
    if (arg1 !== "SessionStart" && arg1 !== "PreInvocation" && arg1 !== "Stop") {
      throw new Error("Unknown hook event");
    }
    const event = arg1 as HookEvent;
    const fallback = emptyOutput(event);
    // Always emit valid hook JSON before Antigravity's outer timeout expires.
    const timer = setTimeout(() => {
      console.error("[supermemory] Hook timed out; continuing without memory.");
      process.stdout.write(JSON.stringify(fallback) + "\n", () => process.exit(0));
    }, hookTimeoutSeconds[event] * 1000 - 2000);
    try {
      const input = JSON.parse(await stdin());
      const config = await loadConfig();
      const output = event === "Stop"
        ? await dispatchStopHook(input, config, workspace, selfEntryArgs(), { env: process.env })
        : await runHook(event, input, config, workspace, undefined, { env: process.env, cliEntryArgs: selfEntryArgs() });
      console.log(JSON.stringify(output));
    } catch (error) {
      console.error(`[supermemory] ${safeError(error)}`);
      console.log(JSON.stringify(fallback));
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  if (command === "install" || command === "uninstall") {
    const path = await (command === "install" ? install : uninstall)({
      workspace,
      global: values.global,
      legacy: values.legacy,
      mcpConfig: values["mcp-config"],
      noStatusline: values["no-statusline"],
    });
    console.log(`${command === "install" ? "Installed in" : "Removed managed files from"} ${path}`);
    console.log("Reload Antigravity's customizations/MCP servers or restart the application.");
    return;
  }
  if (command === "config-path") {
    console.log(configPath());
    return;
  }
  if (command === "serve") {
    await serve(await loadConfig(), workspace);
    return;
  }
  if (command === "status") {
    const baseConfig = await loadConfig();
    const targetWorkspace = workspace ?? process.cwd();
    const config = resolveWorkspaceConfig(baseConfig, targetWorkspace, process.env);
    const auth = await resolveAuth(config, { env: process.env, timeoutMs: 8000 });
    const service = new MemoryService(config, targetWorkspace, auth?.token);
    const profile = await service.profile();
    const account = auth && (auth.source === "oauth" || values.account)
      ? await fetchSessionAccount(config.baseUrl, auth.token)
      : undefined;
    console.log(JSON.stringify({
      version: PLUGIN_VERSION,
      connected: true,
      authSource: auth?.source ?? "none",
      ...(account ? { account } : {}),
      namespace: service.identity.tag,
      workspace: service.identity.root,
      recallMode: config.recallMode,
      captureEnabled: config.captureEnabled,
      captureSubagents: config.captureSubagents,
      captureHeadless: config.captureHeadless,
      captureOrchestrated: config.captureOrchestrated,
      dedupeOpeningPrompt: config.dedupeOpeningPrompt,
      dedupeRecallQueries: config.dedupeRecallQueries,
      profileFacts: profile.profile.static.length + profile.profile.dynamic.length,
    }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  // Config/installer errors are local diagnostics; API response bodies stay hidden.
  const message = error instanceof InputError || (error instanceof Error && !("statusCode" in error) && !error.constructor.name.startsWith("Supermemory"))
    ? error.message
    : safeError(error);
  console.error(message);
  process.exitCode = 1;
}).finally(() => settleAuth());
