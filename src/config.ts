import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const PLUGIN_VERSION = "0.3.0";
export const BASE_URL = "https://api.supermemory.ai";
export const DEFAULT_MCP_URL = "https://mcp.supermemory.ai/mcp";
export const namespacePattern = /^[a-zA-Z0-9_:-]{1,100}$/;

export const DEFAULT_SIGNAL_KEYWORDS = [
  "remember",
  "implementation",
  "refactor",
  "architecture",
  "decision",
  "important",
  "bug",
  "fix",
  "solved",
  "solution",
  "pattern",
  "approach",
  "design",
  "tradeoff",
  "migrate",
  "upgrade",
  "deprecate",
] as const;

export const configSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.url().default(BASE_URL),
  mcpUrl: z.url().optional(),
  oauthIssuer: z.url().optional(),
  autoLogin: z.boolean().default(true),
  projectContainerTag: z.string().regex(namespacePattern).optional(),
  namespace: z.string().regex(namespacePattern).optional(),
  repoContainerTag: z.string().regex(namespacePattern).optional(),
  isolateWorktrees: z.boolean().default(false),
  recallMode: z.enum(["direct", "advisory", "off"]).default("direct"),
  recallDirective: z.string().trim().min(1).max(4000).optional(),
  captureEnabled: z.boolean().default(true),
  injectProfile: z.boolean().default(true),
  maxMemories: z.number().int().min(1).max(20).default(15),
  maxProfileItems: z.number().int().min(1).max(20).default(5),
  similarityThreshold: z.number().min(0).max(1).default(0.55),
  recallTimeoutMs: z.number().int().min(100).max(20000).default(10000),
  requestTimeoutMs: z.number().int().min(100).max(60000).default(30000),
  maxContextChars: z.number().int().min(500).max(20000).default(8000),
  stateDir: z.string().min(1).default(join(homedir(), ".cache", "antigravity-supermemory")),
  authDir: z.string().min(1).optional(),
  captureSubagents: z.boolean().default(false),
  captureHeadless: z.boolean().default(false),
  captureOrchestrated: z.boolean().default(true),
  dedupeOpeningPrompt: z.boolean().default(true),
  dedupeRecallQueries: z.boolean().default(true),
  signalExtraction: z.boolean().default(false),
  signalKeywords: z.array(z.string().trim().min(1)).default([...DEFAULT_SIGNAL_KEYWORDS]),
  signalTurnsBefore: z.number().int().min(0).max(20).default(3),
  includeTools: z.array(z.string().trim().min(1)).default([]),
  debug: z.boolean().default(false),
}).strict();

export type Config = z.infer<typeof configSchema>;

export const projectConfigSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.url().optional(),
  mcpUrl: z.url().optional(),
  oauthIssuer: z.url().optional(),
  namespace: z.string().regex(namespacePattern).optional(),
  repoContainerTag: z.string().regex(namespacePattern).optional(),
  projectContainerTag: z.string().regex(namespacePattern).optional(),
  recallDirective: z.string().trim().min(1).max(4000).optional(),
  signalExtraction: z.boolean().optional(),
  signalKeywords: z.array(z.string().trim().min(1)).optional(),
  signalTurnsBefore: z.number().int().min(0).max(20).optional(),
  includeTools: z.array(z.string().trim().min(1)).optional(),
}).passthrough();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

// Above the maximum configured request budgets, leaving time for local I/O.
export const hookTimeoutSeconds = { SessionStart: 30, PreInvocation: 30, Stop: 70 } as const;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SUPERMEMORY_CONFIG ?? join(homedir(), ".config", "antigravity-supermemory", "config.jsonc"));
}

export function resolveAuthDir(config?: Pick<Config, "authDir">, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(config?.authDir ?? env.SUPERMEMORY_AUTH_DIR ?? dirname(configPath(env)));
}

export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid JSON/JSONC configuration");
  return value;
}

