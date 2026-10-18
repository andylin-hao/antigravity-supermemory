#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig, configPath, hookTimeoutSeconds } from "./config.js";
import { emptyOutput, runHook, type HookEvent } from "./hooks.js";
import { install, uninstall } from "./install.js";
import { MemoryService, InputError } from "./memory.js";
import { safeError } from "./privacy.js";
import { serve } from "./server.js";
import { renderStatusline, upstreamStatusline } from "./statusline.js";

const help = `antigravity-supermemory

  install [--workspace PATH | --global]   Install native hooks, MCP, rule, and skill
  install --legacy --workspace PATH      Install MCP + rule + workflow for older IDEs
  uninstall [same installation flags]    Remove unmodified managed files
  serve [--workspace PATH]               Start the stdio MCP server
  status --workspace PATH               Check configuration and API connectivity
  statusline                            Render agy CLI activity from JSON stdin
  config-path                           Print the global JSONC configuration path
  hook PreInvocation|Stop [--workspace PATH]  Handle Antigravity JSON stdin

Legacy mode accepts --mcp-config PATH (use Antigravity's View raw config path).
Global installs enable the CLI status line; pass --no-statusline to opt out.
Set SUPERMEMORY_API_KEY or apiKey in the config file before use.
`;

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
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: "string" }, global: { type: "boolean" }, legacy: { type: "boolean" },
    "mcp-config": { type: "string" }, help: { type: "boolean", short: "h" },
    "no-statusline": { type: "boolean" }, upstream: { type: "string" },
  } });
  const [command, event] = positionals;
  const workspace = values.workspace ? resolve(values.workspace) : undefined;
  if (values.help || !command) { console.log(help); return; }
  if (command === "statusline") {
    let display = "◪ supermemory · configuration unavailable";
    let previous = "";
    try {
      const input = await stdin();
      previous = await upstreamStatusline(values.upstream, input);
      display = await renderStatusline(await loadConfig(), JSON.parse(input));
    } catch { /* Keep status-line failures out of the interactive terminal. */ }
    console.log([previous, display].filter(Boolean).join("\n"));
    return;
  }
  if (command === "hook") {
    if (event !== "PreInvocation" && event !== "Stop") throw new Error("Unknown hook event");
    const fallback = emptyOutput(event as HookEvent);
    // Always emit valid hook JSON before Antigravity's outer timeout expires.
    const timer = setTimeout(() => {
      console.error("[supermemory] Hook timed out; continuing without memory.");
      process.stdout.write(JSON.stringify(fallback) + "\n", () => process.exit(0));
    }, hookTimeoutSeconds[event] * 1000 - 2000);
    try {
      const input = JSON.parse(await stdin());
      const output = await runHook(event, input, await loadConfig(), workspace);
      console.log(JSON.stringify(output));
    } catch (error) {
      console.error(`[supermemory] ${safeError(error)}`);
      console.log(JSON.stringify(fallback));
    } finally { clearTimeout(timer); }
    return;
  }
  if (command === "install" || command === "uninstall") {
    const path = await (command === "install" ? install : uninstall)({ workspace, global: values.global, legacy: values.legacy, mcpConfig: values["mcp-config"], noStatusline: values["no-statusline"] });
    console.log(`${command === "install" ? "Installed in" : "Removed managed files from"} ${path}`);
    console.log("Reload Antigravity's customizations/MCP servers or restart the application.");
    return;
  }
  if (command === "config-path") { console.log(configPath()); return; }
  if (command === "serve") { await serve(await loadConfig(), workspace); return; }
  if (command === "status") {
    const config = await loadConfig();
    const service = new MemoryService(config, workspace ?? process.cwd());
    const profile = await service.profile();
    console.log(JSON.stringify({ connected: true, namespace: service.identity.tag, workspace: service.identity.root, recallMode: config.recallMode, captureEnabled: config.captureEnabled, profileFacts: profile.profile.static.length + profile.profile.dynamic.length }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  // Config/installer errors are local diagnostics; API response bodies stay hidden.
  const message = error instanceof InputError || (error instanceof Error && !('statusCode' in error) && !error.constructor.name.startsWith("Supermemory"))
    ? error.message : safeError(error);
  console.error(message);
  process.exitCode = 1;
});
