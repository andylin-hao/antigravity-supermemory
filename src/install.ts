import { mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";
import { parseJsonc } from "./config.js";
import { hash } from "./identity.js";
import { z } from "zod";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestSchema = z.object({
  owner: z.literal("antigravity-supermemory"),
  files: z.record(z.string(), z.string()),
  mcp: z.object({ path: z.string(), name: z.string(), entry: z.unknown() }).optional(),
  statusLine: z.object({ path: z.string(), original: z.unknown().optional(), installed: z.unknown() }).optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
export interface InstallOptions { workspace?: string; global?: boolean; legacy?: boolean; mcpConfig?: string; home?: string; noStatusline?: boolean }

async function textIfExists(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

function locations(options: InstallOptions) {
  const home = options.home ?? homedir();
  if (options.global && (options.workspace || options.legacy)) throw new Error("--global cannot be combined with --workspace or --legacy");
  const workspace = options.global ? undefined : resolve(options.workspace ?? process.cwd());
  const base = options.global ? join(home, ".gemini", "config") : join(workspace!, options.legacy ? ".agent" : ".agents");
  const plugin = join(base, "plugins", "supermemory");
  const manifest = options.legacy ? join(base, "supermemory-install.json") : join(plugin, ".supermemory-install.json");
  return { home, workspace, base, plugin, manifest };
}

export function shellQuote(value: string, platform = process.platform): string {
  if (platform === "win32") {
    if (/["%\r\n]/.test(value)) throw new Error("Hook command paths cannot contain quotes, percent signs, or newlines on Windows");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function editServer(text: string, name: string, entry: unknown): string {
  const doc = parseJsonc(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("MCP configuration must be an object");
  const servers = (doc as { mcpServers?: unknown }).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error("mcpServers must be an object");
  return applyEdits(text, modify(text, ["mcpServers", name], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

function settingsObject(text: string): Record<string, unknown> {
  const value = parseJsonc(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Antigravity settings must be an object");
  return value as Record<string, unknown>;
}

function editStatusLine(text: string, value: unknown): string {
  settingsObject(text);
  return applyEdits(text, modify(text, ["statusLine"], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

function unchangedStatusLine(text: string, expected: unknown): void {
  if (JSON.stringify(settingsObject(text).statusLine) !== JSON.stringify(expected)) {
    throw new Error("Preserving modified Antigravity statusLine; restore its managed command before updating or uninstalling");
  }
}

export async function install(options: InstallOptions): Promise<string> {
  const loc = locations(options);
  const previous = await textIfExists(loc.manifest);
  const owned = previous ? manifestSchema.parse(JSON.parse(previous)) : undefined;
  const files: Record<string, string> = {};
  const runtime = options.legacy ? join(loc.base, "supermemory-runtime") : join(loc.plugin, "runtime");
  const cli = join(runtime, "runtime.mjs");
  // Install an independent runtime, never a reference into npx's removable cache.
  for (const name of ["runtime.mjs", "runtime.LICENSES.txt"]) {
    files[join(runtime, name)] = await readFile(join(packageRoot, "dist", name), "utf8");
  }
  const workspaceArgs = loc.workspace ? ["--workspace", loc.workspace] : [];
  // Recent Node versions can honor the proxy environment inherited from agy.
  const nodeArgs = process.allowedNodeEnvironmentFlags.has("--use-env-proxy") ? ["--use-env-proxy"] : [];
  const entry = { command: process.execPath, args: [...nodeArgs, cli, "serve", ...workspaceArgs] };
  const command = [process.execPath, ...nodeArgs, cli].map((v) => shellQuote(v)).join(" ");
  const manifest: Manifest = { owner: "antigravity-supermemory", files: {} };
  let shared: { path: string; text: string } | undefined;
  let statusSettings: { path: string; text: string } | undefined;
  if (options.legacy) {
    if (await textIfExists(join(loc.workspace!, ".agents", "plugins", "supermemory", "plugin.json"))) throw new Error("Uninstall the native plugin before installing legacy mode");
    const path = resolve(options.mcpConfig ?? join(loc.home, ".gemini", "antigravity", "mcp_config.json"));
    const name = `supermemory_${hash(loc.workspace!).slice(0, 8)}`;
    const text = await textIfExists(path) ?? "{\n  \"mcpServers\": {}\n}\n";
    const existing = (parseJsonc(text) as { mcpServers?: Record<string, unknown> })?.mcpServers?.[name];
    if (existing && JSON.stringify(existing) !== JSON.stringify(owned?.mcp?.entry) && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`MCP server ${name} already exists with a different configuration`);
    }
    if (owned?.mcp && owned.mcp.path !== path) throw new Error("Uninstall with the original MCP config path before changing it");
    shared = { path, text: editServer(text, name, entry) };
    manifest.mcp = { path, name, entry };
    files[join(loc.base, "rules", "supermemory.md")] = await readFile(join(packageRoot, "plugin", "rules", "supermemory.md"), "utf8");
    const skill = await readFile(join(packageRoot, "plugin", "skills", "supermemory-init", "SKILL.md"), "utf8");
    files[join(loc.base, "workflows", "supermemory-init.md")] = skill.replace(/^---[\s\S]*?---/, "---\ndescription: Index this codebase into persistent Supermemory\n---");
  } else {
    if (loc.workspace && await textIfExists(join(loc.workspace, ".agent", "supermemory-install.json"))) throw new Error("Uninstall legacy mode before installing the native plugin");
    async function collect(source: string, target: string) {
      for (const item of await readdir(source, { withFileTypes: true })) {
        if (item.isDirectory()) await collect(join(source, item.name), join(target, item.name));
        else if (item.isFile()) files[join(target, item.name)] = await readFile(join(source, item.name), "utf8");
      }
    }
    await collect(join(packageRoot, "plugin"), loc.plugin);
    files[join(loc.plugin, "mcp_config.json")] = JSON.stringify({ mcpServers: { supermemory: entry } }, null, 2) + "\n";
    const suffix = workspaceArgs.map((v) => shellQuote(v)).join(" ");
    files[join(loc.plugin, "hooks.json")] = JSON.stringify({ supermemory: {
      PreInvocation: [{ type: "command", command: `${command} hook PreInvocation ${suffix}`.trim(), timeout: 10 }],
      Stop: [{ type: "command", command: `${command} hook Stop ${suffix}`.trim(), timeout: 25 }],
    } }, null, 2) + "\n";
  }
  if (options.global && !options.noStatusline) {
    const path = join(loc.home, ".gemini", "antigravity-cli", "settings.json");
    const text = await textIfExists(path) ?? "{}\n";
    if (owned?.statusLine) unchangedStatusLine(text, owned.statusLine.installed);
    const original = owned?.statusLine ? owned.statusLine.original : settingsObject(text).statusLine;
    if (original !== undefined && (!original || typeof original !== "object" || Array.isArray(original))) {
      throw new Error("Preserving unsupported statusLine configuration; use --no-statusline");
    }
    const settings = original as Record<string, unknown> | undefined;
    let suffix = "";
    if (typeof settings?.command === "string" && settings.command.trim()) {
      const upstream = join(runtime, "statusline-upstream.json");
      files[upstream] = JSON.stringify({ command: settings.command }) + "\n";
      suffix = ` --upstream ${shellQuote(upstream)}`;
    }
    const installed = { ...settings, type: "command", command: `${command} statusline${suffix}`, enabled: true, stack_with_default: settings?.stack_with_default ?? true };
    statusSettings = { path, text: editStatusLine(text, installed) };
    manifest.statusLine = { path, original, installed };
  } else if (owned?.statusLine) {
    const text = await textIfExists(owned.statusLine.path) ?? "{}\n";
    unchangedStatusLine(text, owned.statusLine.installed);
    statusSettings = { path: owned.statusLine.path, text: editStatusLine(text, owned.statusLine.original) };
  }
  // Preflight all owned files before changing any configuration.
  for (const [path, text] of Object.entries(files)) {
    const existing = await textIfExists(path);
    if (existing !== undefined && existing !== text && hash(existing) !== owned?.files[path]) {
      throw new Error(`Preserving modified or unowned file: ${path}`);
    }
    manifest.files[path] = hash(text);
  }
  const obsolete = Object.entries(owned?.files ?? {}).filter(([path]) => !(path in files));
  for (const [path, expected] of obsolete) {
    const current = await textIfExists(path);
    if (current !== undefined && hash(current) !== expected) throw new Error(`Preserving modified file: ${path}`);
  }
  for (const [path, text] of Object.entries(files)) await atomicWrite(path, text);
  if (shared) await atomicWrite(shared.path, shared.text);
  if (statusSettings) await atomicWrite(statusSettings.path, statusSettings.text);
  for (const [path] of obsolete) await rm(path, { force: true });
  await atomicWrite(loc.manifest, JSON.stringify(manifest, null, 2) + "\n");
  return options.legacy ? loc.base : loc.plugin;
}

export async function uninstall(options: InstallOptions): Promise<string> {
  const loc = locations(options);
  const text = await textIfExists(loc.manifest);
  if (!text) throw new Error("No managed installation found at this location");
  const manifest = manifestSchema.parse(JSON.parse(text));
  for (const [path, expected] of Object.entries(manifest.files)) {
    const current = await textIfExists(path);
    if (current !== undefined && hash(current) !== expected) throw new Error(`Preserving modified file: ${path}`);
  }
  let statusSettings: { path: string; text: string } | undefined;
  if (manifest.statusLine) {
    const { path, installed, original } = manifest.statusLine;
    const text = await textIfExists(path) ?? "{}\n";
    unchangedStatusLine(text, installed);
    statusSettings = { path, text: editStatusLine(text, original) };
  }
  if (manifest.mcp) {
    const { path, name, entry } = manifest.mcp;
    const current = await textIfExists(path);
    if (current) {
      const existing = (parseJsonc(current) as { mcpServers?: Record<string, unknown> })?.mcpServers?.[name];
      if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`Preserving modified MCP server: ${name}`);
      if (existing) await atomicWrite(path, editServer(current, name, undefined));
    }
  }
  if (statusSettings) await atomicWrite(statusSettings.path, statusSettings.text);
  for (const path of Object.keys(manifest.files)) await rm(path, { force: true });
  await rm(loc.manifest);
  return loc.base;
}
