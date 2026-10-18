import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

export const configSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.url().default("https://api.supermemory.ai"),
  projectContainerTag: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  isolateWorktrees: z.boolean().default(false),
  recallMode: z.enum(["direct", "advisory", "off"]).default("direct"),
  captureEnabled: z.boolean().default(true),
  injectProfile: z.boolean().default(true),
  maxMemories: z.number().int().min(1).max(20).default(5),
  maxProfileItems: z.number().int().min(1).max(20).default(5),
  similarityThreshold: z.number().min(0).max(1).default(0.55),
  recallTimeoutMs: z.number().int().min(100).max(20000).default(10000),
  requestTimeoutMs: z.number().int().min(100).max(60000).default(30000),
  maxContextChars: z.number().int().min(500).max(20000).default(8000),
  stateDir: z.string().min(1).default(join(homedir(), ".cache", "antigravity-supermemory")),
}).strict();

export type Config = z.infer<typeof configSchema>;

// Above the maximum configured request budgets, leaving time for local I/O.
export const hookTimeoutSeconds = { PreInvocation: 30, Stop: 70 } as const;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SUPERMEMORY_CONFIG ?? join(homedir(), ".config", "antigravity-supermemory", "config.jsonc"));
}

export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid JSON/JSONC configuration");
  return value;
}

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
  if (env.SUPERMEMORY_API_KEY) overrides.apiKey = env.SUPERMEMORY_API_KEY;
  if (env.SUPERMEMORY_API_URL || env.SUPERMEMORY_BASE_URL) {
    overrides.baseUrl = env.SUPERMEMORY_API_URL || env.SUPERMEMORY_BASE_URL;
  }
  if (env.SUPERMEMORY_REPO_TAG) overrides.projectContainerTag = env.SUPERMEMORY_REPO_TAG;
  if (env.SUPERMEMORY_STATE_DIR) overrides.stateDir = env.SUPERMEMORY_STATE_DIR;
  if (env.SUPERMEMORY_ISOLATE_WORKTREES !== undefined) {
    if (!["true", "false"].includes(env.SUPERMEMORY_ISOLATE_WORKTREES)) {
      throw new Error("SUPERMEMORY_ISOLATE_WORKTREES must be true or false");
    }
    overrides.isolateWorktrees = env.SUPERMEMORY_ISOLATE_WORKTREES === "true";
  }
  const parsed = configSchema.safeParse({ ...file, ...overrides });
  if (!parsed.success) {
    throw new Error(`Invalid Supermemory configuration: ${parsed.error.issues.map((i) => i.path.join(".") || "unknown field").join(", ")}`);
  }
  const url = new URL(parsed.data.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return parsed.data;
}