function parseEnvBoolean(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean flag (true/1/yes/on or false/0/no/off)`);
}

function validateHttpUrl(value: string, label: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
}

export function resolveMcpUrl(baseUrl: string, configuredMcpUrl?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SUPERMEMORY_MCP_URL ?? configuredMcpUrl;
  if (explicit) {
    validateHttpUrl(explicit, "mcpUrl");
    return explicit;
  }
  const api = new URL(baseUrl);
  if (api.origin === BASE_URL && !api.pathname.replace(/\/+$/, "")) return DEFAULT_MCP_URL;
  if (api.hostname.startsWith("api.")) {
    api.hostname = api.hostname.replace(/^api\./, "mcp.");
    api.pathname = "/mcp";
    api.search = "";
    api.hash = "";
    return api.toString();
  }
  return new URL("/mcp", api.origin).toString();
}

const booleanEnvFlags = [
  ["isolateWorktrees", "SUPERMEMORY_ISOLATE_WORKTREES"],
  ["autoLogin", "SUPERMEMORY_AUTO_LOGIN"],
  ["captureSubagents", "SUPERMEMORY_CAPTURE_SUBAGENTS"],
  ["captureHeadless", "SUPERMEMORY_CAPTURE_HEADLESS"],
  ["captureOrchestrated", "SUPERMEMORY_CAPTURE_ORCHESTRATED"],
  ["dedupeOpeningPrompt", "SUPERMEMORY_DEDUPE_OPENING_PROMPT"],
  ["dedupeRecallQueries", "SUPERMEMORY_DEDUPE_RECALL_QUERIES"],
  ["debug", "SUPERMEMORY_DEBUG"],
] as const;

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let file: unknown = {};
  try {
    file = parseJsonc(await readFile(configPath(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("Supermemory configuration must be an object");
  }
  const overrides: Record<string, unknown> = {};
  const envApiKey = env.SUPERMEMORY_ANTIGRAVITY_API_KEY || env.SUPERMEMORY_API_KEY;
  if (envApiKey) overrides.apiKey = envApiKey;
  if (env.SUPERMEMORY_API_URL || env.SUPERMEMORY_BASE_URL) {
    overrides.baseUrl = env.SUPERMEMORY_API_URL || env.SUPERMEMORY_BASE_URL;
  }
  if (env.SUPERMEMORY_MCP_URL) overrides.mcpUrl = env.SUPERMEMORY_MCP_URL;
  if (env.SUPERMEMORY_OAUTH_ISSUER || env.SUPERMEMORY_AUTH_URL) {
    overrides.oauthIssuer = env.SUPERMEMORY_OAUTH_ISSUER || env.SUPERMEMORY_AUTH_URL;
  }
  if (env.SUPERMEMORY_REPO_TAG) overrides.projectContainerTag = env.SUPERMEMORY_REPO_TAG;
  if (env.SUPERMEMORY_STATE_DIR) overrides.stateDir = env.SUPERMEMORY_STATE_DIR;
  if (env.SUPERMEMORY_AUTH_DIR) overrides.authDir = env.SUPERMEMORY_AUTH_DIR;
  for (const [field, envName] of booleanEnvFlags) {
    const parsedFlag = parseEnvBoolean(envName, env[envName]);
    if (parsedFlag !== undefined) overrides[field] = parsedFlag;
  }
  const parsed = configSchema.safeParse({ ...file, ...overrides });
  if (!parsed.success) {
    throw new Error(`Invalid Supermemory configuration: ${parsed.error.issues.map((i) => i.path.join(".") || "unknown field").join(", ")}`);
  }
  validateHttpUrl(parsed.data.baseUrl, "baseUrl");
  if (parsed.data.mcpUrl) validateHttpUrl(parsed.data.mcpUrl, "mcpUrl");
  if (parsed.data.oauthIssuer) validateHttpUrl(parsed.data.oauthIssuer, "oauthIssuer");
  return { ...parsed.data, authDir: resolveAuthDir(parsed.data, env) };
}

function gitRoot(workspace: string): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return top || resolve(workspace);
  } catch {
    return resolve(workspace);
  }
}

function readJsoncOptional(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = parseJsonc(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function loadProjectConfig(workspace: string): ProjectConfig | undefined {
  const base = gitRoot(workspace);
  const own = readJsoncOptional(join(base, ".agents", ".supermemory", "config.json"))
    ?? readJsoncOptional(join(base, ".agents", ".supermemory", "config.jsonc"));
  const claude = readJsoncOptional(join(base, ".claude", ".supermemory-claude", "config.json"));
  if (!own && !claude) return undefined;
  const shared: Record<string, unknown> = {};
  if (typeof claude?.namespace === "string") shared.namespace = claude.namespace;
  if (typeof claude?.repoContainerTag === "string") shared.repoContainerTag = claude.repoContainerTag;
  const merged = { ...shared, ...(own ?? {}) };
  const parsed = projectConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid project Supermemory configuration: ${parsed.error.issues.map((i) => i.path.join(".") || "unknown field").join(", ")}`);
  }
  if (parsed.data.baseUrl) validateHttpUrl(parsed.data.baseUrl, "project baseUrl");
  if (parsed.data.mcpUrl) validateHttpUrl(parsed.data.mcpUrl, "project mcpUrl");
  if (parsed.data.oauthIssuer) validateHttpUrl(parsed.data.oauthIssuer, "project oauthIssuer");
  return parsed.data;
}

