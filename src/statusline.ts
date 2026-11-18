import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readActivity, recallNotice, type Activity, type ActivityKind } from "./activity.js";
import { resolveConfiguredIdentity } from "./auth.js";
import type { Config } from "./config.js";

function describe(kind: ActivityKind, activity: Activity, config: Config, now: number): string {
  const budget = kind === "recall" ? config.recallTimeoutMs : config.requestTimeoutMs;
  const reason = activity.reason && activity.reason !== "unknown" ? activity.reason : undefined;
  if (activity.phase === "running") {
    return now - activity.at > budget + 5000
      ? `${kind === "recall" ? "recall" : "save"} interrupted`
      : kind === "recall" ? "recalling…" : "saving…";
  }
  if (kind === "recall") {
    if (activity.phase === "skipped") return config.recallMode === "advisory" || config.recallDirective ? "advisory recall" : "recall skipped (no query)";
    if (activity.phase === "failed") return `recall unavailable${reason ? ` (${reason})` : ""}`;
    return `${recallNotice(activity.count).replace(/^supermemory /, "")}${activity.phase === "partial" ? ` (partial${reason ? `: ${reason}` : ""})` : ""}`;
  }
  if (activity.phase === "failed") return `save unavailable${reason ? ` (${reason})` : ""}${activity.count ? ` (${activity.count} queued)` : ""}`;
  return `saved ${activity.count} ${activity.count === 1 ? "document" : "documents"} (queued)`;
}

export async function renderStatusline(config: Config, payload: unknown, now = Date.now(), env?: NodeJS.ProcessEnv): Promise<string> {
  const identity = resolveConfiguredIdentity(config, env);
  if (identity.loggedOut) return "◪ supermemory · signed out (run /supermemory-login)";
  if (!identity.key) return "◪ supermemory · API key not configured (or run /supermemory-login)";
  const input = payload && typeof payload === "object" ? payload as { conversation_id?: unknown; session_id?: unknown } : {};
  const id = input.conversation_id ?? input.session_id;
  const [recall, capture] = typeof id === "string" && id
    ? await Promise.all([readActivity(config, id, "recall", identity.key), readActivity(config, id, "capture", identity.key)])
    : [undefined, undefined];
  const parts: string[] = [];
  if (config.recallMode === "off") parts.push("recall off");
  else if (recall) parts.push(describe("recall", recall, config, now));
  else parts.push(config.recallMode === "advisory" || config.recallDirective ? "advisory recall" : "ready — waiting for recall");
  if (!config.captureEnabled) parts.push("capture off");
  else if (capture) parts.push(describe("capture", capture, config, now));
  return `◪ supermemory · ${parts.join(" · ")}`;
}

export async function upstreamStatusline(path: string | undefined, input: string): Promise<string> {
  if (!path) return "";
  try {
    const settings = JSON.parse(await readFile(path, "utf8")) as { command?: unknown };
    if (typeof settings.command !== "string" || !settings.command.trim()) return "";
    return await new Promise<string>((done) => {
      const child = exec(settings.command as string, { timeout: 1500, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
        done(error ? "" : stdout.trimEnd());
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  } catch {
    return "";
  }
}
