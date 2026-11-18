import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "./config.js";
import { hash } from "./identity.js";

const PRINT_FLAGS = new Set(["-p", "--print", "--prompt"]);
const INTERACTIVE_FLAGS = new Set(["-i", "--prompt-interactive"]);
const VALUE_FLAGS = new Set([
  "--add-dir",
  "--agent",
  "--conversation",
  "--effort",
  "--input-format",
  "--json-schema",
  "--log-file",
  "--mode",
  "--model",
  "--output-format",
  "--print-timeout",
  "--project",
  "--settings",
]);

const ORCHESTRATOR_ENV = [
  "CONDUCTOR_WORKSPACE_PATH",
  "CONDUCTOR_SESSION_ID",
  "VK_WORKSPACE_ID",
];

export const TASK_NOTIFICATION_PREFIX = "<task-notification>";

export type ProcessInspector = (pid: number) => { ppid: number; argv: string[] };

export interface SessionScopeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  inspect?: ProcessInspector;
}

export function isOrchestrated(env: NodeJS.ProcessEnv = process.env): boolean {
  return ORCHESTRATOR_ENV.some((name) => Boolean(env[name]?.trim()));
}

export function isPrintArgv(args: string[]): boolean {
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    if (!name.startsWith("-") || name === "--") break;
    if (INTERACTIVE_FLAGS.has(name)) return false;
    if (PRINT_FLAGS.has(name)) {
      print = separator < 0 || token.slice(separator + 1) !== "false";
    }
    if (VALUE_FLAGS.has(name) && separator < 0) i++;
  }
  return print;
}

function defaultProcessInspector(pid: number, platform = process.platform): { ppid: number; argv: string[] } {
  if (platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { ppid, argv };
  }
  const tokens = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim().split(/\s+/);
  const [ppid, ...argv] = tokens;
  return { ppid: Number(ppid), argv };
}

export function findAgyAncestor(inspect: ProcessInspector, startPid = process.ppid): { pid: number; argv: string[] } | null | undefined {
  try {
    let pid = startPid;
    for (let depth = 0; depth < 4 && pid > 1; depth++) {
      const { ppid, argv } = inspect(pid);
      if (/^agy(\.exe)?$/i.test(basename(argv[0] ?? ""))) {
        return { pid, argv };
      }
      pid = ppid;
    }
    return null;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isHeadlessSession(conversationId: string, stateDir: string, options: SessionScopeOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return false;
  const cacheDir = join(stateDir, "headless");
  const cacheFile = join(cacheDir, `${hash(conversationId)}.json`);
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { headless?: unknown; pid?: unknown };
    if (typeof cached.headless === "boolean" && (cached.pid === null || (typeof cached.pid === "number" && isProcessAlive(cached.pid)))) {
      return cached.headless;
    }
  } catch { /* Re-probe when cache is absent or stale. */ }
  const inspect = options.inspect ?? ((pid) => defaultProcessInspector(pid, platform));
  const agy = findAgyAncestor(inspect);
  if (agy === undefined) return false;
  const headless = Boolean(agy && isPrintArgv(agy.argv.slice(1)));
  const temp = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ pid: agy ? agy.pid : null, headless }), { mode: 0o600, flag: "wx" });
    renameSync(temp, cacheFile);
  } catch { /* Cache writes are best-effort. */ }
  finally {
    rmSync(temp, { force: true });
  }
  return headless;
}

function hasExplicitUserInput(transcriptPath?: string): boolean {
  if (!transcriptPath) return false;
  const expanded = transcriptPath.startsWith("~/") ? join(homedir(), transcriptPath.slice(2)) : transcriptPath;
  let fd: number | undefined;
  try {
    fd = openSync(expanded, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8", 0, bytesRead);
    return head.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false;
      if (line.includes('"USER_INPUT"') && line.includes('"USER_EXPLICIT"')) return true;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const nested = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : {};
        if (row.synthetic || row.isSynthetic || nested.synthetic || nested.isSynthetic) return false;
        const source = String(row.source ?? "");
        if (/SYSTEM|HOOK|TOOL|SYNTHETIC/.test(source)) return false;
        return row.role === "user" || nested.role === "user" || row.type === "USER_INPUT";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Ignore close errors. */ }
    }
  }
}

export interface SubagentProbeInput {
  conversationId: string;
  parentConversationId?: string;
  lastUserInput?: string;
  transcriptPath?: string;
}

export function isSubagentInput(input: SubagentProbeInput): boolean {
  if (typeof input.parentConversationId === "string" && input.parentConversationId.trim()) {
    return true;
  }
  if (typeof input.lastUserInput === "string") {
    const trimmed = input.lastUserInput.trimStart();
    if (trimmed.startsWith(TASK_NOTIFICATION_PREFIX)) return true;
    if (!trimmed && !hasExplicitUserInput(input.transcriptPath)) return true;
  }
  return false;
}

export function getSessionSkipReason(
  input: SubagentProbeInput,
  config: Pick<Config, "captureOrchestrated" | "captureSubagents" | "captureHeadless" | "stateDir">,
  options: SessionScopeOptions = {},
): "orchestrated" | "subagent" | "headless" | undefined {
  const env = options.env ?? process.env;
  const orchestrated = isOrchestrated(env);
  if (orchestrated && !config.captureOrchestrated) return "orchestrated";
  if (!config.captureSubagents && isSubagentInput(input)) return "subagent";
  if (!orchestrated && !config.captureHeadless && isHeadlessSession(input.conversationId, config.stateDir, options)) {
    return "headless";
  }
  return undefined;
}