export function resolveWorkspaceConfig(config: Config, workspace: string, env: NodeJS.ProcessEnv = process.env): Config {
  const project = loadProjectConfig(workspace);
  if (!project) return config;
  const envApiKey = env.SUPERMEMORY_ANTIGRAVITY_API_KEY || env.SUPERMEMORY_API_KEY;
  const envBaseUrl = env.SUPERMEMORY_API_URL || env.SUPERMEMORY_BASE_URL;
  const pinnedTag = project.namespace
    ?? project.repoContainerTag
    ?? project.projectContainerTag
    ?? env.SUPERMEMORY_REPO_TAG
    ?? config.namespace
    ?? config.repoContainerTag
    ?? config.projectContainerTag;
  return {
    ...config,
    apiKey: envApiKey ?? project.apiKey ?? config.apiKey,
    baseUrl: envBaseUrl ?? project.baseUrl ?? config.baseUrl,
    mcpUrl: env.SUPERMEMORY_MCP_URL ?? project.mcpUrl ?? config.mcpUrl,
    oauthIssuer: (env.SUPERMEMORY_OAUTH_ISSUER || env.SUPERMEMORY_AUTH_URL) ?? project.oauthIssuer ?? config.oauthIssuer,
    projectContainerTag: pinnedTag,
    recallDirective: project.recallDirective ?? config.recallDirective,
    signalExtraction: project.signalExtraction ?? config.signalExtraction,
    signalKeywords: project.signalKeywords ? [...new Set([...config.signalKeywords, ...project.signalKeywords])] : config.signalKeywords,
    signalTurnsBefore: project.signalTurnsBefore ?? config.signalTurnsBefore,
    includeTools: project.includeTools ? [...new Set([...config.includeTools, ...project.includeTools])] : config.includeTools,
  };
}

export async function debugLog(config: Pick<Config, "debug" | "stateDir">, message: string, data?: Record<string, unknown>): Promise<void> {
  if (!config.debug) return;
  const line = `[${new Date().toISOString()}] ${message}${data ? `: ${JSON.stringify(data)}` : ""}\n`;
  try {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await appendFile(join(config.stateDir, "debug.log"), line, { mode: 0o600 });
  } catch { /* Debug logging never interrupts hooks or tools. */ }
}
